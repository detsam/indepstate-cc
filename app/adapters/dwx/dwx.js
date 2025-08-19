// adapters/dwx/dwx.js
const { ExecutionAdapter } = require('../base');
const { dwx_client } = require('./dwx_client');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class DWXAdapter extends ExecutionAdapter {
  /**
   * cfg: {
   *   provider?: 'dwx-mt5',
   *   metatraderDirPath: string,
   *   verbose?: boolean,
   *   event_handler?: { ... }    // ваши внешние колбэки (необязательно)
   * }
   */
  constructor(cfg) {
    super();
    if (!cfg?.metatraderDirPath) throw new Error('[DWXAdapter] metatraderDirPath is required');

    this.cfg = {
      openOrderRetryDelayMs: cfg?.openOrderRetryDelayMs ?? 500,
    };

    this.provider = cfg.provider || 'dwx-mt5';
    this.verbose = !!cfg.verbose;

    // Внутренний эмиттер для подтверждений
    this.events = new EventEmitter();

    // Оборачиваем внешний handler, чтобы ловить события и мы, и вы
    const userHandler = cfg.event_handler || {};
    const self = this;

    const internalHandler = {
      on_order_event() {
        // Снимем подтверждения по DWX_Orders.txt
        self.#reconcilePendingWithOpenOrders();
        // Пробросим наружу
        userHandler.on_order_event?.();
      },
      on_message(msg) {
        // Попробуем вытащить cid из message/comment и подтвердить/завернуть
        self.#consumeMessage(msg);
        userHandler.on_message?.(msg);
      },
      on_tick: (...a) => userHandler.on_tick?.(...a),
      on_bar_data: (...a) => userHandler.on_bar_data?.(...a),
      on_historic_data: (...a) => userHandler.on_historic_data?.(...a),
      on_historic_trades() {
        // при появлении новых исторических сделок проверим закрытие позиций
        self.#reconcilePendingWithOpenOrders();
        userHandler.on_historic_trades?.();
      },
    };

    this.client = new dwx_client({
      metatrader_dir_path: cfg.metatraderDirPath,
      verbose: this.verbose,
      event_handler: internalHandler,
    });

    // Python-логика: при наличии handler надо дернуть start()
    this.client.start();

    // pending: cid -> { order, order_type, createdAt, cycles }
    this.pending = new Map();
    // для дельты открытых ордеров
    this._lastTickets = new Set();
    // мета-информация по тикетам: open_time, profit и т.п.
    this._ticketMeta = new Map();
    // symbols we have subscribed to for market data
    this._subscribedSymbols = new Set();
  }

  /**
   * Подписка на внутренние события адаптера (подтверждения для UI)
   * - 'order:confirmed' ({pendingId, ticket, mtOrder, origOrder})
   * - 'order:rejected'  ({pendingId, reason, msg, origOrder})
   */
  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  /**
   * normalized order -> отправка в DWX, возвращаем enqueued + pendingId
   */
  async placeOrder(order) {
    const reason = validate(order);
    if (reason) return { status: 'rejected', provider: this.provider, reason, raw: { order } };

    // делаем cid и (если нет) проставляем его в comment, чтобы потом надёжно матчинговалось
    const cid = randomId();
    const comment = appendCidToComment(order.comment, cid);
    order.commentWithCid = comment;

    // маппинг типа
    let order_type = order.side;
    if (order.type === 'limit') order_type = order.side === 'buy' ? 'buylimit' : 'selllimit';
    else if (order.type === 'stop') order_type = order.side === 'buy' ? 'buystop' : 'sellstop';

    // начнём отслеживать pending до отправки, чтобы не пропустить ранние сообщения
    this.#trackPending(cid, order, order_type);
    this.#sendOrder(order, order_type).catch((e) => {
      this.#rejectPending(cid, e?.message || String(e), e?.message || String(e));
    });

    return {
      status: 'ok',
      provider: this.provider,
      providerOrderId: `pending:${cid}`,
      raw: { enqueued: true, cid },
    };

  }

  /** ---------- внутреннее ---------- */
  async #sendOrder(order, order_type) {
    let sl = 0.0;
    let tp = 0.0;

    if (order.side === 'buy') {
      tp = order.price + (order.tp * order.mintick);
      sl = order.price - (order.sl * order.mintick);
    } else {
      tp = order.price - (order.tp * order.mintick);
      sl = order.price + (order.sl * order.mintick);
    }

    await this.client.open_order(
      order.symbol,
      order_type,
      order.qty,
      order.price ?? 0,
      sl,
      tp,
      order.magic ?? 0,
      order.commentWithCid ?? order.comment ?? '',
      order.expiration ?? 0
    );
  }

  stopOpenOrder(cid) {
    this.#cancelPending(cid);
  }

  #cancelPending(cid) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
  }

  #trackPending(cid, order, order_type) {
    this.pending.set(cid, { order, order_type, createdAt: Date.now(), cycles: 0 });
  }

  async #retryOrder(cid) {
    const p = this.pending.get(cid);
    if (!p) return;
    await new Promise(r => setTimeout(r, this.cfg.openOrderRetryDelayMs));
    try {
      p.cycles++;
      this.events.emit('order:retry', { pendingId: cid, count: p.cycles });
      await this.#sendOrder(p.order, p.order_type);
    } catch (e) {
      this.#rejectPending(cid, e?.message || String(e));
    }
  }

  #confirmPending(cid, ticket, mtOrder) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
    this.events.emit('order:confirmed', { pendingId: cid, ticket: String(ticket ?? ''), mtOrder, origOrder: p.order });
  }

  #rejectPending(cid, reason, msg) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
    this.events.emit('order:rejected', { pendingId: cid, reason: reason || 'Unknown', msg, origOrder: p.order });
  }

  #consumeMessage(msg) {
    // Форматы на MQL стороне бывают разные. Ищем cid в явном поле или в comment/строке.
    const asStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const cid = extractCid(asStr);
    if (cid && this.pending.has(cid)) {
      // Ошибка OPEN_ORDER → ретрай; INFO/OK → попробуем вытащить ticket и подтвердить.
      const isError = msg?.type === 'ERROR' && msg?.error_type === 'OPEN_ORDER';
      if (isError) {
        this.#retryOrder(cid);
      } else {
        const ticket = msg?.ticket ?? (asStr.match(/ticket\\D+(\\d+)/i)?.[1]);
        this.#confirmPending(cid, ticket, undefined);
      }
    }
  }

  #reconcilePendingWithOpenOrders() {
    const nowTickets = new Set(Object.keys(this.client.open_orders || {}));
    const newTickets = [...nowTickets].filter(t => !this._lastTickets.has(t));
    const removedTickets = [...this._lastTickets].filter(t => !nowTickets.has(t));

    // обновляем информацию по текущим ордерам
    for (const t of nowTickets) {
      const ord = this.client.open_orders[t];
      if (!ord) continue;
      let meta = this._ticketMeta.get(t);
      if (!meta) {
        meta = {
          initialOpenTime: ord.open_time,
          lastOpenTime: ord.open_time,
          profit: ord.pnl,
          opened: false,
        };
        this._ticketMeta.set(t, meta);
      } else {
        if (!meta.opened && ord.open_time !== meta.initialOpenTime) {
          meta.opened = true;
          this.events.emit('position:opened', { ticket: t, order: ord });
        }
        meta.lastOpenTime = ord.open_time;
        meta.profit = ord.pnl;
      }
    }

    if (newTickets.length) {
      for (const t of newTickets) {
        const ord = this.client.open_orders[t];
        if (!ord) continue;
        const cid = extractCid(ord.comment || '');
        if (cid && this.pending.has(cid)) {
          this.#confirmPending(cid, t, ord);
        } else {
          const hitCid = findHeuristicMatchCid(this.pending, ord);
          if (hitCid) this.#confirmPending(hitCid, t, ord);
        }
      }
    }

    if (removedTickets.length) {
      for (const t of removedTickets) {
        const meta = this._ticketMeta.get(t) || {};
        const profit = meta.profit;
        this._ticketMeta.delete(t);
        if (typeof profit === 'number' && profit !== 0) {
          this.events.emit('position:closed', { ticket: t, trade: { profit } });
        } else {
          this.events.emit('order:cancelled', { ticket: t });
        }
      }
    }

    this._lastTickets = nowTickets;
  }

  async getQuote(symbol) {
    symbol = String(symbol || '').trim();
    if (!symbol) return null;
    if (!this._subscribedSymbols.has(symbol)) {
      this._subscribedSymbols.add(symbol);
      try { await this.client.subscribe_symbols([...this._subscribedSymbols]); } catch {}
    }
    const md = this.client.market_data?.[symbol];
    if (!md) return null;
    const bid = Number(md.bid);
    const ask = Number(md.ask);
    let price;
    if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
    else if (Number.isFinite(bid)) price = bid;
    else if (Number.isFinite(ask)) price = ask;
    return { bid, ask, price };
  }

  async forgetQuote(symbol) {
    symbol = String(symbol || '').trim();
    if (!symbol) return;
    if (this._subscribedSymbols.delete(symbol)) {
      try { await this.client.subscribe_symbols([...this._subscribedSymbols]); } catch {}
    }
  }

  async listOpenOrders() {
    return Object.values(this.client.open_orders || {});
  }

  async listClosedPositions() {
    return Object.values(this.client.historic_trades || {});
  }
}

/** ---------- helpers ---------- */

function validate(o = {}) {
  if (!o.symbol) return 'symbol is required';
  if (!['buy', 'sell'].includes(o.side)) return 'side must be buy|sell';
  if (!['market', 'limit', 'stop'].includes(o.type)) return 'type must be market|limit|stop';
  if ((o.type === 'limit' || o.type === 'stop') && typeof o.price !== 'number') return 'price is required for limit/stop';
  if (typeof o.qty !== 'number' || o.qty <= 0) return 'volume must be > 0';
  return null;
}

function randomId() { return crypto.randomBytes(6).toString('hex'); }

function appendCidToComment(comment, cid) {
  const c = (comment || '').trim();
  return c.includes('cid:') ? c : (c ? `${c} | cid:${cid}` : `cid:${cid}`);
}

function extractCid(s) {
  const m = String(s).match(/cid[:=]\s*([a-f0-9]{8,})/i);
  return m ? m[1] : null;
}

function findHeuristicMatchCid(pendingMap, mtOrder) {
  // Подбираем pending, который максимально похож
  const entries = [...pendingMap.entries()];
  const score = (p, o) => {
    let s = 0;
    if (p.order.symbol === o.symbol) s += 3;
    if (p.order.volume && roughlyEqual(p.order.volume, o.lots, 1e-4)) s += 2;
    if (p.order.side && sideMatches(p.order.side, o.type)) s += 2;
    if (p.order.price && roughlyEqual(p.order.price, o.open_price, 1e-4)) s += 1;
    if (p.order.sl && roughlyEqual(p.order.sl, o.sl, 1e-4)) s += 0.5;
    if (p.order.tp && roughlyEqual(p.order.tp, o.tp, 1e-4)) s += 0.5;
    return s;
  };
  let best = null;
  for (const [cid, p] of entries) {
    const sc = score(p, mtOrder);
    if (best === null || sc > best.sc) best = { cid, sc };
  }
  return best && best.sc >= 5 ? best.cid : null; // порог
}

function sideMatches(side, mtType) {
  const t = String(mtType).toLowerCase();
  if (side === 'buy') return t.includes('buy');
  if (side === 'sell') return t.includes('sell');
  return false;
}

function roughlyEqual(a, b, eps) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= (eps ?? 1e-6);
}

module.exports = { DWXAdapter };

// adapters/dwx.js
const { ExecutionAdapter } = require('./base');
const { dwx_client } = require('./dwx_client');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class DWXAdapter extends ExecutionAdapter {
  /**
   * cfg: {
   *   provider?: 'dwx-mt5',
   *   metatrader_dir_path: string,
   *   verbose?: boolean,
   *   confirmTimeoutMs?: number, // время ожидания подтверждения
   *   event_handler?: { ... }    // ваши внешние колбэки (необязательно)
   * }
   */
  constructor(cfg) {
    super();
    if (!cfg?.metatrader_dir_path) throw new Error('[DWXAdapter] metatrader_dir_path is required');

    this.provider = cfg.provider || 'dwx-mt5';
    this.confirmTimeoutMs = cfg.confirmTimeoutMs ?? 7000;
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
      on_historic_trades: (...a) => userHandler.on_historic_trades?.(...a),
    };

    this.client = new dwx_client({
      metatrader_dir_path: cfg.metatrader_dir_path,
      verbose: this.verbose,
      event_handler: internalHandler,
    });

    // Python-логика: при наличии handler надо дернуть start()
    this.client.start();

    // pending: cid -> { order, timer, createdAt }
    this.pending = new Map();
    // для дельты открытых ордеров
    this._lastTickets = new Set();
  }

  /**
   * Подписка на внутренние события адаптера (подтверждения для UI)
   * - 'order:confirmed' ({pendingId, ticket, mtOrder, origOrder})
   * - 'order:rejected'  ({pendingId, reason, msg, origOrder})
   * - 'order:timeout'   ({pendingId, origOrder})
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

    // маппинг типа
    let order_type = order.side;
    if (order.type === 'limit') order_type = order.side === 'buy' ? 'buylimit' : 'selllimit';
    else if (order.type === 'stop') order_type = order.side === 'buy' ? 'buystop' : 'sellstop';

    // положим в pending
    this.#trackPending(cid, order);

    let sl = 0.0;
    let tp = 0.0;

    if (order.side === 'buy') {
      tp = order.price + (order.tp / 100)
      sl = order.price - (order.sl / 100)
    } else {
      tp = order.price - (order.tp / 100)
      sl = order.price + (order.sl / 100)
    }

    try {
      await this.client.open_order(
        order.symbol,
        order_type,
        order.qty,
        order.price ?? 0,
        sl ?? 0,
        tp ?? 0,
        order.magic ?? 0,
        comment,
        order.expiration ?? 0
      );

      return {
        status: 'ok',
        provider: this.provider,
        providerOrderId: `pending:${cid}`, // UI может ключеваться по этому id
        raw: { enqueued: true, cid },
      };
    } catch (e) {
      this.#rejectPending(cid, e?.message || String(e));
      return { status: 'rejected', provider: this.provider, reason: e?.message || String(e) };
    }
  }

  /** ---------- внутреннее ---------- */

  #trackPending(cid, order) {
    // таймер таймаута
    const timer = setTimeout(() => {
      if (!this.pending.has(cid)) return;
      const p = this.pending.get(cid);
      this.pending.delete(cid);
      this.events.emit('order:timeout', { pendingId: cid, origOrder: p.order });
    }, this.confirmTimeoutMs);

    this.pending.set(cid, { order, createdAt: Date.now(), timer });
  }

  #confirmPending(cid, ticket, mtOrder) {
    const p = this.pending.get(cid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(cid);
    this.events.emit('order:confirmed', { pendingId: cid, ticket: String(ticket ?? ''), mtOrder, origOrder: p.order });
  }

  #rejectPending(cid, reason, msg) {
    const p = this.pending.get(cid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(cid);
    this.events.emit('order:rejected', { pendingId: cid, reason: reason || 'Unknown', msg, origOrder: p.order });
  }

  #consumeMessage(msg) {
    // Форматы на MQL стороне бывают разные. Ищем cid в явном поле или в comment/строке.
    const asStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const cid = extractCid(asStr);
    if (cid && this.pending.has(cid)) {
      // Если это ERROR — зареджектим; если INFO/OK — попытаемся вытащить ticket и подтвердить.
      const isError = (msg?.type === 'ERROR') || /error|failed/i.test(asStr);
      if (isError) {
        this.#rejectPending(cid, msg?.reason || 'EA ERROR', msg);
      } else {
        const ticket = msg?.ticket ?? (asStr.match(/ticket\\D+(\\d+)/i)?.[1]);
        this.#confirmPending(cid, ticket, undefined);
      }
    }
  }

  #reconcilePendingWithOpenOrders() {
    // найдём новые тикеты
    const nowTickets = new Set(Object.keys(this.client.open_orders || {}));
    const newTickets = [...nowTickets].filter(t => !this._lastTickets.has(t));

    if (newTickets.length) {
      for (const t of newTickets) {
        const ord = this.client.open_orders[t];
        if (!ord) continue;
        // попытаемся найти cid в comment
        const cid = extractCid(ord.comment || '');
        if (cid && this.pending.has(cid)) {
          this.#confirmPending(cid, t, ord);
        } else {
          // fallback: хэпуристический матч по символу/объёму/направлению/цене
          const hitCid = findHeuristicMatchCid(this.pending, ord);
          if (hitCid) this.#confirmPending(hitCid, t, ord);
        }
      }
    }

    this._lastTickets = nowTickets;
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
  const m = String(s).match(/cid[:=]\\s*([a-f0-9]{8,})/i);
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

// app/adapters/ccxt.js
const { ExecutionAdapter } = require('./base');
const ccxt = require('ccxt');
const crypto = require('crypto');

class CCXTExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.exchangeId - ідентифікатор біржі з ccxt, наприклад 'binance', 'bybit', 'okx'
   * @param {string} [cfg.apiKey]
   * @param {string} [cfg.secret]
   * @param {string} [cfg.password] - для деяких бірж
   * @param {string} [cfg.uid] - для деяких бірж
   * @param {boolean} [cfg.sandbox=false] - режим пісочниці, якщо підтримується
   * @param {boolean} [cfg.enableRateLimit=true]
   * @param {Object} [cfg.options] - додаткові опції ccxt
   * @param {Object} [cfg.params] - дефолтні params для запитів
   * @param {Object<string,string>} [cfg.symbolMap] - мапінг локальних символів до формату ccxt (наприклад {'BTCUSDT':'BTC/USDT'})
   */
  constructor(cfg = {}) {
    super();
    if (!cfg.exchangeId || !ccxt[cfg.exchangeId]) {
      throw new Error(`CCXT: unknown or missing exchangeId: ${cfg.exchangeId || '(empty)'}`);
    }
    this.exchangeId = cfg.exchangeId;
    this.provider = `ccxt:${this.exchangeId}`;
    this.symbolMap = cfg.symbolMap || {};
    const ExchangeClass = ccxt[this.exchangeId];

    this.exchange = new ExchangeClass({
      apiKey: cfg.apiKey,
      secret: cfg.secret,
      password: cfg.password,
      uid: cfg.uid,
      enableRateLimit: cfg.enableRateLimit !== false,
      options: cfg.options || {},
    });

    if (cfg.sandbox && typeof this.exchange.setSandboxMode === 'function') {
      this.exchange.setSandboxMode(true);
    }

    this.defaultParams = cfg.params || {};
    // Автопобудова мапи символів з біржі (можна вимкнути через cfg.autoBuildSymbolMap=false)
    this.autoBuildSymbolMap = cfg.autoBuildSymbolMap !== false;
    this._marketsLoaded = false;
    this._readyPromise = null;

    // Зв'язки батьківського ордера з дочірніми (SL/TP) та вотчери для скасування
    this._childOrdersByParent = new Map(); // parentId -> { symbol, children: string[] }
    this._parentWatchers = new Map(); // parentId -> NodeJS.Timer

    // Pending та події підтвердження/відхилення (для UI)
    this.events = new (require('events').EventEmitter)();
    this.pending = new Map(); // cid -> { order, createdAt }
  }

  async ensureReady() {
    if (this._marketsLoaded) return;
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        try {
          const markets = await this.exchange.loadMarkets();
          if (this.autoBuildSymbolMap) this._buildSymbolMapFromMarkets(markets);
        } finally {
          this._marketsLoaded = true;
        }
      })();
    }
    return this._readyPromise;
  }

  _buildSymbolMapFromMarkets(markets) {
    try {
      const list = Array.isArray(markets) ? markets : Object.values(markets || {});
      for (const m of list) {
        if (!m) continue;
        const ccxtSymbol = m.symbol || '';
        const base = String(m.base || '').toUpperCase();
        const quote = String(m.quote || '').toUpperCase();
        const id = String(m.id || '');
        const idKey = id.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

        const add = (k) => {
          if (!k) return;
          if (!this.symbolMap[k]) this.symbolMap[k] = ccxtSymbol;
          const up = k.toUpperCase();
          if (!this.symbolMap[up]) this.symbolMap[up] = ccxtSymbol;
        };

        // Канонічний ключ, наприклад BTCUSDT
        if (base && quote) {
          const k = (base + quote).toUpperCase();
          add(k);
          // Поширені аліаси для ф'ючерсів/свопів
          if (m.contract || m.swap || m.future) {
            add(`${k}.P`);
            add(`${k}-PERP`);
            add(`${k}_PERP`);
          }
        }
        // Додаємо нормалізований id
        if (idKey) add(idKey);
      }
    } catch {}
  }

  mapSymbol(symbol) {
    if (!symbol) return symbol;
    return this.symbolMap[symbol] || this.symbolMap[String(symbol).toUpperCase()] || symbol;
  }

  // Витягнути найбільш надійний ідентифікатор ордера з відповіді біржі
  _resolveOrderId(res) {
    try {
      const info = res?.info || {};
      const id = res?.id || res?.clientOrderId || info?.orderId || info?.origClientOrderId || info?.clientOrderId || info?.data?.orderId;
      return id ? String(id) : '';
    } catch {
      return '';
    }
  }

  // Підписка на внутрішні події адаптера (сумісно з wireAdapter)
  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  // Зупинка очікування відкриття основного ордера (до моменту підтвердження)
  stopOpenOrder(cid) {
    const rec = this.pending.get(cid);
    if (!rec) return;
    this.pending.delete(cid);
    // Емітимо відмову, щоб UI зняв "pending"
    this.events.emit('order:rejected', {
      pendingId: cid,
      reason: 'RETRY_STOPPED',
      origOrder: rec.order
    });
  }

  /**
   * Створення reduce-only SL/TP захисних ордерів.
   * - SL: stop-market з тригером stopPrice (reduceOnly)
   * - TP: limit ордер на протилежну сторону за tpPrice (reduceOnly)
   * Повертає масив id дочірніх ордерів (може бути порожнім/частковим).
   */
  async _placeProtectiveOrders({ mappedSymbol, side, amount, entryPrice, slPts, tpPts, mintick, baseParams = {} }) {
    const childIds = [];
    const opposite = side === 'buy' ? 'sell' : 'buy';
    const tick = Number(mintick) > 0 ? Number(mintick) : 1;

    const reduceParams = { ...baseParams };
    // популярний ключ у ccxt
    reduceParams.reduceOnly = true;
    // інколи біржі сприймають альтернативний snake_case
    reduceParams.reduce_only = true;
    // Дефолт для багатьох бірж (зокрема Binance Futures)
    if (!reduceParams.timeInForce) reduceParams.timeInForce = 'GTC';

    // Розрахунок рівнів
    const hasSL = Number.isFinite(slPts) && Number(slPts) > 0 && Number.isFinite(entryPrice);
    const hasTP = Number.isFinite(tpPts) && Number(tpPts) > 0 && Number.isFinite(entryPrice);

    const slPrice = hasSL
      ? (side === 'buy' ? (entryPrice - Number(slPts) * tick) : (entryPrice + Number(slPts) * tick))
      : undefined;

    const tpPrice = hasTP
      ? (side === 'buy' ? (entryPrice + Number(tpPts) * tick) : (entryPrice - Number(tpPts) * tick))
      : undefined;

    // SL: stop-limit (для сумісності з біржами, які вимагають price у 'stop', напр. Binance)
    if (hasSL && Number.isFinite(slPrice) && slPrice > 0) {
      const slParams = { ...reduceParams, stopPrice: slPrice };
      try {
        // Для ccxt/binance 'stop' потребує і price, і stopPrice (STOP/STOP_LIMIT)
        const slOrder = await this.exchange.createOrder(mappedSymbol, 'stop', opposite, amount, slPrice, slParams);
        const slId = this._resolveOrderId(slOrder);
        if (slId) childIds.push(slId);
      } catch (e) {
        console.error(`[${this.provider}] Failed to place SL order:`, e?.message || String(e));
      }
    }

    // TP: як ліміт ордер (sell-limit для long / buy-limit для short). Reduce-only не дозволить відкрити нову позицію
    if (hasTP && Number.isFinite(tpPrice) && tpPrice > 0) {
      try {
        const tpOrder = await this.exchange.createOrder(mappedSymbol, 'limit', opposite, amount, tpPrice, reduceParams);
        const tpId = this._resolveOrderId(tpOrder);
        if (tpId) childIds.push(tpId);
      } catch (e) {
        console.error(`[${this.provider}] Failed to place TP order:`, e?.message || String(e));
      }
    }

    return childIds;
  }

  /**
   * Вотчер батьківського ордера: якщо основний ордер буде скасований — скасувати дочірні SL/TP.
   * Перевіряємо статус раз на 2 секунди до 5 хвилин або до завершення (canceled/closed).
   */
  _startParentWatcher(parentId, mappedSymbol) {
    if (!parentId || this._parentWatchers.has(parentId)) return;

    const startedAt = Date.now();
    const timer = setInterval(async () => {
      try {
        const age = Date.now() - startedAt;
        if (age > 5 * 60 * 1000) { // 5 хв — зупинимо вотчер
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
          return;
        }
        const ord = await this.exchange.fetchOrder(parentId, mappedSymbol);
        const st = String(ord?.status || '').toLowerCase();
        if (st === 'canceled') {
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
          await this._cancelChildOrders(parentId);
        } else if (st === 'closed') {
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
        }
      } catch {
        // ігноруємо, спробуємо наступного разу
      }
    }, 2000);

    this._parentWatchers.set(parentId, timer);
  }

  async _cancelChildOrders(parentId) {
    const link = this._childOrdersByParent.get(parentId);
    if (!link) return;
    const { symbol: mappedSymbol, children } = link;
    for (const cid of children || []) {
      try {
        await this.exchange.cancelOrder(cid, mappedSymbol);
      } catch {
        // Спроба відміни по clientOrderId/origClientOrderId (актуально для умовних ордерів на деяких біржах)
        try {
          await this.exchange.cancelOrder(undefined, mappedSymbol, { origClientOrderId: cid, clientOrderId: cid });
        } catch {
          // остання спроба — ігноруємо помилку
        }
      }
    }
    this._childOrdersByParent.delete(parentId);
  }

  /**
   * Очікуваний нормалізований формат замовлення:
   * {
   *   symbol: 'BTC/USDT' або локальний символ, який буде змаплено через symbolMap
   *   side: 'buy' | 'sell',
   *   type: 'market' | 'limit' | 'stop' | 'stoplimit',
   *   qty: number,              // amount
   *   price?: number,           // для limit/stoplimit
   *   stopPrice?: number,       // для stop/stoplimit
   *   clientOrderId?: string,   // опціонально
   *   params?: object           // додаткові ccxt params
   * }
   */
  async placeOrder(order) {
    try {
      await this.ensureReady();
      if (!order || !order.symbol || !order.side || !order.type) {
        return { status: 'rejected', provider: this.provider, reason: 'Missing required fields: symbol, side, type' };
      }
      const symbol = this.mapSymbol(order.symbol);
      const side = order.side;
      const amount = Number(order.qty ?? order.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { status: 'rejected', provider: this.provider, reason: 'Invalid qty/amount' };
      }

      // Визначення типу та параметрів для ccxt
      const typeIn = String(order.type).toLowerCase();
      let ccxtType = typeIn;
      const params = { ...(this.defaultParams || {}), ...(order.params || {}) };

      // Підтримка stop/stoplimit через stopPrice у params (поширений шаблон у ccxt)
      if (typeIn === 'stop' || typeIn === 'stopmarket') {
        ccxtType = 'market';
        const stopPrice = Number(order.stopPrice ?? order.stop);
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'stopPrice required for stop orders' };
        }
        params.stopPrice = stopPrice;
      } else if (typeIn === 'stoplimit' || typeIn === 'stop_limit') {
        ccxtType = 'limit';
        const stopPrice = Number(order.stopPrice ?? order.stop);
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'stopPrice required for stoplimit orders' };
        }
        params.stopPrice = stopPrice;
      } else if (typeIn !== 'market' && typeIn !== 'limit') {
        return { status: 'rejected', provider: this.provider, reason: `Unsupported order type: ${order.type}` };
      }

      if (order.clientOrderId) {
        params.clientOrderId = String(order.clientOrderId);
      }

      let price = undefined;
      if (ccxtType === 'limit') {
        price = Number(order.price ?? order.limitPrice);
        if (!Number.isFinite(price) || price <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'price required for limit/stoplimit orders' };
        }
      }

      // --- Pending: повертаємо відразу, а виконання — асинхронно ---
      const cid = crypto.randomBytes(6).toString('hex');
      this.pending.set(cid, { order, createdAt: Date.now() });

      (async () => {
        try {
          const result = await this.exchange.createOrder(symbol, ccxtType, side, amount, price, params);
          const providerOrderId = String(result?.id ?? result?.clientOrderId ?? '');

          // Після створення — ставимо reduce‑only SL/TP та запускаємо вотчер скасування
          try {
            const entry = Number.isFinite(order.price) ? Number(order.price)
                        : Number.isFinite(order.limitPrice) ? Number(order.limitPrice)
                        : undefined;
            const slPts = Number(order.sl);
            const tpPts = Number(order.tp);
            const mintick = Number(order.mintick);

            if (providerOrderId && Number.isFinite(entry)) {
              const children = await this._placeProtectiveOrders({
                mappedSymbol: symbol,
                side,
                amount,
                entryPrice: entry,
                slPts,
                tpPts,
                mintick,
                baseParams: this.defaultParams || {}
              });
              if (children && children.length) {
                this._childOrdersByParent.set(providerOrderId, { symbol, children });
                this._startParentWatcher(providerOrderId, symbol);
              }
            }
          } catch {
            // не блокуємо підтвердження у разі помилок брекетів
          }

          // Підтвердження для UI
          if (this.pending.has(cid)) {
            this.pending.delete(cid);
            this.events.emit('order:confirmed', {
              pendingId: cid,
              ticket: providerOrderId,
              mtOrder: result,
              origOrder: order
            });
          } else {
            // pending вже знятий (наприклад, stopOpenOrder) — можна спробувати відмінити ордер
            try { if (providerOrderId) await this.exchange.cancelOrder(providerOrderId, symbol); } catch {}
          }
        } catch (e) {
          const rec = this.pending.get(cid);
          this.pending.delete(cid);
          this.events.emit('order:rejected', {
            pendingId: cid,
            reason: e?.message || String(e),
            origOrder: (rec && rec.order) || order
          });
        }
      })();

      return {
        status: 'ok',
        provider: this.provider,
        providerOrderId: `pending:${cid}`,
        raw: { enqueued: true, cid },
      };
    } catch (err) {
      return {
        status: 'rejected',
        provider: this.provider,
        reason: err?.message || String(err),
        raw: { stack: err?.stack },
      };
    }
  }

  /** @returns {Promise<any[]>} список відкритих ордерів */
  async listOpenOrders() {
    try {
      const orders = await this.exchange.fetchOpenOrders();
      return orders || [];
    } catch {
      return [];
    }
  }

  /** @returns {Promise<any[]>} історія закритих ордерів (як аналог позицій) */
  async listClosedPositions() {
    try {
      if (typeof this.exchange.fetchClosedOrders === 'function') {
        const orders = await this.exchange.fetchClosedOrders();
        return orders || [];
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Отримати котирування
   * @param {string} symbol - у форматі ccxt або локальний (буде змаплено)
   * @returns {Promise<{bid?:number, ask?:number, price?:number}|null>}
   */
  async getQuote(symbol) {
    try {
      await this.ensureReady();
      const mapped = this.mapSymbol(symbol);
      if (!mapped) return null;
      const t = await this.exchange.fetchTicker(mapped);
      if (!t) return null;
      const price = Number.isFinite(t.last) ? t.last :
                    (Number.isFinite(t.bid) && Number.isFinite(t.ask)) ? (t.bid + t.ask) / 2 :
                    undefined;
      return { bid: t.bid, ask: t.ask, price };
    } catch {
      return null;
    }
  }
}

module.exports = { CCXTExecutionAdapter };

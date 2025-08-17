// app/adapters/ccxt.js
const { ExecutionAdapter } = require('./base');
const ccxt = require('ccxt');

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

      const result = await this.exchange.createOrder(symbol, ccxtType, side, amount, price, params);

      const providerOrderId = String(result?.id ?? result?.clientOrderId ?? '');
      return {
        status: 'ok',
        provider: this.provider,
        providerOrderId,
        raw: result,
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

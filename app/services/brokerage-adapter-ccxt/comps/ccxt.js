// services/brokerage-adapter-ccxt/comps/ccxt.js
const { ExecutionAdapter } = require('../../brokerage/comps/base');
const ccxt = require('ccxt');
const crypto = require('crypto');
const events = require('../../events');

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

    if (cfg.sandbox) {
      if (typeof this.exchange.enableDemoTrading === 'function') {
        this.exchange.enableDemoTrading(true)
      } else if (typeof this.exchange.setSandboxMode === 'function') {
        this.exchange.setSandboxMode(true);
      } else {
        throw new Error(`CCXT: unable to set demo/sandbox mode for exchange: ${cfg.exchangeId || '(empty)'}, please consult with documentation`);
      }
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

    // Трекінг позицій/замовлень для подій як у DWX
    this._ticketToSymbol = new Map(); // ticket(providerOrderId) -> mappedSymbol
    this._ticketOpened = new Set();   // ticket -> boolean (позиція відкрита)
    this.watchIntervalMs = Number.isFinite(cfg.watchIntervalMs) ? cfg.watchIntervalMs : 2000;
    this._watchTimer = null;
    this._startWatchLoop();

    // Бар-стріми: спочатку websocket (watchOHLCV), з фолбеком на polling fetchOHLCV.
    this.barPollIntervalMs = Number.isFinite(cfg.barPollIntervalMs) ? cfg.barPollIntervalMs : 5000;
    this.barWatchFailuresLimit = Number.isFinite(cfg.barWatchFailuresLimit) ? cfg.barWatchFailuresLimit : 3;
    this._barSubscriptions = new Map(); // key: originalSymbol::timeframe -> { originalSymbol, mappedSymbol, timeframe }
    this._barLastTs = new Map(); // key: originalSymbol::timeframe -> last bar timestamp
    this._barTasks = new Map(); // key -> { stop, mode, failures, timer }
    this.client = {
      subscribe_symbols_bar_data: this.subscribe_symbols_bar_data.bind(this),
      unsubscribe_symbols_bar_data: this.unsubscribe_symbols_bar_data.bind(this)
    };

    // Кеш котирувань: per-symbol watchTicker/fetchTicker
    this.tickerPollIntervalMs = Number.isFinite(cfg.tickerPollIntervalMs) ? cfg.tickerPollIntervalMs : 5000;
    this.tickerWatchFailuresLimit = Number.isFinite(cfg.tickerWatchFailuresLimit) ? cfg.tickerWatchFailuresLimit : 3;
    this._tickerCache = new Map(); // mappedSymbol -> { bid, ask, price, tickSize }
    this._tickerWatchTasks = new Map(); // mappedSymbol -> { stop, mode, failures, timer }

    // Конфіг бажаних SL/TP по тікету (щоб забезпечити та відновлювати SL/TP після фактичного входу)
    this._desiredProtectionByTicket = new Map(); // ticket -> { symbol, side, amount, slPts, tpPts, tickSize }

    // Binance USDⓈ-M REST helpers
    this._binanceTimeOffsetMs = 0;
    this._binanceTimeOffsetUpdatedAt = 0;
    this._binanceExchangeInfoCache = null;
    this._binanceExchangeInfoLoadedAt = 0;

    // Автоматичне забезпечення/скасування SL/TP по подіях позицій
    this.on('position:opened', async ({ ticket }) => {
      try { await this._ensureProtectiveOrdersForTicket(ticket); } catch {}
    });
    this.on('position:closed', async ({ ticket }) => {
      try { await this._cancelAllProtectionForTicket(ticket); } catch {}
    });
  }

  async ensureReady() {
    if (this._marketsLoaded) return;
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        try {
          const markets = await this.exchange.loadMarkets();
          if (this.autoBuildSymbolMap) this._buildSymbolMapFromMarkets(markets);
          if (typeof this.exchange.loadTimeDifference === 'function') {
            try { await this.exchange.loadTimeDifference(); } catch {}
          }
        } finally {
          this._marketsLoaded = true;
        }
      })();
    }
    return this._readyPromise;
  }

  async _binancePublicRequest(path, params = {}) {
    const baseUrl = 'https://fapi.binance.com';
    const query = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    const res = await fetch(url, { method: 'GET' });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) throw new Error(`binance ${JSON.stringify(json)}`);
    return json;
  }

  async _syncBinanceServerTime(force = false) {
    const now = Date.now();
    if (!force && now - this._binanceTimeOffsetUpdatedAt < 30000) return this._binanceTimeOffsetMs;
    const json = await this._binancePublicRequest('/fapi/v1/time');
    const serverTime = Number(json?.serverTime);
    if (Number.isFinite(serverTime)) {
      this._binanceTimeOffsetMs = serverTime - Date.now();
      this._binanceTimeOffsetUpdatedAt = Date.now();
    }
    return this._binanceTimeOffsetMs;
  }

  async _binanceSignedRequest(method, path, params = {}) {
    const apiKey = this.exchange?.apiKey;
    const secret = this.exchange?.secret;
    if (!apiKey || !secret) throw new Error('Binance API key/secret are required');
    const baseUrl = 'https://fapi.binance.com';
    await this._syncBinanceServerTime();
    const payload = { ...params, recvWindow: 5000, timestamp: Date.now() + this._binanceTimeOffsetMs };
    const query = Object.entries(payload)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
    const total = `${query}&signature=${signature}`;
    const url = `${baseUrl}${path}${method === 'GET' || method === 'DELETE' ? `?${total}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : total
    });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) throw new Error(`binance ${JSON.stringify(json)}`);
    return json;
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

  subscribe_symbols_bar_data(symbols = []) {
    if (!Array.isArray(symbols)) return;
    for (const entry of symbols) {
      const [symbol, timeframe] = Array.isArray(entry) ? entry : [];
      if (!symbol || !timeframe) continue;
      const originalSymbol = String(symbol);
      const tf = String(timeframe);
      const mappedSymbol = this.mapSymbol(originalSymbol);
      const key = `${originalSymbol}::${tf}`;
      this._barSubscriptions.set(key, { originalSymbol, mappedSymbol, timeframe: tf });
    }
    this._startBarPolling();
  }

  unsubscribe_symbols_bar_data(symbols = []) {
    if (!Array.isArray(symbols)) return;
    for (const entry of symbols) {
      const [symbol, timeframe] = Array.isArray(entry) ? entry : [];
      if (!symbol || !timeframe) continue;
      const originalSymbol = String(symbol);
      const tf = String(timeframe);
      const key = `${originalSymbol}::${tf}`;
      this._barSubscriptions.delete(key);
      this._stopBarTask(key);
    }
  }

  _normalizeTimeframe(timeframe) {
    const raw = String(timeframe || '').trim();
    if (!raw) return '';
    if (this.exchange?.timeframes) {
      if (this.exchange.timeframes[raw]) return raw;
      const lower = raw.toLowerCase();
      if (this.exchange.timeframes[lower]) return lower;
      const upper = raw.toUpperCase();
      if (this.exchange.timeframes[upper]) return upper;
    }
    const upper = raw.toUpperCase();
    const mapping = {
      M1: '1m',
      M5: '5m',
      M15: '15m',
      M30: '30m',
      H1: '1h',
      H4: '4h',
      D1: '1d',
      W1: '1w'
    };
    if (mapping[upper]) return mapping[upper];
    return raw;
  }

  _supportsWatchOHLCV() {
    return !!(this.exchange?.has?.watchOHLCV && typeof this.exchange.watchOHLCV === 'function');
  }

  _supportsWatchTicker() {
    return !!(this.exchange?.has?.watchTicker && typeof this.exchange.watchTicker === 'function');
  }

  _startBarPolling() {
    for (const key of this._barSubscriptions.keys()) {
      this._ensureBarTask(key);
    }
    for (const key of this._barTasks.keys()) {
      if (!this._barSubscriptions.has(key)) {
        this._stopBarTask(key);
      }
    }
  }

  _ensureTickerTask(mappedSymbol) {
    if (!mappedSymbol || this._tickerWatchTasks.has(mappedSymbol)) return;
    const task = {
      mode: this._supportsWatchTicker() ? 'watch' : 'poll',
      failures: 0,
      timer: null,
      active: true,
      stop: () => {
        task.active = false;
        if (task.timer) clearInterval(task.timer);
        task.timer = null;
      }
    };
    this._tickerWatchTasks.set(mappedSymbol, task);
    if (task.mode === 'watch') {
      this._startTickerWatchLoop(mappedSymbol, task);
    } else {
      this._startTickerPollLoop(mappedSymbol, task);
    }
  }

  _stopTickerTask(mappedSymbol) {
    const task = this._tickerWatchTasks.get(mappedSymbol);
    if (!task) return;
    try { task.stop?.(); } catch {}
    this._tickerWatchTasks.delete(mappedSymbol);
  }

  async _startTickerWatchLoop(mappedSymbol, task) {
    const backoffMs = 500;
    const notifyFailures = () => {
      try {
        events.emit('ticker:watch_failed', {
          provider: this.provider,
          symbol: mappedSymbol,
          failures: task.failures
        });
      } catch {}
    };
    while (task.active) {
      try {
        await this.ensureReady();
      } catch {
        task.failures += 1;
        if (task.failures >= this.tickerWatchFailuresLimit) {
          notifyFailures();
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      try {
        const t = await this.exchange.watchTicker(mappedSymbol);
        task.failures = 0;
        if (!this._isTickerTaskActive(mappedSymbol, task)) continue;
        await this._updateTickerCache(mappedSymbol, t, true);
      } catch {
        task.failures += 1;
        if (task.failures >= this.tickerWatchFailuresLimit) {
          notifyFailures();
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  _startTickerPollLoop(mappedSymbol, task) {
    if (!task.active) return;
    const interval = Math.max(1000, this.tickerPollIntervalMs);
    const pollOnce = () => {
      this._pollTickerOnce(mappedSymbol, task).catch(() => {});
    };
    task.timer = setInterval(pollOnce, interval);
    pollOnce();
  }

  _isTickerTaskActive(mappedSymbol, task) {
    return task?.active && this._tickerWatchTasks.get(mappedSymbol) === task;
  }

  async _pollTickerOnce(mappedSymbol, task) {
    if (!mappedSymbol || typeof this.exchange.fetchTicker !== 'function') return;
    try {
      await this.ensureReady();
    } catch {
      return;
    }
    let t;
    try {
      t = await this.exchange.fetchTicker(mappedSymbol);
    } catch {
      return;
    }
    if (!this._isTickerTaskActive(mappedSymbol, task)) return;
    await this._updateTickerCache(mappedSymbol, t, true);
  }

  _ensureBarTask(key) {
    if (this._barTasks.has(key)) return;
    const task = {
      mode: this._supportsWatchOHLCV() ? 'watch' : 'poll',
      failures: 0,
      timer: null,
      active: true,
      stop: () => {
        task.active = false;
        if (task.timer) clearInterval(task.timer);
        task.timer = null;
      }
    };
    this._barTasks.set(key, task);
    if (task.mode === 'watch') {
      this._startBarWatchLoop(key, task);
    } else {
      this._startBarPollLoop(key, task);
    }
  }

  _stopBarTask(key) {
    const task = this._barTasks.get(key);
    if (!task) return;
    try { task.stop?.(); } catch {}
    this._barTasks.delete(key);
    this._barLastTs.delete(key);
  }

  async _startBarWatchLoop(key, task) {
    const backoffMs = 500;
    const notifyFailures = (sub) => {
      try {
        events.emit('bar:watch_failed', {
          provider: this.provider,
          symbol: sub?.originalSymbol,
          timeframe: sub?.timeframe,
          failures: task.failures
        });
      } catch {}
    };
    while (task.active) {
      const sub = this._barSubscriptions.get(key);
      if (!sub) break;
      try {
        await this.ensureReady();
      } catch {
        task.failures += 1;
        if (task.failures >= this.barWatchFailuresLimit) {
          notifyFailures(sub);
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      const refreshedSymbol = this.mapSymbol(sub.originalSymbol);
      if (!refreshedSymbol) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      if (refreshedSymbol !== sub.mappedSymbol) {
        this._barSubscriptions.set(key, { ...sub, mappedSymbol: refreshedSymbol });
      }
      const normalizedTimeframe = this._normalizeTimeframe(sub.timeframe);
      if (!normalizedTimeframe) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      try {
        const bars = await this.exchange.watchOHLCV(refreshedSymbol, normalizedTimeframe);
        task.failures = 0;
        const last = Array.isArray(bars) ? bars[bars.length - 1] : null;
        if (last) this._emitBarFromCandle(key, sub, last);
      } catch {
        task.failures += 1;
        if (task.failures >= this.barWatchFailuresLimit) {
          notifyFailures(sub);
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  _startBarPollLoop(key, task) {
    if (!task.active) return;
    const interval = Math.max(1000, this.barPollIntervalMs);
    const pollOnce = () => {
      this._pollBarsOnce(key).catch(() => {});
    };
    task.timer = setInterval(pollOnce, interval);
    pollOnce();
  }

  async _pollBarsOnce(key) {
    if (!key) return;
    const sub = this._barSubscriptions.get(key);
    if (!sub) return;
    try {
      await this.ensureReady();
    } catch {
      return;
    }
    const { originalSymbol, mappedSymbol, timeframe } = sub;
    const refreshedSymbol = this.mapSymbol(originalSymbol);
    if (!refreshedSymbol || !timeframe) return;
    if (refreshedSymbol !== mappedSymbol) {
      this._barSubscriptions.set(key, { ...sub, mappedSymbol: refreshedSymbol });
    }
    const normalizedTimeframe = this._normalizeTimeframe(timeframe);
    if (!normalizedTimeframe) return;
    let bars;
    try {
      bars = await this.exchange.fetchOHLCV(refreshedSymbol, normalizedTimeframe);
    } catch {
      return;
    }
    if (!Array.isArray(bars) || bars.length === 0) return;
    const last = bars[bars.length - 1];
    if (last) this._emitBarFromCandle(key, sub, last);
  }

  _emitBarFromCandle(key, sub, candle) {
    if (!Array.isArray(candle) || candle.length < 5) return;
    const time = Number(candle[0]);
    if (!Number.isFinite(time)) return;
    const lastTs = this._barLastTs.get(key);
    //skip bars from the past but do not skip updatesK
    if (Number.isFinite(lastTs) && time < lastTs) return;
    this._barLastTs.set(key, time);
    const open = Number(candle[1]);
    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);
    const vol = Number(candle[5]);
    try {
      events.emit('bar', {
        provider: this.provider,
        symbol: sub.originalSymbol,
        tf: sub.timeframe,
        time,
        open,
        high,
        low,
        close,
        vol
      });
    } catch {}
  }

  async shutdown() {
    for (const key of this._barTasks.keys()) {
      this._stopBarTask(key);
    }
    for (const mappedSymbol of this._tickerWatchTasks.keys()) {
      this._stopTickerTask(mappedSymbol);
    }
    this._tickerCache.clear();
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    try {
      if (typeof this.exchange?.close === 'function') {
        await this.exchange.close();
      }
    } catch {}
  }

  _getTickSizeFromMarket(mappedSymbol) {
    try {
      const m = (this.exchange.markets && this.exchange.markets[mappedSymbol]) || this.exchange.market(mappedSymbol);
      if (!m) return 0.01;

      // 1) За precision.price
      const p = m?.precision?.price;
      if (Number.isInteger(p) && p >= 0 && p <= 18) {
        const ts = Math.pow(10, -p);
        // console.log(`[${this.provider}] Using precision.price=${p} for ${mappedSymbol}:`, ts);
        if (Number.isFinite(ts) && ts > 0) return ts;
      }

      // 2) Уніфіковане tickSize (деякі біржі надають)
      if (Number.isFinite(m?.tickSize) && m.tickSize > 0)  {
        // console.log(`[${this.provider}] Using tickSize=${m.tickSize} for ${mappedSymbol}:`, m.tickSize);
        return Number(m.tickSize);
      }


      // // 3) limits.price.step (інколи відповідає мін. кроку)
      // const step = m?.limits?.price?.min;
      // if (Number.isFinite(step) && step > 0) {
      //   console.log(`[${this.provider}] Using price.step=${step} for ${mappedSymbol}:`, step);
      //   return Number(step);
      // }

      // 4) Біржові "info"
      const info = m.info || {};
      // Binance
      if (Array.isArray(info.filters)) {
        const pf = info.filters.find(f => String(f.filterType).toUpperCase() === 'PRICE_FILTER');
        const ts = pf && parseFloat(pf.tickSize);
        if (Number.isFinite(ts) && ts > 0) {
          // console.log(`[${this.provider}] Using price.filter.tickSize=${ts} for ${mappedSymbol}:`, ts);
          return ts;
        }
      }
      // Bybit
      const bbTs = parseFloat(info?.priceFilter?.tickSize || info?.priceFilter?.tick_size);
      if (Number.isFinite(bbTs) && bbTs > 0) return bbTs;
      // OKX
      const okxTs = parseFloat(info?.tickSz || info?.tickSize);
      if (Number.isFinite(okxTs) && okxTs > 0) return okxTs;

      return 0.01;
    } catch {
      return 0.01;
    }
  }

  mapSymbol(symbol) {
    if (!symbol) return symbol;
    return this.symbolMap[symbol] || this.symbolMap[String(symbol).toUpperCase()] || symbol;
  }

  async _getBinanceExchangeInfo() {
    const now = Date.now();
    if (this._binanceExchangeInfoCache && now - this._binanceExchangeInfoLoadedAt < 5 * 60 * 1000) {
      return this._binanceExchangeInfoCache;
    }
    const info = await this._binancePublicRequest('/fapi/v1/exchangeInfo');
    this._binanceExchangeInfoCache = info;
    this._binanceExchangeInfoLoadedAt = now;
    return info;
  }

  async normalizeBinanceUsdmSymbol(input) {
    const symbolInput = String(input || '').trim();
    let normalized = symbolInput.toUpperCase();
    if (normalized.endsWith('.P')) normalized = normalized.slice(0, -2);
    if (normalized.includes(':')) {
      const pair = normalized.split(':')[0];
      const [base, quote] = pair.split('/');
      if (base && quote) normalized = `${base}${quote}`;
    } else if (normalized.includes('/')) {
      normalized = normalized.replace('/', '');
    }
    normalized = normalized.replace(/[^A-Z0-9]/g, '');

    const info = await this._getBinanceExchangeInfo();
    const exists = Array.isArray(info?.symbols) && info.symbols.some((s) => String(s?.symbol || '').toUpperCase() === normalized);
    if (!exists) {
      throw new Error(`Invalid futures symbol: ${symbolInput} normalized to ${normalized} but not found in exchangeInfo`);
    }
    return normalized;
  }


  _binanceQuoteTypeToEndpoint(quoteType = 'book') {
    if (quoteType === 'last') return '/fapi/v2/ticker/price';
    if (quoteType === 'mark') return '/fapi/v1/premiumIndex';
    if (quoteType === 'book' || quoteType === 'execution') return '/fapi/v1/ticker/bookTicker';
    return undefined;
  }

  /**
   * Get the native exchange symbol (e.g., 'ETHUSDT' for Binance) from a CCXT mapped symbol ('ETH/USDT:USDT').
   * @param {string} mappedSymbol
   * @returns {string}
   */
  getNativeSymbol(mappedSymbol) {
    try {
      if (!mappedSymbol) return mappedSymbol;
      if (this.exchange.markets && this.exchange.markets[mappedSymbol]) {
        return this.exchange.markets[mappedSymbol].id || mappedSymbol;
      }
      const market = this.exchange.market(mappedSymbol);
      return market?.id || mappedSymbol;
    } catch {
      return mappedSymbol;
    }
  }

  async _updateTickerCache(mappedSymbol, ticker, allowOrderBookFallback) {
    if (!mappedSymbol || !ticker) return;
    const quote = await this._parseQuoteFromTicker(mappedSymbol, ticker, allowOrderBookFallback);
    if (!quote) return;
    this._tickerCache.set(mappedSymbol, quote);
  }

  async _parseQuoteFromTicker(mappedSymbol, t, allowOrderBookFallback = true) {
    if (!t) return null;
    // Надійне діставання bid/ask: спочатку з уніфікованих полів, далі з info, і як fallback — orderbook
    let bid = Number.isFinite(t.bid) ? Number(t.bid)
      : (t.info && Number.isFinite(Number(t.info.bidPrice)) ? Number(t.info.bidPrice)
        : (t.info && Number.isFinite(Number(t.info.bestBid)) ? Number(t.info.bestBid)
          : (t.info && Number.isFinite(Number(t.info.b)) ? Number(t.info.b) : undefined)));

    let ask = Number.isFinite(t.ask) ? Number(t.ask)
      : (t.info && Number.isFinite(Number(t.info.askPrice)) ? Number(t.info.askPrice)
        : (t.info && Number.isFinite(Number(t.info.bestAsk)) ? Number(t.info.bestAsk)
          : (t.info && Number.isFinite(Number(t.info.a)) ? Number(t.info.a) : undefined)));

    if (allowOrderBookFallback && (!Number.isFinite(bid) || !Number.isFinite(ask)) && typeof this.exchange.fetchOrderBook === 'function') {
      try {
        const ob = await this.exchange.fetchOrderBook(mappedSymbol, 5);
        if (!Number.isFinite(bid) && Array.isArray(ob?.bids) && ob.bids.length) {
          const v = Number(ob.bids[0][0]);
          if (Number.isFinite(v)) bid = v;
        }
        if (!Number.isFinite(ask) && Array.isArray(ob?.asks) && ob.asks.length) {
          const v = Number(ob.asks[0][0]);
          if (Number.isFinite(v)) ask = v;
        }
      } catch {
        // ігноруємо помилку фолу до ордербука
      }
    }

    let price = Number.isFinite(t.last) ? Number(t.last)
      : (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2
        : (Number.isFinite(Number(t.close)) ? Number(t.close)
          : (Number.isFinite(Number(t.info?.lastPrice)) ? Number(t.info.lastPrice) : undefined));

    const tickSize = this._getTickSizeFromMarket(mappedSymbol);
    return { bid, ask, price, tickSize };
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

  _startWatchLoop() {
    if (this._watchTimer || typeof this.exchange.fetchPositions !== 'function') return;
    this._watchTimer = setInterval(() => {
      this._watchOnce().catch(() => {});
    }, Math.max(500, this.watchIntervalMs));
    // перша ітерація
    this._watchOnce().catch(() => {});
  }

  async _watchOnce() {
    try {
      // якщо нема нічого відстежувати — пропускаємо (економимо ліміти)
      if (this._ticketToSymbol.size === 0) return;

      // 1) Позиції: будуємо map символ -> net size
      let positions = [];
      try { positions = await this.exchange.fetchPositions(); } catch { positions = []; }
      const sizeBySymbol = new Map();
      const pnlBySymbol = new Map();

      for (const p of positions || []) {
        const sym = p?.symbol || p?.info?.symbol || p?.info?.instId;
        if (!sym) continue;
        // спробуємо нормалізувати розмір
        const sz = Number(p?.contracts ?? p?.positionAmt ?? p?.size ?? p?.info?.positionAmt ?? p?.info?.pos ?? 0);
        const net = Number(sizeBySymbol.get(sym) || 0) + (Number.isFinite(sz) ? sz : 0);
        sizeBySymbol.set(sym, net);
        const upnl = Number(p?.unrealizedPnl ?? p?.info?.unrealizedPnl ?? p?.info?.upl ?? 0);
        pnlBySymbol.set(sym, upnl);
      }

      // 2) Для кожного ticket (оригінальна заявка) дивимось символ і зміну стану
      for (const [ticket, sym] of this._ticketToSymbol.entries()) {
        const szNow = Number(sizeBySymbol.get(sym) || 0);
        const wasOpen = this._ticketOpened.has(ticket);
        if (!wasOpen && szNow !== 0) {
          // відкрилася позиція
          this._ticketOpened.add(ticket);
          this.events.emit('position:opened', { ticket, order: { symbol: sym, size: szNow } });
        } else if (wasOpen && szNow === 0) {
          // позиція закрилась
          this._ticketOpened.delete(ticket);
          const profit = pnlBySymbol.has(sym) ? Number(pnlBySymbol.get(sym)) : undefined;
          this.events.emit('position:closed', { ticket, trade: { profit } });
        }
      }
    } catch {
      // ignore watcher errors
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
  async _placeProtectiveOrders({ mappedSymbol, side, amount, entryPrice, slPts, tpPts, tickSize, baseParams = {} }) {
    const childIds = [];
    const opposite = side === 'buy' ? 'sell' : 'buy';
    const tick = Number(tickSize) > 0 ? Number(tickSize) : 1;

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

    // Binance Futures: частина умовних ордерів тепер вимагає Algo API endpoint.
    // Намагаємось ставити SL/TP через algo endpoint, а createOrder залишаємо як fallback.
    const tryBinanceAlgoOrder = async ({ kind, triggerPrice, limitPrice }) => {
      if (this.exchangeId !== 'binance') return null;
      const nativeSymbol = this.getNativeSymbol(mappedSymbol);
      if (!nativeSymbol) return null;

      const orderType = kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
      const req = {
        symbol: nativeSymbol,
        side: String(opposite || '').toUpperCase(),
        quantity: this.exchange.amountToPrecision(mappedSymbol, amount),
        reduceOnly: 'true',
        stopPrice: this.exchange.priceToPrecision(mappedSymbol, triggerPrice),
        workingType: 'CONTRACT_PRICE',
        priceProtect: 'TRUE',
        timeInForce: 'GTC',
        type: orderType,
      };
      if (Number.isFinite(limitPrice) && limitPrice > 0) {
        req.type = kind === 'SL' ? 'STOP' : 'TAKE_PROFIT';
        req.price = this.exchange.priceToPrecision(mappedSymbol, limitPrice);
      }

      const posSide = String(baseParams.positionSide || '').toUpperCase();
      if (posSide === 'LONG' || posSide === 'SHORT') req.positionSide = posSide;

      const fns = [
        ['fapiPrivatePostAlgoOrder', this.exchange.fapiPrivatePostAlgoOrder],
        ['fapiPrivate_post_algoorder', this.exchange.fapiPrivate_post_algoorder],
        ['fapiPrivatePostAlgoOrders', this.exchange.fapiPrivatePostAlgoOrders],
        ['fapiPrivate_post_algoorders', this.exchange.fapiPrivate_post_algoorders],
      ].filter(([, fn]) => typeof fn === 'function');
      if (!fns.length) {
        console.warn(`[${this.provider}] Binance algo method not found in ccxt instance; trying signed /fapi/v1/algoOrder for ${kind}`, {
          mappedSymbol,
          nativeSymbol,
          availableAlgoKeys: Object.keys(this.exchange || {}).filter(k => k.toLowerCase().includes('algo')).slice(0, 50)
        });
        const algoReq = {
          algoType: 'CONDITIONAL',
          symbol: nativeSymbol,
          side: String(opposite || '').toUpperCase(),
          type: req.type,
          quantity: req.quantity,
          triggerPrice: req.stopPrice,
          workingType: 'MARK_PRICE',
          clientAlgoId: `${kind.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        };
        if (String(baseParams?.positionSide || '').toUpperCase() === 'LONG' || String(baseParams?.positionSide || '').toUpperCase() === 'SHORT') {
          algoReq.positionSide = String(baseParams.positionSide).toUpperCase();
        } else {
          algoReq.reduceOnly = 'true';
        }
        const res = await this._binanceSignedRequest('POST', '/fapi/v1/algoOrder', algoReq);
        const algoId = String(res?.algoId || res?.clientAlgoId || '').trim();
        if (algoId) return { id: algoId, raw: res };
        return null;
      }
      console.log(`[${this.provider}] Trying Binance algo ${kind}`, {
        methodCandidates: fns.map(([name]) => name),
        request: req
      });
      for (const [name, fn] of fns) {
        const res = await fn.call(this.exchange, req);
        const algoId = String(res?.algoId || res?.orderId || res?.clientOrderId || '').trim();
        if (algoId) {
          console.log(`[${this.provider}] Binance algo ${kind} placed`, { method: name, algoId, response: res });
          return { id: algoId, raw: res };
        }
        console.warn(`[${this.provider}] Binance algo ${kind} no id in response`, { method: name, response: res });
      }
      return null;
    };

    // SL: спершу намагаємось чистий stop-market (без price), фолбек — stop-limit
    if (hasSL && Number.isFinite(slPrice) && slPrice > 0) {
      const slParams = { ...reduceParams, stopPrice: slPrice };
      try {
        // 0) Для Binance USDⓈ-M часто працює саме closePosition STOP_MARKET через createOrder.
        // Це не OCO/брекет, але коректно закриває відкриту позицію по тригеру.
        if (this.exchangeId === 'binance') {
          try {
            const p = {
              ...slParams,
              closePosition: true,
              workingType: slParams.workingType || 'CONTRACT_PRICE',
              priceProtect: slParams.priceProtect ?? 'TRUE',
            };
            const slClosePos = await this.exchange.createOrder(mappedSymbol, 'stop_market', opposite, undefined, undefined, p);
            const slCloseId = this._resolveOrderId(slClosePos);
            if (slCloseId) {
              childIds.push(slCloseId);
              slParams._algoPlaced = true;
            }
          } catch (closeErr) {
            console.warn(`[${this.provider}] Binance closePosition STOP_MARKET SL failed, trying algo/createOrder fallback`, closeErr?.message || String(closeErr));
          }
        }

        // 0) Binance Algo API
        try {
          if (slParams._algoPlaced) throw new Error('SL_ALREADY_PLACED');
          const algoSL = await tryBinanceAlgoOrder({ kind: 'SL', triggerPrice: slPrice });
          if (algoSL?.id) {
            childIds.push(algoSL.id);
            slParams._algoPlaced = true;
          }
        } catch (algoErr) {
          if (String(algoErr?.message || '') === 'SL_ALREADY_PLACED') {
            // skip algo attempt
          } else {
          console.warn(`[${this.provider}] Binance algo SL failed, fallback to createOrder`, algoErr?.message || String(algoErr));
          }
        }

        if (slParams._algoPlaced) {
          delete slParams._algoPlaced;
          // already placed via algo endpoint
        } else {
        // 1) Спроба створити чистий stop-market (без price)
        // Binance: деривативи — STOP_MARKET, spot — STOP_LOSS
        let slOrder;
        try {
          const mkt = typeof this.exchange.market === 'function' ? this.exchange.market(mappedSymbol) : null;
          const isDeriv = !!(mkt && (mkt.contract || mkt.swap || mkt.future));
          const stopType =
            (this.exchangeId === 'binance')
              ? (isDeriv ? 'STOP_MARKET' : 'STOP_LOSS')
              : 'STOP_MARKET';
          slOrder = await this.exchange.createOrder(mappedSymbol, stopType, opposite, amount, undefined, slParams);
        } catch (e1) {
          // 2) Фолбек: stop-limit (деякі біржі вимагають наявність price разом зі stopPrice)
          slOrder = await this.exchange.createOrder(mappedSymbol, 'stop', opposite, amount, slPrice, slParams);
        }
        const slId = this._resolveOrderId(slOrder);
        if (slId) childIds.push(slId);
        }
      } catch (e) {
        console.error(`[${this.provider}] Failed to place SL order:`, e?.message || String(e));
      }
    }

    // TP: спочатку умовний ордер (уникнути миттєвого матчу без позиції):
    // 1) TAKE_PROFIT_MARKET зі stopPrice (reduceOnly)
    // 2) TAKE_PROFIT (limit) з price=tpPrice і stopPrice
    // 3) fallback: звичайний limit (може бути відхилений на деяких біржах)
    if (hasTP && Number.isFinite(tpPrice) && tpPrice > 0) {
      let placed = false;
      // 0) Binance Algo API
      try {
        const algoTP = await tryBinanceAlgoOrder({ kind: 'TP', triggerPrice: tpPrice });
        const tpId = algoTP?.id;
        if (tpId) {
          childIds.push(tpId);
          placed = true;
        }
      } catch (algoErr) {
        console.warn(`[${this.provider}] Binance algo TP failed, fallback to createOrder`, algoErr?.message || String(algoErr));
      }

      // 1) TP market on trigger
      if (!placed) {
        try {
          const p = { ...reduceParams, stopPrice: tpPrice };
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'take_profit_market', opposite, amount, undefined, p);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) {
            childIds.push(tpId);
            placed = true;
          }
        } catch (_) {}
      }

      // 2) TP limit on trigger
      if (!placed) {
        try {
          const p = { ...reduceParams, stopPrice: tpPrice };
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'take_profit', opposite, amount, tpPrice, p);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) {
            childIds.push(tpId);
            placed = true;
          }
        } catch (_) {}
      }

      // 3) Fallback: plain limit (reduceOnly). Може бути відхилений біржею — логируем і йдемо далі.
      if (!placed) {
        try {
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'limit', opposite, amount, tpPrice, reduceParams);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) childIds.push(tpId);
        } catch (e) {
          console.error(`[${this.provider}] Failed to place TP order:`, e?.message || String(e));
        }
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
          // повідомимо UI про відміну ордера
          this.events.emit('order:cancelled', { ticket: parentId });
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
    await this.ensureReady();
    for (const cid of children || []) {
      try {
        if (this.exchangeId === 'binance' && String(cid).length > 20) {
           // Ймовірно algoId для Binance Futures
           try {
             const nativeSymbol = this.getNativeSymbol(mappedSymbol);
             await this.exchange.fapiPrivateDeleteAlgoOpenOrders({ symbol: nativeSymbol, algoId: cid });
             continue;
           } catch (e) {
             // якщо не вдалося через fapi - спробуємо звичайним cancelOrder
           }
        }
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

  // Класифікація ордеру як SL або TP за його типом
  _classifyOrderAsSLorTP(ord) {
    try {
      const t = String(ord?.type || ord?.orderType || ord?.info?.orderType || ord?.info?.type || '').toLowerCase();
      if (!t) return null;
      if (t.includes('take')) return 'TP';
      if (t.includes('stop') && !t.includes('take')) return 'SL';
      if (t.includes('stop_loss') || t.includes('stoploss') || t === 'stop') return 'SL';
      return null;
    } catch {
      return null;
    }
  }

  async _openOrdersSym(sym) {
    try {
      await this.ensureReady();
      let simpleOrders = await this.exchange.fetchOpenOrders(sym);

      let conditionalOrders = await this.exchange.fetchOpenOrders(sym, params => ({
        ...params,
        stop: true,
        trigger: true,
        conditional: true
      }));

      let algoOrders = [];
      if (this.exchangeId === 'binance') {
        const nativeSymbol = this.getNativeSymbol(sym);
        const getOpenAlgo =
          this.exchange.fapiPrivateGetOpenAlgoOrders
          || this.exchange.fapiPrivate_get_openalgoorders;
        if (typeof getOpenAlgo === 'function') {
          algoOrders = await getOpenAlgo.call(this.exchange, { symbol: nativeSymbol, stop: true });
        } else {
          try {
            algoOrders = await this._binanceSignedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: nativeSymbol });
          } catch (e) {
            console.warn(`[${this.provider}] raw openAlgoOrders failed for ${sym}:`, e?.message || String(e));
          }
        }
      }

      console.log("Open orders sym", this.exchangeId,  simpleOrders, conditionalOrders, algoOrders );
      return [
        ...simpleOrders,
        ...conditionalOrders,
        ...algoOrders
      ];
    } catch (e) {
      console.error(`[${this.provider}] Failed to fetch open orders for symbol ${sym}`, e);
      return [];
    }
  }

  async _openOrders() {
    try {
      await this.ensureReady();
      let simpleOrders = await this.exchange.fetchOpenOrders();
      let conditionalOrders = await this.exchange.fetchOpenOrders(params => ({
        ...params,
        stop: true,
        trigger: true,
        conditional: true
      }));

      let algoOrders = [];
      if (this.exchangeId === 'binance') {
        const getOpenAlgo =
          this.exchange.fapiPrivateGetOpenAlgoOrders
          || this.exchange.fapiPrivate_get_openalgoorders;
        if (typeof getOpenAlgo === 'function') {
          algoOrders = await getOpenAlgo.call(this.exchange);
        } else if (typeof this.exchange.request === 'function') {
          try {
            algoOrders = await this.exchange.request('openAlgoOrders', 'fapiPrivate', 'GET', {});
          } catch (e) {
            console.warn(`[${this.provider}] raw openAlgoOrders failed:`, e?.message || String(e));
          }
        }
      }
      console.log("Open orders", this.exchangeId, simpleOrders, conditionalOrders, algoOrders );

      return [
        ...simpleOrders,
        ...conditionalOrders,
        ...algoOrders
      ];

    } catch (e) {
      console.error(`[${this.provider}] Failed to fetch open orders`, e);
      return [];
    }
  }


  async _ensureProtectiveOrdersForTicket(ticket) {
    try {
      await this.ensureReady();
      const mappedSymbol = this._ticketToSymbol.get(ticket);
      if (!mappedSymbol) return;

      // Зчитуємо бажану конфіг
      const cfg = this._desiredProtectionByTicket.get(ticket) || {};
      let { side, amount, slPts, tpPts, tickSize } = cfg;

      // Отримаємо поточний розмір позиції та середню ціну входу
      let positions = [];
      try { positions = await this.exchange.fetchPositions(); } catch { positions = []; }
      const pos = (positions || []).find(p =>
        (p?.symbol || p?.info?.symbol || p?.info?.instId) === mappedSymbol
      );

      const rawSz = Number(
        pos?.contracts ?? pos?.positionAmt ?? pos?.size ?? pos?.info?.positionAmt ?? pos?.info?.pos ?? 0
      );
      const netSize = Number.isFinite(rawSz) ? rawSz : 0;

      // Визначимо сторону й кількість з позиції, якщо не вдалося зберегти раніше
      if (!side) side = netSize >= 0 ? 'buy' : 'sell';
      if (!Number.isFinite(amount) || amount <= 0) amount = Math.abs(netSize);

      // Якщо розміру немає — немає що захищати
      if (!Number.isFinite(amount) || amount <= 0) return;

      // Визначимо entryPrice
      let entryPrice =
        Number(pos?.entryPrice) ||
        Number(pos?.info?.entryPrice) ||
        Number(pos?.info?.avgPrice) ||
        Number(pos?.info?.avgPx) ||
        Number(pos?.info?.avg_entry_price);

      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        // Фолбек — поточний ринок
        const q = await this.getQuote(mappedSymbol);
        entryPrice = Number(q?.price);
      }
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

      // Визначимо tickSize
      const tick = Number.isFinite(Number(tickSize)) && Number(tickSize) > 0
        ? Number(tickSize)
        : this._getTickSizeFromMarket(mappedSymbol);

      // Перевіримо існування SL/TP у відкритих ордерах
      let openOrders = await this._openOrdersSym(mappedSymbol);

      const opposite = side === 'buy' ? 'sell' : 'buy';
      const hasReduce = (o) => !!(o?.reduceOnly || o?.info?.reduce_only || o?.info?.reduceOnly);
      const isOpposite = (o) => String(o?.side || '').toLowerCase() === opposite;

      let hasSL = false;
      let hasTP = false;
      for (const o of openOrders || []) {
        if (!isOpposite(o) || !hasReduce(o)) continue;
        const kind = this._classifyOrderAsSLorTP(o);
        if (kind === 'SL') hasSL = true;
        if (kind === 'TP') hasTP = true;
      }

      // Якщо сл/тп не налаштовано користувачем — не створюємо їх відповідно
      const wantSL = Number.isFinite(Number(slPts)) && Number(slPts) > 0;
      const wantTP = Number.isFinite(Number(tpPts)) && Number(tpPts) > 0;

      const needSL = wantSL && !hasSL;
      const needTP = wantTP && !hasTP;

      if (!needSL && !needTP) return;

      // Створимо відсутні (частково)
      const children = await this._placeProtectiveOrders({
        mappedSymbol,
        side,
        amount,
        entryPrice,
        slPts: needSL ? Number(slPts) : undefined,
        tpPts: needTP ? Number(tpPts) : undefined,
        tickSize: tick,
        baseParams: this.defaultParams || {}
      });

      if (children && children.length) {
        const exist = this._childOrdersByParent.get(ticket);
        const merged = exist ? Array.from(new Set([...(exist.children || []), ...children])) : children;
        this._childOrdersByParent.set(ticket, { symbol: mappedSymbol, children: merged });
      }
    } catch {
      // ignore
    }
  }

  // Скасувати всі захисні ордери (SL/TP) після виходу з позиції
  async _cancelAllProtectionForTicket(ticket) {
    try {
      await this.ensureReady();
      const mappedSymbol = this._ticketToSymbol.get(ticket);
      if (!mappedSymbol) return;

      // 1) Спробуємо відмінити ті, що ми створювали/відстежували
      try { await this._cancelChildOrders(ticket); } catch {}

      // 2) Підчистимо можливі інші reduce-only SL/TP для цього символу
      let openOrders = await this._openOrdersSym(mappedSymbol);


      const cfg = this._desiredProtectionByTicket.get(ticket) || {};
      const side = String(cfg?.side || '').toLowerCase();
      const opposite = side === 'buy' ? 'sell' : (side === 'sell' ? 'buy' : null);

      const hasReduce = (o) => !!(o?.reduceOnly || o?.info?.reduce_only || o?.info?.reduceOnly);
      for (const o of openOrders || []) {
        const isOpposite = opposite ? String(o?.side || '').toLowerCase() === opposite : true;
        if (!hasReduce(o) || !isOpposite) continue;
        const kind = this._classifyOrderAsSLorTP(o);
        if (!kind) continue;
        try {
          const oid = o?.id || o?.algoId;
          if (this.exchangeId === 'binance' && o?.algoId) {
            try {
              const nativeSymbol = this.getNativeSymbol(mappedSymbol);
              await this.exchange.fapiPrivateDeleteAlgoOpenOrders({ symbol: nativeSymbol, algoId: o.algoId });
              continue;
            } catch (e) {
              // console.log('Failed to cancel algo order via fapi, falling back to standard cancel', e);
               // fallback to standard cancel
            }
          }
          await this.exchange.cancelOrder(oid);
        } catch {
          try {
            const cid = o?.clientOrderId || o?.info?.origClientOrderId || o?.info?.clientOrderId;
            await this.exchange.cancelOrder(undefined, mappedSymbol, { origClientOrderId: cid, clientOrderId: cid });
          } catch {
            // ignore last attempt
          }
        }
      }

      // 3) Зупинимо вотчер для батьківського, якщо був
      const t = this._parentWatchers.get(ticket);
      if (t) { clearInterval(t); this._parentWatchers.delete(ticket); }

      // 4) Очистимо стани
      this._childOrdersByParent.delete(ticket);
      this._desiredProtectionByTicket.delete(ticket);
      // не видаляємо _ticketToSymbol тут: він ще може бути корисний для історії подій/логів
    } catch {
      // ignore
    }
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

      let cid = '';
      if (order?.meta?.cid) {
        cid = String(order.meta.cid).trim();
      } else if (order?.clientOrderId) {
        cid = String(order.clientOrderId).trim();
      } else if (order?.cid) {
        cid = String(order.cid).trim();
      }
      if (!cid) cid = crypto.randomBytes(6).toString('hex');
      if (!order.meta) order.meta = {};
      order.meta.cid = cid;
      if (!order.clientOrderId) {
        order.clientOrderId = cid;
      }

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
            const tickSize = Number(order.tickSize) > 0 ? Number(order.tickSize) : this._getTickSizeFromMarket(symbol);
            // console.log('entry', entry, 'slPts', slPts, 'tpPts', tpPts, 'tickSize', tickSize);
            // Збережемо бажану конфіг, щоб у разі відсутності SL/TP при вході забезпечити їх автоматично
            if (providerOrderId) {
              this._desiredProtectionByTicket.set(providerOrderId, {
                symbol,
                side,
                amount,
                slPts,
                tpPts,
                tickSize
              });
            }

            if (providerOrderId && Number.isFinite(entry)) {
              const children = await this._placeProtectiveOrders({
                mappedSymbol: symbol,
                side,
                amount,
                entryPrice: entry,
                slPts,
                tpPts,
                tickSize,
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

            // збережемо прив'язку ticket -> symbol для подальшого трекінгу позиції
            if (providerOrderId) this._ticketToSymbol.set(providerOrderId, symbol);

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

  async cancelOrder(orderId, symbol) {
    try {
      await this.ensureReady();
      const ticket = String(orderId || '').trim();
      if (!ticket) {
        return { status: 'error', provider: this.provider, reason: 'orderId required' };
      }
      const mappedSymbol = symbol ? this.mapSymbol(symbol) : undefined;
      try {
        if (this.exchangeId === 'binance' && (String(ticket).length > 20 || String(ticket).match(/^\d+$/))) {
          // Для Binance Futures algoId зазвичай довгий або числовий.
          // Спробуємо видалити як algo order, якщо не вийде - звичайним cancelOrder.
          try {
            const nativeSymbol = mappedSymbol ? this.getNativeSymbol(mappedSymbol) : undefined;
            await this.exchange.fapiPrivateDeleteAlgoOpenOrders({ symbol: nativeSymbol, algoId: ticket });
            //також пробуємо видалити звичайний ордер
            await this.exchange.cancelOrder(ticket, mappedSymbol);
          } catch (e) {
            await this.exchange.cancelOrder(ticket, mappedSymbol);
          }
        } else {
          await this.exchange.cancelOrder(ticket, mappedSymbol);
        }
      } catch (err) {
        if (mappedSymbol) {
          try {
            await this.exchange.cancelOrder(undefined, mappedSymbol, {
              origClientOrderId: ticket,
              clientOrderId: ticket
            });
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
      try { await this._cancelChildOrders(ticket); } catch {}
      const watcher = this._parentWatchers.get(ticket);
      if (watcher) {
        clearInterval(watcher);
        this._parentWatchers.delete(ticket);
      }
      this._ticketToSymbol.delete(ticket);
      return { status: 'ok', provider: this.provider };
    } catch (err) {
      return { status: 'error', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  /** @returns {Promise<any[]>} список відкритих ордерів */
  async listOpenOrders() {
    try {
      const orders = await this._openOrders();
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
  async getQuote(symbol, quoteType = 'book') {
    let normalizedSymbol;
    let endpoint = this._binanceQuoteTypeToEndpoint(quoteType);
    let ccxtSymbol;
    try {
      if (this.exchangeId === 'binance') {
        normalizedSymbol = await this.normalizeBinanceUsdmSymbol(symbol);
        ccxtSymbol = `${normalizedSymbol.slice(0, -4)}/${normalizedSymbol.slice(-4)}:USDT`;

        if (!endpoint) {
          throw new Error(`Unsupported quoteType: ${quoteType}`);
        }

        const response = await this._binancePublicRequest(endpoint, { symbol: normalizedSymbol });
        if (quoteType === 'last') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'last', price: Number(response?.price), timestamp: response?.time, raw: response };
        }
        if (quoteType === 'mark') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'mark', markPrice: Number(response?.markPrice), indexPrice: Number(response?.indexPrice), lastFundingRate: Number(response?.lastFundingRate), nextFundingTime: response?.nextFundingTime, timestamp: response?.time, raw: response };
        }

        const bid = Number(response?.bidPrice);
        const ask = Number(response?.askPrice);
        const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : undefined;
        if (quoteType === 'execution') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'execution', bid, ask, mid, suggestedBuyLimit: ask, suggestedSellLimit: bid, timestamp: response?.time, raw: response };
        }
        return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'book', bid, bidQty: Number(response?.bidQty), ask, askQty: Number(response?.askQty), mid, timestamp: response?.time, raw: response };
      }

      await this.ensureReady();
      const mapped = this.mapSymbol(symbol);
      if (!mapped || typeof this.exchange.fetchTicker !== 'function') return null;
      const t = await this.exchange.fetchTicker(mapped);
      const quote = await this._parseQuoteFromTicker(mapped, t, true);
      if (quote) this._tickerCache.set(mapped, quote);
      return quote || null;
    } catch (err) {
      console.error(`[${this.provider}] getQuote:error`, {
        provider: this.provider,
        stage: 'getQuote:error',
        symbolInput: symbol,
        normalizedSymbol,
        endpoint,
        isPublicRequest: true,
        hasTimestamp: false,
        hasSignature: false,
        ccxtSymbol,
        message: err?.message || String(err),
        name: err?.name
      });
      return null;
    }
  }

  async forgetQuote(symbol) {
    const mapped = this.mapSymbol(symbol);
    if (!mapped) return;
    this._tickerCache.delete(mapped);
    this._stopTickerTask(mapped);
  }

  async getHistoricBars({ symbol, timeframe = 'M1', limit = 50 } = {}) {
    try {
      await this.ensureReady();
      if (!symbol) return [];
      const mapped = this.mapSymbol(symbol);
      if (!mapped) return [];
      const tf = this._normalizeTimeframe(timeframe || 'M1');
      if (!tf) return [];
      const lim = Number.isFinite(Number(limit)) ? Number(limit) : 50;
      const bars = await this.exchange.fetchOHLCV(mapped, tf, undefined, lim);
      if (!Array.isArray(bars)) return [];
      return bars
        .map((b) => ({
          time: Number(b?.[0]),
          open: Number(b?.[1]),
          high: Number(b?.[2]),
          low: Number(b?.[3]),
          close: Number(b?.[4]),
          vol: Number(b?.[5])
        }))
        .filter(b => Number.isFinite(b.time));
    } catch {
      return [];
    }
  }
}

module.exports = { CCXTExecutionAdapter };

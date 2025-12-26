const { ExecutionAdapter } = require('../../brokerage/comps/base');
const fetch = require('node-fetch');

class TGExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.baseURL
   * @param {string} cfg.strategyId
   * @param {number} [cfg.timeoutMs=8000]
   * @param {Record<string,string>} [cfg.headers]
   */
  constructor({ baseURL, strategyId, timeoutMs = 8000, headers = {} } = {}) {
    super();
    if (!baseURL) throw new Error('TG adapter: baseURL is required');
    if (!strategyId) throw new Error('TG adapter: strategyId is required');

    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.strategyId = strategyId;
    this.timeoutMs = timeoutMs;
    this.headers = headers || {};
    this.provider = 'tg';
  }

  /**
   * @param {any} order
   */
  async placeOrder(order) {
    try {
      if (!order || typeof order !== 'object') {
        return { status: 'rejected', provider: this.provider, reason: 'order is required' };
      }

      const symbol = order.symbol || order.ticker;
      const typeRaw = (order.type || '').toString().toLowerCase();
      const apiType = this.#mapType(typeRaw);

      if (!apiType) {
        return { status: 'rejected', provider: this.provider, reason: `Unsupported order type: ${order.type}` };
      }
      if (!symbol) {
        return { status: 'rejected', provider: this.provider, reason: 'symbol is required' };
      }

      const body = { strategyId: this.strategyId, symbol, type: apiType };

      // For cancel/close requests we skip direction/qty requirements
      const needsDirection = apiType !== 'cancel' && apiType !== 'close';
      const direction = this.#mapDirection(order.side);
      if (needsDirection && !direction) {
        return { status: 'rejected', provider: this.provider, reason: 'side must be buy or sell' };
      }
      if (direction) body.direction = direction;

      const qty = Number(order.qty ?? order.quantity ?? order.size);
      if (needsDirection) {
        if (!Number.isFinite(qty) || qty <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'qty must be a positive number' };
        }
        body.qty = qty;
      } else if (Number.isFinite(qty) && qty > 0) {
        body.qty = qty;
      }

      const tickSize = Number(order.tickSize);
      const sl = this.#normalizePoints(order.sl, tickSize);
      const tp = this.#normalizePoints(order.tp, tickSize);
      if (Number.isFinite(sl) && sl > 0) body.sl = sl;
      if (Number.isFinite(tp) && tp > 0) body.tp = tp;

      const stopPrice = Number(order.stopPrice ?? order.stop);
      const limitPrice = Number(order.limitPrice ?? order.price);
      const entryPrice = Number(order.entryPrice ?? order.price ?? order.limitPrice);

      if ((apiType === 'limit' || apiType === 'stop limit') && (!Number.isFinite(limitPrice) || limitPrice <= 0)) {
        return { status: 'rejected', provider: this.provider, reason: 'limit price required for limit/stop limit orders' };
      }
      if ((apiType === 'stop' || apiType === 'stop limit') && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
        return { status: 'rejected', provider: this.provider, reason: 'stop price required for stop/stop limit orders' };
      }

      if (Number.isFinite(limitPrice) && limitPrice > 0) body.limit = limitPrice;
      if (Number.isFinite(stopPrice) && stopPrice > 0) body.stop = stopPrice;
      if (Number.isFinite(entryPrice) && entryPrice > 0) body.entryPrice = entryPrice;

      const note = order.note || order.comment || order.meta?.note;
      if (note) body.note = String(note);

      const res = await this.#post('/strategies/trade', body);
      const { response, data, text } = res;
      const raw = data ?? text;
      const statusToken = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
      const success = response.ok && (!statusToken || ['ok', 'success', 'accepted', 'done'].includes(statusToken));
      const providerOrderId = data?.orderId ?? data?.id ?? data?.data?.orderId ?? data?.data?.id;

      if (success) {
        return {
          status: 'ok',
          provider: this.provider,
          providerOrderId: providerOrderId ? String(providerOrderId) : undefined,
          raw,
        };
      }

      const reason = data?.message || data?.error || data?.reason || `${response.status} ${response.statusText}` || 'Unknown error';
      return { status: 'rejected', provider: this.provider, reason, raw };
    } catch (err) {
      return {
        status: 'rejected',
        provider: this.provider,
        reason: err?.message || String(err),
      };
    }
  }

  async cancelOrder(idOrSymbol) {
    const symbol = typeof idOrSymbol === 'string' ? idOrSymbol : (idOrSymbol?.symbol || idOrSymbol?.id || idOrSymbol?.orderId);
    return this.placeOrder({ type: 'cancel', symbol });
  }

  async closePosition(symbol) {
    return this.placeOrder({ type: 'close', symbol });
  }

  async getQuote(symbol) {
    const s = String(symbol || '').trim();
    if (!s) return null;

    const url = `${this.baseURL}/strategies/quote?symbol=${encodeURIComponent(s)}&strategyId=${encodeURIComponent(this.strategyId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { ...this.headers };

    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return null;

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {}
      const payload = data?.data ?? data ?? {};

      const bid = Number(payload.bid);
      const ask = Number(payload.ask);
      const tickSize = Number(payload.tickSize ?? payload.tick ?? payload.point ?? payload.step);

      let price = Number(payload.price ?? payload.last ?? payload.mid);
      if (!Number.isFinite(price)) {
        if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
        else if (Number.isFinite(bid)) price = bid;
        else if (Number.isFinite(ask)) price = ask;
      }

      if (!Number.isFinite(price)) return null;
      return {
        bid: Number.isFinite(bid) ? bid : undefined,
        ask: Number.isFinite(ask) ? ask : undefined,
        price,
        tickSize: Number.isFinite(tickSize) ? tickSize : undefined,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  }

  #mapDirection(side) {
    const s = (side || '').toString().toLowerCase();
    if (s === 'buy') return 'long';
    if (s === 'sell') return 'short';
    return '';
  }

  #mapType(type) {
    const t = (type || '').toString().replace(/\s+/g, '').toLowerCase();
    if (t === 'market') return 'market';
    if (t === 'limit') return 'limit';
    if (t === 'stop') return 'stop';
    if (t === 'stoplimit' || t === 'stop_limit' || t === 'stop-limit') return 'stop limit';
    if (t === 'cancel') return 'cancel';
    if (t === 'close') return 'close';
    return '';
  }

  #normalizePoints(value, tickSize) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === 0) return undefined;
    const tick = Number(tickSize);
    if (Number.isFinite(tick) && tick > 0) return v * tick;
    return v;
  }

  async #post(path, body) {
    const url = `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'Content-Type': 'application/json', ...this.headers };

    console.log(`[Adapter:${this.provider}] POST ${url}`, body);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {}
      return { response, data, text };
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      throw err;
    }
  }
}

module.exports = { TGExecutionAdapter };

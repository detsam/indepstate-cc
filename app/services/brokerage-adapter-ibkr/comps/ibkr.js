// services/brokerage-adapter-ibkr/comps/ibkr.js
// Interactive Brokers adapter using the TWS / IB Gateway socket API.
const { EventEmitter } = require('events');
const { ExecutionAdapter } = require('../../brokerage/comps/base');

const DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'paper',
  host: '127.0.0.1',
  port: 4002,
  clientId: 12,
  accountId: '',
  defaultTif: 'DAY',
  autoConnect: true,
});

const SENSITIVE_KEY_RE = /(?:token|secret|password|credential|key)$/i;
const FINAL_CANCEL_STATUSES = new Set(['Cancelled', 'ApiCancelled']);
const ACCEPTED_STATUSES = new Set(['PendingSubmit', 'PreSubmitted', 'Submitted', 'Filled']);
const REJECTED_STATUSES = new Set(['Inactive', 'ApiCancelled', 'Cancelled']);

function normalizeString(value) {
  return value == null ? '' : String(value).trim();
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeClone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeClone);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : safeClone(val);
  }
  return out;
}

function safeContractSummary(contract = {}) {
  const out = {};
  for (const key of ['conId', 'symbol', 'secType', 'exchange', 'currency', 'primaryExchange', 'localSymbol', 'tradingClass']) {
    if (contract[key] !== undefined && contract[key] !== '') out[key] = contract[key];
  }
  return out;
}

function createContextError(message, context = {}) {
  const safeContext = safeClone(context);
  const err = new Error(`${message}${Object.keys(safeContext).length ? ` (${JSON.stringify(safeContext)})` : ''}`);
  err.context = safeContext;
  return err;
}

function validateConfig(input = {}) {
  const cfg = { ...DEFAULTS, ...input };
  const errors = [];
  if (typeof cfg.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (!['paper', 'live'].includes(String(cfg.mode))) errors.push('mode must be "paper" or "live"');
  if (!normalizeString(cfg.host)) errors.push('host is required');
  if (!Number.isInteger(Number(cfg.port)) || Number(cfg.port) <= 0 || Number(cfg.port) > 65535) errors.push('port must be an integer from 1 to 65535');
  if (!Number.isInteger(Number(cfg.clientId)) || Number(cfg.clientId) < 0) errors.push('clientId must be a non-negative integer');
  if (!normalizeString(cfg.defaultTif)) errors.push('defaultTif is required');
  if (cfg.instruments != null && (typeof cfg.instruments !== 'object' || Array.isArray(cfg.instruments))) errors.push('instruments must be an object keyed by app symbol');
  return { ok: errors.length === 0, errors, config: cfg };
}

function validateContract(symbol, contract) {
  if (!contract || typeof contract !== 'object') return `IBKR contract mapping missing for ${symbol}`;
  if (contract.conId != null && Number.isInteger(Number(contract.conId)) && Number(contract.conId) > 0) return '';
  for (const key of ['symbol', 'secType', 'exchange', 'currency']) {
    if (!normalizeString(contract[key])) return `IBKR contract for ${symbol} requires ${key} when conId is not provided`;
  }
  const secType = normalizeString(contract.secType).toUpperCase();
  const currency = normalizeString(contract.currency).toUpperCase();
  const exchange = normalizeString(contract.exchange).toUpperCase();
  if (secType === 'STK' && currency === 'USD' && exchange === 'SMART' && !normalizeString(contract.primaryExchange)) {
    return `IBKR SMART-routed US stock contract for ${symbol} requires primaryExchange to avoid ambiguity`;
  }
  return '';
}

function normalizeContract(contract) {
  const out = {};
  for (const [key, value] of Object.entries(contract || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = key === 'conId' ? Number(value) : value;
  }
  return out;
}

function normalizeAction(side) {
  const s = normalizeString(side).toUpperCase();
  if (s === 'BUY' || s === 'SELL') return s;
  if (s === 'BUYTOCOVER') return 'BUY';
  return '';
}

function normalizeOrderType(type) {
  const t = normalizeString(type || 'market').toUpperCase();
  if (t === 'MARKET') return 'MKT';
  if (t === 'LIMIT') return 'LMT';
  if (t === 'MKT' || t === 'LMT') return t;
  return '';
}

function getClientOrderId(order = {}) {
  return normalizeString(order?.meta?.cid) || normalizeString(order.clientOrderId) || normalizeString(order.cid) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildAbsoluteProtection(order, action) {
  const meta = order?.meta?.ibkr || order?.ibkr || {};
  const explicitTp = positiveNumber(meta.takeProfitPrice ?? meta.tpPrice ?? order.takeProfitPrice);
  const explicitSl = positiveNumber(meta.stopLossPrice ?? meta.slPrice ?? order.stopLossPrice);
  if (explicitTp && explicitSl) return { requested: true, takeProfitPrice: explicitTp, stopLossPrice: explicitSl };

  const tpDistance = positiveNumber(order.tp);
  const slDistance = positiveNumber(order.sl);
  const requested = Boolean(tpDistance || slDistance || meta.bracket === true || meta.protective === true);
  if (!requested) return { requested: false };
  if (!tpDistance || !slDistance) return { requested: true, error: 'Both tp and sl distances are required for an IBKR bracket order' };
  const price = positiveNumber(order.price ?? meta.entryPrice);
  const tickSize = positiveNumber(order.tickSize ?? meta.tickSize);
  if (!price || !tickSize) return { requested: true, error: 'price and tickSize are required to derive IBKR bracket TP/SL prices from tp/sl distances' };
  const takeProfitPrice = action === 'BUY' ? price + tpDistance * tickSize : price - tpDistance * tickSize;
  const stopLossPrice = action === 'BUY' ? price - slDistance * tickSize : price + slDistance * tickSize;
  if (!(takeProfitPrice > 0) || !(stopLossPrice > 0)) return { requested: true, error: 'derived IBKR bracket TP/SL prices must be positive' };
  return { requested: true, takeProfitPrice, stopLossPrice };
}

function buildOrderRequests(order, contract, cfg, allocateId) {
  const action = normalizeAction(order.side || order.action);
  if (!action) throw createContextError('IBKR supports only BUY/SELL actions', { adapter: 'ibkr', symbol: order.symbol, side: order.side });
  const orderType = normalizeOrderType(order.type || order.orderType);
  if (!orderType) throw createContextError('Unsupported IBKR order type', { adapter: 'ibkr', symbol: order.symbol, orderType: order.type || order.orderType });
  const quantity = positiveNumber(order.qty ?? order.quantity);
  if (!quantity) throw createContextError('IBKR order quantity must be positive', { adapter: 'ibkr', symbol: order.symbol });
  if (orderType === 'LMT' && !positiveNumber(order.price ?? order.limitPrice)) {
    throw createContextError('IBKR limit order requires a positive limit price', { adapter: 'ibkr', symbol: order.symbol, orderType });
  }

  const parentId = allocateId();
  const tif = normalizeString(order.tif || order.timeInForce || cfg.defaultTif);
  const baseOrder = {
    orderId: parentId,
    action,
    orderType,
    totalQuantity: quantity,
    tif,
    account: cfg.accountId,
  };
  if (orderType === 'LMT') baseOrder.lmtPrice = Number(order.price ?? order.limitPrice);

  const protection = buildAbsoluteProtection(order, action);
  if (!protection.requested) {
    return [{ orderId: parentId, contract, order: { ...baseOrder, transmit: true }, role: 'parent' }];
  }
  if (protection.error) throw createContextError(protection.error, { adapter: 'ibkr', symbol: order.symbol, contract: safeContractSummary(contract), orderType });

  const takeProfitId = allocateId();
  const stopLossId = allocateId();
  const childAction = action === 'BUY' ? 'SELL' : 'BUY';
  return [
    { orderId: parentId, contract, order: { ...baseOrder, transmit: false }, role: 'parent' },
    {
      orderId: takeProfitId,
      contract,
      role: 'takeProfit',
      order: { orderId: takeProfitId, action: childAction, orderType: 'LMT', totalQuantity: quantity, lmtPrice: protection.takeProfitPrice, parentId, tif, account: cfg.accountId, transmit: false },
    },
    {
      orderId: stopLossId,
      contract,
      role: 'stopLoss',
      order: { orderId: stopLossId, action: childAction, orderType: 'STP', totalQuantity: quantity, auxPrice: protection.stopLossPrice, parentId, tif, account: cfg.accountId, transmit: true },
    },
  ];
}

function loadStoqeyClientFactory() {
  // Optional runtime dependency. Kept lazy so the disabled adapter and tests cannot trade accidentally.
  // Selected because @stoqey/ib implements the TWS/IB Gateway socket protocol directly in Node.
  // IBKR does not officially support third-party Node packages; operators must install and validate it.
  const mod = require('@stoqey/ib');
  const EventName = mod.EventName || {};
  return {
    eventNames: {
      error: EventName.error || 'error',
      nextValidId: EventName.nextValidId || 'nextValidId',
      managedAccounts: EventName.managedAccounts || 'managedAccounts',
      openOrder: EventName.openOrder || 'openOrder',
      orderStatus: EventName.orderStatus || 'orderStatus',
      execDetails: EventName.execDetails || 'execDetails',
      connectionClosed: EventName.connectionClosed || 'connectionClosed',
    },
    create(config) {
      return new mod.IBApi({ host: config.host, port: Number(config.port), clientId: Number(config.clientId) });
    },
  };
}

class IBKRAdapter extends ExecutionAdapter {
  constructor(cfg = {}, providerName = 'ibkr') {
    super();
    this.provider = providerName;
    const validation = validateConfig(cfg);
    if (!validation.ok) throw new Error(`IBKR config invalid: ${validation.errors.join('; ')}`);
    this.cfg = validation.config;
    this.cfg.port = Number(this.cfg.port);
    this.cfg.clientId = Number(this.cfg.clientId);
    this.cfg.accountId = normalizeString(this.cfg.accountId);
    this.cfg.defaultTif = normalizeString(this.cfg.defaultTif).toUpperCase();
    this.cfg.instruments = this.cfg.instruments || {};
    this.events = new EventEmitter();
    this.client = null;
    this.eventNames = null;
    this.connected = false;
    this.managedAccounts = [];
    this.selectedAccount = '';
    this.nextOrderId = null;
    this.maxObservedOrderId = 0;
    this.pending = new Map();
    this.cancels = new Map();
    this.orderStatus = new Map();
    this.logs = [];

    if (this.cfg.enabled && this.cfg.autoConnect !== false) this.connect().catch(err => this.#log('error', 'connect failed', { error: err.message }));
  }

  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  #log(level, message, context = {}) {
    const entry = { level, message, ...safeClone(context) };
    this.logs.push(entry);
    const logger = level === 'error' ? console.error : console.log;
    logger('[IBKR]', entry);
  }

  async connect() {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider };
    if (!this.client) {
      const factory = this.cfg.clientFactory || loadStoqeyClientFactory();
      this.eventNames = factory.eventNames || {};
      this.client = factory.create(this.cfg);
      this.#wireClient();
    }
    this.#log('info', 'connecting', { provider: this.provider, mode: this.cfg.mode, host: this.cfg.host, port: this.cfg.port, clientId: this.cfg.clientId });
    if (typeof this.client.connect === 'function') this.client.connect();
    if (typeof this.client.reqManagedAccts === 'function') this.client.reqManagedAccts();
    if (typeof this.client.reqIds === 'function') this.client.reqIds(-1);
    if (typeof this.client.reqOpenOrders === 'function') this.client.reqOpenOrders();
    return { status: 'connecting', provider: this.provider };
  }

  disconnect() {
    if (this.client && typeof this.client.disconnect === 'function') this.client.disconnect();
    this.connected = false;
  }

  isReady() {
    return Boolean(this.cfg.enabled && this.connected && this.selectedAccount && Number.isInteger(this.nextOrderId));
  }

  readinessReason() {
    if (!this.cfg.enabled) return 'IBKR adapter is disabled';
    if (!this.connected) return 'IB Gateway/TWS is not connected or API access is not ready';
    if (!this.selectedAccount) return 'IBKR account is not selected from managed accounts';
    if (!Number.isInteger(this.nextOrderId)) return 'IBKR nextValidId has not been received';
    return '';
  }

  #eventName(name) { return this.eventNames?.[name] || name; }

  #wireClient() {
    const on = (name, handler) => {
      if (this.client && typeof this.client.on === 'function') this.client.on(this.#eventName(name), handler);
    };
    on('nextValidId', orderId => this.#handleNextValidId(orderId));
    on('managedAccounts', accounts => this.#handleManagedAccounts(accounts));
    on('openOrder', (orderId, contract, order, orderState) => this.#handleOpenOrder(orderId, contract, order, orderState));
    on('orderStatus', (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => this.#handleOrderStatus(orderId, status, { filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld }));
    on('execDetails', (reqId, contract, execution) => this.#log('info', 'execution details', { provider: this.provider, reqId, orderId: execution?.orderId, symbol: contract?.symbol }));
    on('connectionClosed', () => this.#handleDisconnected('connectionClosed'));
    on('error', (err, code, reqId) => this.#handleIbError(err, code, reqId));
    if (typeof this.client.once === 'function') {
      this.client.once('connect', () => { this.connected = true; this.#log('info', 'socket connected', { provider: this.provider }); });
    }
  }

  #handleNextValidId(orderId) {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id < 0) return;
    this.connected = true;
    this.nextOrderId = Math.max(id, this.maxObservedOrderId + 1);
    this.#log('info', 'nextValidId received', { provider: this.provider, nextOrderId: this.nextOrderId, maxObservedOrderId: this.maxObservedOrderId });
  }

  #handleManagedAccounts(accounts) {
    const list = Array.isArray(accounts) ? accounts : String(accounts || '').split(',');
    this.managedAccounts = list.map(normalizeString).filter(Boolean);
    if (this.cfg.accountId) {
      this.selectedAccount = this.managedAccounts.includes(this.cfg.accountId) ? this.cfg.accountId : '';
    } else if (this.managedAccounts.length === 1) {
      this.selectedAccount = this.managedAccounts[0];
      this.cfg.accountId = this.selectedAccount;
    } else {
      this.selectedAccount = '';
    }
    this.connected = true;
    this.#log(this.selectedAccount ? 'info' : 'error', 'managed accounts received', { provider: this.provider, selectedAccount: this.selectedAccount || '(none)', accountCount: this.managedAccounts.length });
  }

  #observeOrderId(orderId) {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id < 0) return;
    this.maxObservedOrderId = Math.max(this.maxObservedOrderId, id);
    if (Number.isInteger(this.nextOrderId) && this.nextOrderId <= this.maxObservedOrderId) this.nextOrderId = this.maxObservedOrderId + 1;
  }

  #handleOpenOrder(orderId, contract, order, orderState) {
    this.#observeOrderId(orderId);
    this.#log('info', 'openOrder', { provider: this.provider, orderId, status: orderState?.status, symbol: contract?.symbol, contract: safeContractSummary(contract) });
  }

  #handleOrderStatus(orderId, status, details = {}) {
    this.#observeOrderId(orderId);
    const s = normalizeString(status);
    this.orderStatus.set(String(orderId), { status: s, ...details });
    this.#log('info', 'orderStatus', { provider: this.provider, orderId, status: s, remaining: details.remaining, filled: details.filled });

    const pending = this.pending.get(String(orderId));
    if (pending) {
      if (ACCEPTED_STATUSES.has(s)) this.#confirmPending(String(orderId), orderId, { status: s, details });
      if (REJECTED_STATUSES.has(s)) this.#rejectPending(String(orderId), `IBKR order ${s}`, { status: s, details });
    }

    const cancel = this.cancels.get(String(orderId));
    if (cancel && FINAL_CANCEL_STATUSES.has(s)) {
      clearTimeout(cancel.timer);
      this.cancels.delete(String(orderId));
      this.events.emit('order:cancelled', { ticket: String(orderId) });
      cancel.resolve({ status: 'ok', provider: this.provider, providerOrderId: String(orderId), raw: { status: s } });
    }
  }

  #handleDisconnected(reason) {
    this.connected = false;
    this.nextOrderId = null;
    this.#log('error', 'disconnected', { provider: this.provider, reason });
  }

  #handleIbError(err, code, reqId) {
    const message = err?.message || String(err || 'IBKR API error');
    const mapped = createContextError('IBKR API error', { adapter: 'ibkr', code, reqId, message });
    this.#log('error', 'api error', { provider: this.provider, code, reqId, message: mapped.message });
    const key = String(reqId);
    if (this.pending.has(key)) this.#rejectPending(key, mapped.message, { code, reqId });
  }

  allocateOrderId() {
    const reason = this.readinessReason();
    if (reason) throw createContextError(reason, { adapter: 'ibkr', phase: 'allocateOrderId' });
    const id = Math.max(Number(this.nextOrderId), this.maxObservedOrderId + 1);
    this.nextOrderId = id + 1;
    this.maxObservedOrderId = Math.max(this.maxObservedOrderId, id);
    return id;
  }

  getContractForSymbol(symbol) {
    const key = normalizeString(symbol);
    const contractCfg = this.cfg.instruments[key];
    const reason = validateContract(key, contractCfg);
    if (reason) throw createContextError(reason, { adapter: 'ibkr', symbol: key });
    return normalizeContract(contractCfg);
  }

  buildOrderRequests(order) {
    const contract = this.getContractForSymbol(order?.symbol);
    return buildOrderRequests(order, contract, this.cfg, () => this.allocateOrderId());
  }

  async placeOrder(order) {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider, reason: 'IBKR adapter is disabled' };
    const reason = this.readinessReason();
    if (reason) return { status: 'rejected', provider: this.provider, reason };
    let cid = getClientOrderId(order);
    if (!order.meta) order.meta = {};
    order.meta.cid = cid;

    try {
      const requests = this.buildOrderRequests(order);
      for (const req of requests) this.pending.set(String(req.orderId), { cid, order, request: safeClone(req), createdAt: Date.now() });
      this.#log('info', 'placing order', { provider: this.provider, symbol: order.symbol, cid, orderIds: requests.map(r => r.orderId), contract: safeContractSummary(requests[0].contract), orderType: requests[0].order.orderType });
      for (const req of requests) {
        this.client.placeOrder(req.orderId, req.contract, req.order);
      }
      return { status: 'ok', provider: this.provider, providerOrderId: `pending:${cid}`, raw: { orderIds: requests.map(r => r.orderId), bracket: requests.length === 3 } };
    } catch (err) {
      this.#log('error', 'order rejected before send', { provider: this.provider, symbol: order?.symbol, cid, reason: err.message });
      return { status: 'rejected', provider: this.provider, reason: err.message, raw: { context: err.context } };
    }
  }

  #confirmPending(orderId, ticket, raw) {
    const rec = this.pending.get(orderId);
    if (!rec) return;
    this.pending.delete(orderId);
    this.events.emit('order:confirmed', { pendingId: rec.cid, ticket: String(ticket), mtOrder: raw, origOrder: rec.order });
  }

  #rejectPending(orderId, reason, raw) {
    const rec = this.pending.get(orderId);
    if (!rec) return;
    this.pending.delete(orderId);
    this.events.emit('order:rejected', { pendingId: rec.cid, reason, msg: reason, raw, origOrder: rec.order });
  }

  async cancelOrder(orderId) {
    if (!this.cfg.enabled) return { status: 'disabled', provider: this.provider, reason: 'IBKR adapter is disabled' };
    const reason = this.readinessReason();
    if (reason) return { status: 'error', provider: this.provider, reason };
    const ticket = normalizeString(orderId).replace(/^pending:/, '');
    if (!/^\d+$/.test(ticket)) return { status: 'error', provider: this.provider, reason: 'IBKR cancelOrder requires numeric order ID' };
    this.#log('info', 'cancel requested', { provider: this.provider, orderId: ticket });
    this.client.cancelOrder(Number(ticket));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.cancels.delete(ticket);
        resolve({ status: 'pending', provider: this.provider, providerOrderId: ticket, reason: 'IBKR cancel request sent; awaiting orderStatus cancellation confirmation' });
      }, Number(this.cfg.cancelConfirmTimeoutMs || 5000));
      this.cancels.set(ticket, { resolve, timer });
    });
  }
}

module.exports = {
  IBKRAdapter,
  validateConfig,
  validateContract,
  buildOrderRequests,
  safeClone,
  safeContractSummary,
};

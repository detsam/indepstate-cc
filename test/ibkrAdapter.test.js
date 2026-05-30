const assert = require('assert');
const { EventEmitter } = require('events');
const {
  IBKRAdapter,
  validateConfig,
  validateContract,
  safeClone,
} = require('../app/services/brokerage-adapter-ibkr/comps/ibkr');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.placed = [];
    this.cancels = [];
    this.connected = false;
    this.marketDataTypes = [];
    this.marketDataRequests = [];
    this.cancelledMarketData = [];
  }
  connect() { this.connected = true; this.emit('connect'); }
  reqManagedAccts() {}
  reqIds() {}
  reqOpenOrders() {}
  reqMarketDataType(type) { this.marketDataTypes.push(type); }
  reqMktData(reqId, contract, genericTickList, snapshot, regulatorySnapshot, options) {
    this.marketDataRequests.push({ reqId, contract, genericTickList, snapshot, regulatorySnapshot, options });
  }
  cancelMktData(reqId) { this.cancelledMarketData.push(reqId); }
  placeOrder(orderId, contract, order) { this.placed.push({ orderId, contract, order }); }
  cancelOrder(orderId) { this.cancels.push(orderId); }
}

function makeAdapter(overrides = {}) {
  const client = new FakeClient();
  const adapter = new IBKRAdapter({
    enabled: true,
    autoConnect: false,
    mode: 'paper',
    host: '127.0.0.1',
    port: 4002,
    clientId: 12,
    accountId: 'DU123',
    defaultTif: 'DAY',
    instruments: {
      AAPL: { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ', tickSize: 0.01 },
    },
    clientFactory: { create: () => client, eventNames: {} },
    ...overrides,
  }, 'ibkr');
  adapter.connect();
  return { adapter, client };
}

function ready(adapter, client, nextId = 100) {
  client.emit('managedAccounts', 'DU123');
  client.emit('nextValidId', nextId);
  assert.strictEqual(adapter.isReady(), true);
}

(async () => {
  {
    const valid = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY' });
    assert.strictEqual(valid.ok, true);
    const invalid = validateConfig({ enabled: 'yes', host: '', port: 99999, clientId: -1, mode: 'demo', defaultTif: '' });
    assert.strictEqual(invalid.ok, false);
    assert(invalid.errors.length >= 5);
  }

  {
    const adapter = new IBKRAdapter({ enabled: false, autoConnect: false }, 'ibkr');
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 });
    assert.strictEqual(res.status, 'disabled');
  }

  {
    const { adapter } = makeAdapter();
    const missing = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 });
    assert.strictEqual(missing.status, 'rejected');
    assert.match(missing.reason, /account|nextValidId|not connected|not ready/i);
  }

  {
    assert.strictEqual(validateContract('MSFT', null), 'IBKR contract mapping missing for MSFT');
    assert.match(validateContract('MSFT', { symbol: 'MSFT', secType: 'STK', exchange: 'SMART', currency: 'USD' }), /primaryExchange/);
    assert.strictEqual(validateContract('MSFT', { conId: 123 }), '');
  }



  {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote('AAPL');
    assert.strictEqual(quote, null);
    assert(adapter.logs.some(entry => entry.message === 'quote unavailable: adapter not ready'));
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 90);
    const quote = await adapter.getQuote('MSFT');
    assert.strictEqual(quote, null);
    assert(adapter.logs.some(entry => entry.message === 'quote unavailable: contract mapping invalid' && /contract mapping missing/i.test(entry.reason)));
  }

  {
    const { adapter, client } = makeAdapter({ marketDataType: 3 });
    ready(adapter, client, 91);
    const promise = adapter.getQuote('AAPL');
    assert.strictEqual(client.marketDataTypes[0], 3);
    assert.strictEqual(client.marketDataRequests.length, 1);
    assert.strictEqual(client.marketDataRequests[0].contract.conId, 265598);
    assert.strictEqual(client.marketDataRequests[0].snapshot, false);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 1, 100);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 2, 101);
    const quote = await promise;
    assert.strictEqual(quote.price, 100.5);
    assert.strictEqual(quote.bid, 100);
    assert.strictEqual(quote.ask, 101);
    assert.strictEqual(quote.tickSize, 0.01);
    assert.strictEqual(quote.tickSource, 'ibkr');
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 92);
    const promise = adapter.getQuote('AAPL');
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 4, 102.25);
    const quote = await promise;
    assert.strictEqual(quote.price, 102.25);
    assert.strictEqual(quote.last, 102.25);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 93);
    const promise = adapter.getQuote('AAPL');
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 9, 99.75);
    const quote = await promise;
    assert.strictEqual(quote.price, 99.75);
    assert.strictEqual(quote.close, 99.75);
  }

  {
    const { adapter, client } = makeAdapter({ quoteTimeoutMs: 20 });
    ready(adapter, client, 94);
    const quote = await adapter.getQuote('AAPL');
    assert.strictEqual(quote, null);
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
    assert(adapter.logs.some(entry => entry.message === 'quote timeout'));
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 95);
    const promise = adapter.getQuote('AAPL');
    client.emit('error', new Error('No market data permissions'), 354, client.marketDataRequests[0].reqId);
    const quote = await promise;
    assert.strictEqual(quote, null);
    assert(adapter.logs.some(entry => entry.message === 'market data permission error'));
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 100);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 5, clientOrderId: 'cid-mkt' });
    assert.strictEqual(res.status, 'ok');
    assert.deepStrictEqual(res.raw.orderIds, [100]);
    assert.strictEqual(client.placed.length, 1);
    assert.strictEqual(client.placed[0].order.orderType, 'MKT');
    assert.strictEqual(client.placed[0].order.action, 'BUY');
    assert.strictEqual(client.placed[0].order.totalQuantity, 5);
    assert.strictEqual(client.placed[0].order.transmit, true);
    assert.strictEqual(client.placed[0].order.account, 'DU123');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 200);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'sell', type: 'limit', qty: 2, price: 191.25, tif: 'GTC', clientOrderId: 'cid-lmt' });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(client.placed[0].order.orderType, 'LMT');
    assert.strictEqual(client.placed[0].order.action, 'SELL');
    assert.strictEqual(client.placed[0].order.lmtPrice, 191.25);
    assert.strictEqual(client.placed[0].order.tif, 'GTC');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 300);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'stop', qty: 1, price: 10 });
    assert.strictEqual(res.status, 'rejected');
    assert.match(res.reason, /Unsupported IBKR order type/);
    assert.strictEqual(client.placed.length, 0);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 400);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, price: 100, tickSize: 0.01, tp: 250, sl: 100, clientOrderId: 'cid-bracket' });
    assert.strictEqual(res.status, 'ok');
    assert.deepStrictEqual(res.raw.orderIds, [400, 401, 402]);
    assert.strictEqual(client.placed.length, 3);
    assert.strictEqual(client.placed[0].order.transmit, false);
    assert.strictEqual(client.placed[1].order.orderType, 'LMT');
    assert.strictEqual(client.placed[1].order.parentId, 400);
    assert.strictEqual(client.placed[1].order.lmtPrice, 102.5);
    assert.strictEqual(client.placed[1].order.transmit, false);
    assert.strictEqual(client.placed[2].order.orderType, 'STP');
    assert.strictEqual(client.placed[2].order.auxPrice, 99);
    assert.strictEqual(client.placed[2].order.parentId, 400);
    assert.strictEqual(client.placed[2].order.transmit, true);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 500);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, price: 100, tickSize: 0.01, tp: 250, clientOrderId: 'cid-bad-bracket' });
    assert.strictEqual(res.status, 'rejected');
    assert.match(res.reason, /Both tp and sl/);
    assert.strictEqual(client.placed.length, 0);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 10);
    client.emit('openOrder', 25, { symbol: 'AAPL' }, {}, { status: 'Submitted' });
    assert.strictEqual(adapter.allocateOrderId(), 26);
  }

  {
    const { adapter, client } = makeAdapter({ cancelConfirmTimeoutMs: 1000 });
    ready(adapter, client, 700);
    const p = adapter.cancelOrder('42');
    assert.deepStrictEqual(client.cancels, [42]);
    client.emit('orderStatus', 42, 'Cancelled', 0, 1);
    const res = await p;
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.providerOrderId, '42');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 800);
    let rejected;
    adapter.on('order:rejected', evt => { rejected = evt; });
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1, clientOrderId: 'cid-error' });
    assert.strictEqual(res.status, 'ok');
    client.emit('error', new Error('Order rejected by IB'), 201, 800);
    assert(rejected);
    assert.match(rejected.reason, /IBKR API error/);
  }

  {
    const sanitized = safeClone({ token: 'abc', nested: { apiKey: 'secret', value: 1 }, password: 'pw' });
    assert.strictEqual(sanitized.token, '[redacted]');
    assert.strictEqual(sanitized.nested.apiKey, '[redacted]');
    assert.strictEqual(sanitized.password, '[redacted]');
    assert.strictEqual(sanitized.nested.value, 1);
  }

  console.log('ibkrAdapter tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

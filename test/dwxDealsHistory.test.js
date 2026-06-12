const assert = require('assert');
const { EventEmitter } = require('events');
const {
  DWXAdapter,
  calculateLookbackDays,
  filterDwxDeals,
  parseDealTime
} = require('../app/services/brokerage-adapter-dwx/comps/dwx');

async function run() {
  assert.strictEqual(
    parseDealTime('2026.06.10 12:34:56'),
    new Date(2026, 5, 10, 12, 34, 56).getTime()
  );
  assert.strictEqual(
    calculateLookbackDays(new Date('2026-06-10T00:00:00.000Z'), new Date('2026-06-12T00:00:01.000Z')),
    3
  );

  const trades = {
    1: {
      ticket: '1',
      magic: 42,
      symbol: 'EURUSD',
      lots: '0.10',
      type: 'buy',
      entry: 'in',
      deal_time: '2026.06.10 12:00:00',
      deal_price: '1.1000',
      pnl: '0',
      commission: '-1.2',
      swap: '0',
      comment: 'alpha setup'
    },
    2: {
      ticket: '2',
      magic: 42,
      symbol: 'EURUSD',
      lots: '0.10',
      type: 'sell',
      entry: 'out',
      deal_time: '2026.06.11 12:00:00',
      price: '1.1200',
      profit: '25.5',
      comment: 'alpha close'
    },
    3: {
      ticket: '3',
      magic: 7,
      symbol: 'GBPUSD',
      type: 'buy',
      entry: 'out',
      deal_time: '2026.06.11 13:00:00',
      comment: 'beta close'
    }
  };

  const filtered = filterDwxDeals(trades, {
    from: new Date(2026, 5, 11, 0, 0, 0),
    to: new Date(2026, 5, 12, 0, 0, 0),
    filters: {
      symbol: 'eurusd',
      magic: '42',
      type: 'sell',
      entry: 'out',
      commentContains: 'ALPHA'
    }
  });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].ticket, '2');
  assert.strictEqual(filtered[0].dealPrice, 1.12);
  assert.strictEqual(filtered[0].pnl, 25.5);
  assert.strictEqual(filtered[0].raw, trades[2]);

  const events = new EventEmitter();
  const requestedLookbacks = [];
  const fakeAdapter = Object.create(DWXAdapter.prototype);
  fakeAdapter.events = events;
  fakeAdapter.client = {
    historic_trades: trades,
    get_historic_trades(days) {
      requestedLookbacks.push(days);
      setImmediate(() => events.emit('dwx:historic_trades'));
    }
  };
  fakeAdapter._historicTradesRequestChain = Promise.resolve();

  const result = await fakeAdapter.getDealsHistory({
    from: new Date(2026, 5, 10, 0, 0, 0),
    to: new Date(2026, 5, 10, 23, 59, 59),
    filters: { symbol: 'EURUSD', entry: 'in' },
    timeoutMs: 100
  });
  assert.deepStrictEqual(requestedLookbacks, [calculateLookbackDays(new Date(2026, 5, 10, 0, 0, 0), new Date())]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].ticket, '1');

  console.log('dwx deals history tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

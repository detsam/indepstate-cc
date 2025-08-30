const assert = require('assert');
const fs = require('fs');
const path = require('path');
const events = require('../app/services/events');
const { PendingOrderHub } = require('../app/services/pendingOrders');

const logsDir = path.join(__dirname, '..', 'app', 'logs');
const execLog = path.join(logsDir, 'executions.jsonl');
fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(execLog, '');

async function run() {
  let placed;
  const hub = new PendingOrderHub({
    queuePlaceOrder: async (o) => {
      await Promise.resolve();
      placed = o;
    },
    subscribe: () => {},
    wireAdapter: () => {},
    getAdapter: () => ({})
  });

  hub.queuePlacePending({
    ticker: 'TEST',
    price: 100,
    side: 'long',
    instrumentType: 'EQ',
    tickSize: 1,
    meta: { qty: 100, riskUsd: 10 }
  });

  const bars = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 },
    { open: 100.5, high: 101, low: 100.1, close: 100.9 }
  ];
  bars.forEach(b => events.emit('bar', { provider: 'dwx', symbol: 'TEST', tf: 'M1', ...b }));
  await new Promise(r => setTimeout(r, 0));

  assert.ok(placed, 'order was not sent for execution');
  assert.strictEqual(placed.side, 'buy');
  assert.strictEqual(placed.type, 'limit');
  assert.strictEqual(placed.price, 101);
  assert.strictEqual(placed.qty, 1);
  assert.strictEqual(placed.sl, 6);
  assert.strictEqual(placed.meta.stopPts, 6);
  assert.strictEqual(placed.tp, 18);
  assert.strictEqual(placed.meta.takePts, 18);

  // strategy providing takeProfit and tickSize requiring conversion
  placed = undefined;
  const hub2 = new PendingOrderHub({
    queuePlaceOrder: async (o) => { placed = o; },
    subscribe: () => {},
    wireAdapter: () => {},
    getAdapter: () => ({}),
    strategies: {
      stub: class {
        constructor() { this.done = false; }
        onBar() {
          if (this.done) return null;
          this.done = true;
          return { limitPrice: 101, stopLoss: 99, takeProfit: 105 };
        }
      }
    }
  });

  hub2.queuePlacePending({
    ticker: 'TPTEST',
    price: 100,
    side: 'long',
    strategy: 'stub',
    instrumentType: 'FX',
    tickSize: 0.5,
    meta: { qty: 1 }
  });

  events.emit('bar', { provider: 'dwx', symbol: 'TPTEST', tf: 'M1', open: 100, high: 101, low: 99, close: 100 });
  await new Promise(r => setTimeout(r, 0));

  assert.ok(placed, 'takeProfit order was not executed');
  assert.strictEqual(placed.sl, 6); // diff 2 -> 4 pts -> clamped to 6
  assert.strictEqual(placed.tp, 18); // stop*3 rule
  assert.strictEqual(placed.meta.stopPts, 6);
  assert.strictEqual(placed.meta.takePts, 18);
  console.log('pendingOrdersHub tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

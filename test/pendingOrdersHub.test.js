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
    instrumentType: 'FX',
    tickSize: 1,
    meta: { qty: 1, stopPts: 1, riskUsd: 1 }
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
  assert.strictEqual(placed.sl, 3);
  assert.strictEqual(placed.meta.stopPts, 3);
  console.log('pendingOrdersHub tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

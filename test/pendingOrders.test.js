const assert = require('assert');
const { createPendingOrderService } = require('../app/services/pendingOrders');

async function run() {
  // long order triggers after 3 bars
  let exec;
  const svc1 = createPendingOrderService();
  svc1.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  const bars1 = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 },
    { open: 100.5, high: 101, low: 100.1, close: 100.9 },
  ];
  bars1.forEach(b => svc1.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101, stopLoss: 98 });

  // long order: first attempt invalid, then later trigger
  exec = undefined;
  const svc2 = createPendingOrderService();
  svc2.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  const bars2 = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 99.5, close: 100.7 }, // low below price -> invalid
    { open: 100.5, high: 100.9, low: 99.4, close: 99.8 }, // close below price keeps invalid
    { open: 100.3, high: 100.9, low: 100.1, close: 100.8 },
    { open: 100.4, high: 101, low: 100.2, close: 100.9 },
    { open: 100.5, high: 101.2, low: 100.3, close: 101 },
  ];
  bars2.forEach(b => svc2.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101.2, stopLoss: 100.1 });

  // short order triggers
  exec = undefined;
  const svc3 = createPendingOrderService();
  svc3.addOrder({ price: 200, side: 'short', onExecute: r => { exec = r; } });
  const bars3 = [
    { open: 200.5, high: 201, low: 199, close: 199.5 },
    { open: 199.8, high: 199.9, low: 198.9, close: 199.3 },
    { open: 199.7, high: 199.8, low: 198.5, close: 199 },
  ];
  bars3.forEach(b => svc3.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'short', limitPrice: 198.5, stopLoss: 201 });

  // cancelled order does not execute
  exec = undefined;
  const svc4 = createPendingOrderService();
  const id4 = svc4.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  svc4.cancelOrder(id4);
  bars1.forEach(b => svc4.onBar(b));
  assert.strictEqual(exec, undefined);

  console.log('pendingOrders tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

const assert = require('assert');
const {
  createPendingOrderService,
  B1_RANGE_CONSOLIDATION,
  createStrategyFactory
} = require('../app/services/pendingOrders');

async function run() {
  // long order triggers after 3 bars
  let exec;
  const svc1 = createPendingOrderService({ strategyConfig: {} });
  svc1.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  const bars1 = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 },
    { open: 100.5, high: 101, low: 100.1, close: 100.9 },
  ];
  bars1.forEach(b => svc1.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101, stopLoss: 98 });

  // long order triggers after 2 bars via service config
  exec = undefined;
  const svcCfg = createPendingOrderService({ strategyConfig: { consolidation: { bars: 2 } } });
  svcCfg.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  const barsCfg = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 }
  ];
  barsCfg.forEach(b => svcCfg.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101, stopLoss: 98 });

  // long order triggers after 1 bar when configured
  exec = undefined;
  const svc1a = createPendingOrderService({ strategyConfig: {} });
  svc1a.addOrder({ price: 100, side: 'long', bars: 1, onExecute: r => { exec = r; } });
  svc1a.onBar({ open: 99, high: 101, low: 98, close: 100.5 });
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101, stopLoss: 98 });

  // long order triggers after 4 bars when configured
  exec = undefined;
  const svc1b = createPendingOrderService({ strategyConfig: {} });
  svc1b.addOrder({ price: 100, side: 'long', bars: 4, onExecute: r => { exec = r; } });
  const bars1b = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 100, close: 100.7 },
    { open: 100.5, high: 101, low: 100.1, close: 100.9 },
    { open: 100.6, high: 101.1, low: 100.2, close: 100.95 },
  ];
  bars1b.forEach(b => svc1b.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101.1, stopLoss: 98 });

  // long order: first attempt invalid, then later trigger
  exec = undefined;
  const svc2 = createPendingOrderService({ strategyConfig: {} });
  svc2.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  const bars2 = [
    { open: 99, high: 101, low: 98, close: 100.5 },
    { open: 100.2, high: 100.8, low: 99.5, close: 100.7 }, // low below price -> invalid
    { open: 100.5, high: 100.9, low: 99.4, close: 99.8 }, // close below price keeps invalid
    { open: 100.1, high: 101, low: 100, close: 100.9 },
    { open: 100.2, high: 100.9, low: 100.1, close: 100.8 },
    { open: 100.2, high: 101, low: 100.2, close: 100.9 },
  ];
  bars2.forEach(b => svc2.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101, stopLoss: 100 });

  // short order triggers
  exec = undefined;
  const svc3 = createPendingOrderService({ strategyConfig: {} });
  svc3.addOrder({ price: 200, side: 'short', onExecute: r => { exec = r; } });
  const bars3 = [
    { open: 200.5, high: 201, low: 199, close: 199.5 },
    { open: 199.8, high: 199.9, low: 198.9, close: 199.3 },
    { open: 199.7, high: 199.8, low: 198.5, close: 199 },
  ];
  bars3.forEach(b => svc3.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'short', limitPrice: 198.5, stopLoss: 201 });

  // long order triggers within allowed range
  exec = undefined;
  const svcRange = createPendingOrderService({ strategyConfig: {} });
  svcRange.addOrder({ price: 100, side: 'long', rangeRule: B1_RANGE_CONSOLIDATION,
    onExecute: r => { exec = r; } });
  const barsRange = [
    { open: 99, high: 101, low: 99, close: 100.5 },
    { open: 100.6, high: 101.5, low: 100.6, close: 100.8 },
    { open: 100.8, high: 101.9, low: 100.7, close: 101 },
  ];
  barsRange.forEach(b => svcRange.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101.9, stopLoss: 99 });

  // short order triggers within allowed range
  exec = undefined;
  const svcRangeShort = createPendingOrderService({ strategyConfig: {} });
  svcRangeShort.addOrder({ price: 200, side: 'short', rangeRule: B1_RANGE_CONSOLIDATION,
    onExecute: r => { exec = r; } });
  const barsRangeShort = [
    { open: 200.5, high: 201, low: 199, close: 199.5 },
    { open: 199.8, high: 199.9, low: 198.9, close: 199.3 },
    { open: 199.7, high: 199.8, low: 198.5, close: 199 },
  ];
  barsRangeShort.forEach(b => svcRangeShort.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'short', limitPrice: 198.5, stopLoss: 201 });

  // long order uses B1_10p_GAP to offset limit price
  exec = undefined;
  const svcGapLong = createPendingOrderService({ strategyConfig: {} });
  svcGapLong.addOrder({ price: 100, side: 'long', dealPriceRule: 'B1_10p_GAP', onExecute: r => { exec = r; } });
  const barsGapLong = [
    { open: 99, high: 101, low: 99, close: 100.5 },
    { open: 100.6, high: 100.8, low: 100.6, close: 100.7 },
    { open: 100.7, high: 100.9, low: 100.6, close: 100.8 },
  ];
  barsGapLong.forEach(b => svcGapLong.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 100.22, stopLoss: 99 });

  // short order uses B1_10p_GAP to offset limit price
  exec = undefined;
  const svcGapShort = createPendingOrderService({ strategyConfig: {} });
  svcGapShort.addOrder({ price: 200, side: 'short', dealPriceRule: 'B1_10p_GAP', onExecute: r => { exec = r; } });
  const barsGapShort = [
    { open: 200.5, high: 201, low: 199, close: 199.5 },
    { open: 199.8, high: 199.9, low: 199.1, close: 199.4 },
    { open: 199.7, high: 199.8, low: 199.2, close: 199.3 },
  ];
  barsGapShort.forEach(b => svcGapShort.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'short', limitPrice: 199.78, stopLoss: 201 });

  // long order fails if price extends too far above level
  exec = undefined;
  const svc5 = createPendingOrderService({ strategyConfig: {} });
  svc5.addOrder({ price: 100, side: 'long', rangeRule: B1_RANGE_CONSOLIDATION,
    onExecute: r => { exec = r; } });
  const bars5 = [
    { open: 99, high: 101, low: 99, close: 100.5 },
    { open: 100.6, high: 103.1, low: 100.5, close: 101 }, // high beyond allowed range
    { open: 100.9, high: 101.2, low: 100.8, close: 101 },
  ];
  bars5.forEach(b => svc5.onBar(b));
  assert.strictEqual(exec, undefined);

  // short order fails if price extends too far below level
  exec = undefined;
  const svc6 = createPendingOrderService({ strategyConfig: {} });
  svc6.addOrder({ price: 200, side: 'short', rangeRule: B1_RANGE_CONSOLIDATION,
    onExecute: r => { exec = r; } });
  const bars6 = [
    { open: 200.5, high: 201, low: 199, close: 199.5 },
    { open: 199.4, high: 199.6, low: 197, close: 198.5 }, // low beyond allowed range
    { open: 198.4, high: 198.6, low: 197.5, close: 198.2 },
  ];
  bars6.forEach(b => svc6.onBar(b));
  assert.strictEqual(exec, undefined);

  // custom price and stop functions
  exec = undefined;
  const svcCustom = createPendingOrderService({ strategyConfig: {} });
  svcCustom.addOrder({ price: 100, side: 'long',
    dealPriceRule: () => 105,
    stoppLossRule: () => 95,
    onExecute: r => { exec = r; } });
  bars1.forEach(b => svcCustom.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 105, stopLoss: 95 });

  // limit and stop functions via config names
  exec = undefined;
  const factory = createStrategyFactory(
    { consolidation: { dealPriceRule: 'cfgDeal', stoppLossRule: 'cfgStop' } },
    undefined,
    {
      cfgDeal: () => 106,
      cfgStop: () => 94
    }
  );
  const svcCfgFns = createPendingOrderService({ strategyFactory: factory });
  svcCfgFns.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  bars1.forEach(b => svcCfgFns.onBar(b));
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 106, stopLoss: 94 });

  // cancelled order does not execute
  exec = undefined;
  const svc4 = createPendingOrderService({ strategyConfig: {} });
  const id4 = svc4.addOrder({ price: 100, side: 'long', onExecute: r => { exec = r; } });
  svc4.cancelOrder(id4);
  bars1.forEach(b => svc4.onBar(b));
  assert.strictEqual(exec, undefined);

  // false break ignores bars that don't cross level
  exec = undefined;
  let cancelled = false;
  const svc7 = createPendingOrderService({ strategyConfig: {} });
  svc7.addOrder({ price: 100, side: 'long', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  // first bar never pierces the level
  svc7.onBar({ open: 101, high: 101.5, low: 100.5, close: 101.2 });
  assert.strictEqual(exec, undefined);
  assert.strictEqual(cancelled, false);
  // second bar crosses and triggers immediately
  svc7.onBar({ open: 101, high: 101.5, low: 99.8, close: 101.2 });
  assert.deepStrictEqual(exec, { id: 1, side: 'long', limitPrice: 101.2, stopLoss: 99.7 });
  assert.strictEqual(cancelled, false);

  // false break immediate trigger short
  exec = undefined;
  cancelled = false;
  const svc8 = createPendingOrderService({ strategyConfig: {} });
  svc8.addOrder({ price: 200, side: 'short', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc8.onBar({ open: 199, high: 200.2, low: 198.5, close: 199.4 });
  assert.strictEqual(exec.id, 1);
  assert.strictEqual(exec.side, 'short');
  assert.strictEqual(exec.limitPrice, 199.4);
  assert.ok(Math.abs(exec.stopLoss - 200.3) < 1e-9);
  assert.strictEqual(cancelled, false);

  // false break two-bar trigger long
  exec = undefined;
  cancelled = false;
  const svc9 = createPendingOrderService({ strategyConfig: {} });
  svc9.addOrder({ price: 100, side: 'long', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc9.onBar({ open: 101, high: 101.5, low: 99.5, close: 99.7 });
  svc9.onBar({ open: 99.6, high: 100.6, low: 99.4, close: 100.2 });
  assert.strictEqual(exec.id, 1);
  assert.strictEqual(exec.side, 'long');
  assert.strictEqual(exec.limitPrice, 100.2);
  assert.ok(Math.abs(exec.stopLoss - 99.3) < 1e-9);
  assert.strictEqual(cancelled, false);

  // false break two-bar fails and cancels
  exec = undefined;
  cancelled = false;
  const svc10 = createPendingOrderService({ strategyConfig: {} });
  svc10.addOrder({ price: 100, side: 'long', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc10.onBar({ open: 101, high: 101.5, low: 99.5, close: 99.7 });
  svc10.onBar({ open: 99.6, high: 100.4, low: 99.3, close: 99.8 });
  assert.strictEqual(exec, undefined);
  assert.strictEqual(cancelled, true);

  // false break default tick size
  exec = undefined;
  cancelled = false;
  const svc11 = createPendingOrderService({ strategyConfig: {} });
  svc11.addOrder({ price: 100, side: 'long', strategy: 'falseBreak',
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc11.onBar({ open: 101, high: 101.5, low: 99.8, close: 101.2 });
  assert.strictEqual(exec.id, 1);
  assert.strictEqual(exec.side, 'long');
  assert.strictEqual(exec.limitPrice, 101.2);
  assert.ok(Math.abs(exec.stopLoss - 99.79) < 1e-9);
  assert.strictEqual(cancelled, false);

  // false break two-bar trigger short
  exec = undefined;
  cancelled = false;
  const svc12 = createPendingOrderService({ strategyConfig: {} });
  svc12.addOrder({ price: 200, side: 'short', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc12.onBar({ open: 199.5, high: 200.4, low: 199.4, close: 200.2 });
  svc12.onBar({ open: 200.1, high: 200.2, low: 199, close: 199.4 });
  assert.strictEqual(exec.id, 1);
  assert.strictEqual(exec.side, 'short');
  assert.strictEqual(exec.limitPrice, 199.4);
  assert.ok(Math.abs(exec.stopLoss - 200.3) < 1e-9);
  assert.strictEqual(cancelled, false);

  // false break two-bar short fails and cancels
  exec = undefined;
  cancelled = false;
  const svc13 = createPendingOrderService({ strategyConfig: {} });
  svc13.addOrder({ price: 200, side: 'short', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc13.onBar({ open: 199.5, high: 200.4, low: 199.4, close: 200.2 });
  svc13.onBar({ open: 200.1, high: 200.5, low: 199.8, close: 200.2 });
  assert.strictEqual(exec, undefined);
  assert.strictEqual(cancelled, true);

  // false break one-bar trigger long
  exec = undefined;
  cancelled = false;
  const svc14 = createPendingOrderService({ strategyConfig: {} });
  svc14.addOrder({ price: 100, side: 'long', strategy: 'falseBreak', tickSize: 0.1,
    onExecute: r => { exec = r; }, onCancel: () => { cancelled = true; } });
  svc14.onBar({ open: 101, high: 101.5, low: 99.8, close: 101.2 });
  assert.strictEqual(exec.id, 1);
  assert.strictEqual(exec.side, 'long');
  assert.strictEqual(exec.limitPrice, 101.2);
  assert.ok(Math.abs(exec.stopLoss - 99.7) < 1e-9);
  assert.strictEqual(cancelled, false);

  console.log('pendingOrders tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

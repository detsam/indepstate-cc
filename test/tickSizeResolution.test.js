const assert = require('assert');
const orderCalc = require('../app/services/orderCalculator');
const { resolveTickSize } = require('../app/services/points');

function run() {
  const qty = orderCalc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.0001, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qty, 12500);

  const wrong = orderCalc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.01, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(wrong, 125);

  const symbol = 'SOMEUSDT.P';
  const payloadTick = 0.01;
  const quoteTick = 0.0001;
  const effectiveTickSize = resolveTickSize({ symbol, explicitTickSize: payloadTick, quoteTickSize: quoteTick });
  assert.strictEqual(effectiveTickSize, 0.0001);

  const finalExecOrder = {
    symbol,
    sl: 12,
    instrumentType: 'CX',
    meta: { riskUsd: 15 },
    lot: 1,
    tickSize: effectiveTickSize
  };
  finalExecOrder.qty = orderCalc.qty({
    riskUsd: Number(finalExecOrder.meta.riskUsd),
    stopPts: Number(finalExecOrder.sl),
    tickSize: finalExecOrder.tickSize,
    lot: finalExecOrder.lot,
    instrumentType: finalExecOrder.instrumentType
  });

  assert.strictEqual(finalExecOrder.tickSize, 0.0001);
  assert.strictEqual(finalExecOrder.qty, 12500);
}

run();
console.log('tickSizeResolution tests passed');

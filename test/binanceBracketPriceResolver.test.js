const assert = require('assert');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');

const adapter = Object.create(CCXTExecutionAdapter.prototype);

(function testLongPoints() {
  const r = adapter._resolveBinanceBracketPrices({ order: { sl: 10, tp: 30 }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, 103);
})();

(function testShortPoints() {
  const r = adapter._resolveBinanceBracketPrices({ order: { sl: 10, tp: 30 }, direction: 'SHORT', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 101);
  assert.strictEqual(r.takeProfitPrice, 97);
})();

(function testAbsolute() {
  const r = adapter._resolveBinanceBracketPrices({ order: { slPrice: 99, tpPrice: 103, sl: 10, tp: 30 }, direction: 'LONG', entryPrice: 100, tickSize: 0.1 });
  assert.strictEqual(r.stopLossPrice, 99);
  assert.strictEqual(r.takeProfitPrice, 103);
  assert.strictEqual(r.source, 'absolute');
})();

console.log('binanceBracketPriceResolver.test passed');

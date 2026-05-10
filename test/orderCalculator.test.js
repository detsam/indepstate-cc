const assert = require('assert');
const { OrderCalculator } = require('../app/services/orderCalculator');

function testOrderCalculator() {
  console.log('Running OrderCalculator tests...');

  // Stub tradeRules
  const tradeRules = {
    rules: [
      {
        constructor: { name: 'MinStopPointsRule' },
        _min: (card) => card.instrumentType === 'FX' ? 20 : 6
      }
    ]
  };

  // Test default config loading
  const calc = new OrderCalculator({ tradeRules });
  assert.strictEqual(calc.config.profitRate, 3);

  // Test takePts with default rate
  assert.strictEqual(calc.takePts(10), 30);

  // Test stopPts with tradeRules min stop points
  const pts = calc.stopPts({ tickSize: 1, symbol: 'TEST', entryPrice: 100, stopPrice: 98, instrumentType: 'EQ' });
  assert.strictEqual(pts, 6, `Expected 6 points (min), got ${pts}`);

  const ptsFx = calc.stopPts({ tickSize: 1, symbol: 'TEST', entryPrice: 100, stopPrice: 95, instrumentType: 'FX' });
  assert.strictEqual(ptsFx, 20, `Expected 20 points (min FX), got ${ptsFx}`);

  // Test custom config
  const customCalc = new OrderCalculator({
    tradeRules,
    config: {
      profitRate: 5
    }
  });

  assert.strictEqual(customCalc.takePts(10), 50);

  const qtyCxFine = calc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.0001, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qtyCxFine, 12500);

  const qtyCxWrongTick = calc.qty({ riskUsd: 15, stopPts: 12, tickSize: 0.01, lot: 1, instrumentType: 'CX' });
  assert.strictEqual(qtyCxWrongTick, 125);


  console.log('OrderCalculator tests passed!');
}

try {
  testOrderCalculator();
} catch (err) {
  console.error('OrderCalculator tests failed:');
  console.error(err);
  process.exit(1);
}

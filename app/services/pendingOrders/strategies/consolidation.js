const ALWAYS_TRUE = () => true;

function defaultLimitPrice(b1, b2, b3, side) {
  return side === 'long'
    ? Math.max(b1.high, b2.high, b3.high)
    : Math.min(b1.low, b2.low, b3.low);
}

function defaultStopLoss(b1, _b2, _b3, side) {
  return side === 'long' ? b1.low : b1.high;
}

function B1_RANGE_CONSOLIDATION(price, side, b1, b2, b3) {
  const range = b1.high - b1.low;
  if (side === 'long') {
    return Math.max(b2.high, b3.high) - price <= range;
  }
  return price - Math.min(b2.low, b3.low) <= range;
}

class ConsolidationStrategy {
  constructor({ price, side, rangeRule = ALWAYS_TRUE, limitPriceFn = defaultLimitPrice, stopLossFn = defaultStopLoss } = {}) {
    this.price = Number(price);
    this.side = side;
    this.rangeRule = rangeRule;
    this.limitPriceFn = limitPriceFn;
    this.stopLossFn = stopLossFn;
    this.bars = [];
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;
    this.bars.push(bar);
    if (this.bars.length < 3) return null;
    const [b1, b2, b3] = this.bars.slice(-3);
    const p = this.price;
    let ok = false;
    if (this.side === 'long') {
      ok = b1.close > p &&
        b2.open > p && b2.close > p && b2.low >= p &&
        b3.open > p && b3.close > p && b3.low >= p;
    } else {
      ok = b1.close < p &&
        b2.open < p && b2.close < p && b2.high <= p &&
        b3.open < p && b3.close < p && b3.high <= p;
    }
    if (!ok) return null;
    if (!this.rangeRule(p, this.side, b1, b2, b3)) return null;
    this.done = true;
    const limitPrice = this.limitPriceFn(b1, b2, b3, this.side);
    const stopLoss = this.stopLossFn(b1, b2, b3, this.side);
    return { limitPrice, stopLoss };
  }
}

module.exports = { ConsolidationStrategy, B1_RANGE_CONSOLIDATION };

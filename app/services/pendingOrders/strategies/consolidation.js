const ALWAYS_TRUE = () => true;

// KNOWN_EXTREMUM selects the most favorable extreme from the bar sequence
// (highest high for longs, lowest low for shorts) as the target price.
function KNOWN_EXTREMUM(bars, side) {
  return side === 'long'
    ? Math.max(...bars.map(b => b.high))
    : Math.min(...bars.map(b => b.low));
}

// B1_TAIL uses the opposite-side tail of the breakout bar as the stop price.
function B1_TAIL(bars, side) {
  const b1 = bars[0];
  return side === 'long' ? b1.low : b1.high;
}

function B1_RANGE_CONSOLIDATION(price, side, bars) {
  const b1 = bars[0];
  const range = b1.high - b1.low;
  if (bars.length <= 1) return true;
  if (side === 'long') {
    return Math.max(...bars.slice(1).map(b => b.high)) - price <= range;
  }
  return price - Math.min(...bars.slice(1).map(b => b.low)) <= range;
}

class ConsolidationStrategy {
  constructor({ price, side, bars = 3, rangeRule = ALWAYS_TRUE, dealPriceRule = KNOWN_EXTREMUM, stoppLossRule = B1_TAIL } = {}) {
    this.price = Number(price);
    this.side = side;
    this.barCount = Math.max(1, Number(bars) || 3);
    this.rangeRule = rangeRule;
    this.dealPriceRule = dealPriceRule;
    this.stoppLossRule = stoppLossRule;
    this.bars = [];
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;
    this.bars.push(bar);
    if (this.bars.length < this.barCount) return null;
    const seq = this.bars.slice(-this.barCount);
    const b1 = seq[0];
    const p = this.price;
    let ok = false;
    if (this.side === 'long') {
      ok = b1.close > p && seq.slice(1).every(b => b.open > p && b.close > p && b.low >= p);
    } else {
      ok = b1.close < p && seq.slice(1).every(b => b.open < p && b.close < p && b.high <= p);
    }
    if (!ok) return null;
    if (!this.rangeRule(p, this.side, seq)) return null;
    this.done = true;
    const limitPrice = this.dealPriceRule(seq, this.side);
    const stopLoss = this.stoppLossRule(seq, this.side);
    return { limitPrice, stopLoss };
  }
}

module.exports = {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  B1_TAIL
};

class ConsolidationStrategy {
  constructor({ price, side }) {
    this.price = Number(price);
    this.side = side;
    this.bars = [];
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;
    this.bars.push(bar);
    if (this.bars.length < 3) return null;
    const [b1, b2, b3] = this.bars.slice(-3);
    const p = this.price;
    const range = b1.high - b1.low;
    let ok = false;
    if (this.side === 'long') {
      ok = b1.close > p &&
        b2.open > p && b2.close > p && b2.low >= p &&
        b3.open > p && b3.close > p && b3.low >= p &&
        Math.max(b2.high, b3.high) - p <= range;
    } else {
      ok = b1.close < p &&
        b2.open < p && b2.close < p && b2.high <= p &&
        b3.open < p && b3.close < p && b3.high <= p &&
        p - Math.min(b2.low, b3.low) <= range;
    }
    if (!ok) return null;
    this.done = true;
    const limitPrice = this.side === 'long'
      ? Math.max(b1.high, b2.high, b3.high)
      : Math.min(b1.low, b2.low, b3.low);
    const stopLoss = this.side === 'long' ? b1.low : b1.high;
    return { limitPrice, stopLoss };
  }
}

module.exports = { ConsolidationStrategy };

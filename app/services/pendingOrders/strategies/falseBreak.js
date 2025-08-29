class FalseBreakStrategy {
  constructor({ price, side, tickSize = 0.0001 }) {
    this.price = Number(price);
    this.side = side;
    this.tick = Number(tickSize) || 0.0001;
    this.stage = 0; // 0 initial, 1 waiting for bar2
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;
    const { open, close, high, low } = bar;
    const p = this.price;
    if (this.stage === 0) {
      if (this.side === 'long') {
        if (open > p && close > p && low < p) {
          this.done = true;
          return { limitPrice: close, stopLoss: low - this.tick };
        }
        if (open < p && close > p) {
          this.stage = 1;
          return null;
        }
        this.done = true;
        return { cancel: true };
      } else {
        if (open < p && close < p && high > p) {
          this.done = true;
          return { limitPrice: close, stopLoss: high + this.tick };
        }
        if (open > p && close < p) {
          this.stage = 1;
          return null;
        }
        this.done = true;
        return { cancel: true };
      }
    } else if (this.stage === 1) {
      this.done = true;
      if (this.side === 'long') {
        if (close > p) {
          return { limitPrice: close, stopLoss: low - this.tick };
        }
        return { cancel: true };
      } else {
        if (close < p) {
          return { limitPrice: close, stopLoss: high + this.tick };
        }
        return { cancel: true };
      }
    }
    return null;
  }
}

module.exports = { FalseBreakStrategy };

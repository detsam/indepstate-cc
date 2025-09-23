class FalseBreak1BStrategy {
  constructor({ price, side, tickSize = 0.01 }) {
    this.price = Number(price);
    this.side = side;
    this.tick = Number(tickSize) || 0.01;
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;
    const { open, close, high, low } = bar;
    const p = this.price;
    const t = this.tick;

    if (this.side === 'long') {
      if (open <= p) return null;
      if (low > p - t) return null;
      this.done = true;
      if (close > p) {
        return { limitPrice: close, stopLoss: low - t };
      }
      if (close < p) {
        return { continue: true };
      }
      return { cancel: true };
    } else {
      if (open >= p) return null;
      if (high < p + t) return null;
      this.done = true;
      if (close < p) {
        return { limitPrice: close, stopLoss: high + t };
      }
      if (close > p) {
        return { continue: true };
      }
      return { cancel: true };
    }
  }
}

class FalseBreak2BStrategy {
  constructor({ price, side, tickSize = 0.01 }) {
    this.price = Number(price);
    this.side = side;
    this.tick = Number(tickSize) || 0.01;
    this.stage = 0; // waiting for bar1
    this.done = false;
    this.firstBar = null;
  }

  onBar(bar) {
    if (this.done) return null;
    const { open, close, high, low } = bar;
    const p = this.price;
    const t = this.tick;

    if (this.stage === 0) {
      if (this.side === 'long') {
        if (open > p && close < p && low < p - t) {
          this.stage = 1;
          this.firstBar = { low };
          return null;
        }
      } else if (open < p && close > p && high > p + t) {
        this.stage = 1;
        this.firstBar = { high };
        return null;
      }
      this.done = true;
      return { cancel: true };
    }

    this.done = true;
    if (this.side === 'long') {
      if (open < p && close > p) {
        const refLow = this.firstBar ? this.firstBar.low : low;
        return { limitPrice: close, stopLoss: refLow - t };
      }
    } else if (open > p && close < p) {
      const refHigh = this.firstBar ? this.firstBar.high : high;
      return { limitPrice: close, stopLoss: refHigh + t };
    }
    return { cancel: true };
  }
}

class FalseBreakStrategy {
  constructor(opts) {
    this.first = new FalseBreak1BStrategy(opts);
    this.second = new FalseBreak2BStrategy(opts);
    this.useSecond = false;
    this.done = false;
  }

  onBar(bar) {
    if (this.done) return null;

    if (!this.useSecond) {
      const r1 = this.first.onBar(bar);
      if (r1) {
        if (r1.limitPrice || r1.cancel) {
          this.done = true;
          return r1;
        }
        if (r1.continue) {
          this.useSecond = true;
          const r2 = this.second.onBar(bar);
          if (r2) {
            this.done = true;
            return r2;
          }
          return null;
        }
      }
      return null;
    }

    const r2 = this.second.onBar(bar);
    if (r2) {
      this.done = true;
      return r2;
    }
    return null;
  }
}

module.exports = { FalseBreak1BStrategy, FalseBreak2BStrategy, FalseBreakStrategy };


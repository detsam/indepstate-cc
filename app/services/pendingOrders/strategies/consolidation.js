const ALWAYS_TRUE = () => true;

function normalizeBar(bar) {
  if (!bar || typeof bar !== 'object') return null;
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  const timeRaw = bar.time != null ? Number(bar.time) : (bar.timestamp != null ? Number(bar.timestamp) : undefined);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }
  const normalized = { open: Number.isFinite(open) ? open : undefined, high, low, close };
  if (Number.isFinite(timeRaw)) normalized.time = timeRaw;
  return normalized;
}

function dedupeBars(bars) {
  const byTime = new Map();
  for (const bar of bars) {
    if (!bar) continue;
    if (bar.time == null) {
      byTime.set(Symbol('no-time'), bar);
      continue;
    }
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values());
}

function sortBarsAsc(bars) {
  return bars.slice().sort((a, b) => {
    const ta = a.time == null ? -Infinity : a.time;
    const tb = b.time == null ? -Infinity : b.time;
    return ta - tb;
  });
}

// KNOWN_EXTREMUM selects the most favorable extreme from the bar sequence
// (highest high for longs, lowest low for shorts) as the target price.
function KNOWN_EXTREMUM(bars, side, _price) {
  return side === 'long'
    ? Math.max(...bars.map(b => b.high))
    : Math.min(...bars.map(b => b.low));
}

// B1_TAIL uses the opposite-side tail of the breakout bar as the stop price.
function B1_TAIL(bars, side, _price) {
  const b1 = bars[0];
  return side === 'long' ? b1.low : b1.high;
}

// B1_10p_GAP offsets the entry price by 10% of the breakout bar range
// (minimum 0.01) plus 0.02 to place the limit order.
function B1_10p_GAP(bars, side, price) {
  const b1 = bars[0];
  const range = b1.high - b1.low;
  const gap = Math.max(range * 0.1, 0.01) + 0.02;
  return side === 'long' ? price + gap : price - gap;
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
  constructor({
    price,
    side,
    bars = 3,
    rangeRule = ALWAYS_TRUE,
    dealPriceRule = KNOWN_EXTREMUM,
    stoppLossRule = B1_TAIL,
    historyLoader,
    historyBars,
    historyTimeframe = 'M1',
    historyPreload = false,
    symbol
  } = {}) {
    this.price = Number(price);
    this.side = side;
    this.barCount = Math.max(1, Number(bars) || 3);
    this.rangeRule = rangeRule;
    this.dealPriceRule = dealPriceRule;
    this.stoppLossRule = stoppLossRule;
    this.historyBars = Math.max(1, Number(historyBars) || this.barCount);
    this.historyTimeframe = typeof historyTimeframe === 'string' && historyTimeframe ? historyTimeframe : 'M1';
    this.historyLoader = typeof historyLoader === 'function' ? historyLoader : null;
    this.historyPreload = Boolean(historyPreload);
    this.symbol = symbol;
    this.initialBars = [];
    this.bars = [];
    this.done = false;
    this.historyLoadPromise = null;
    if (this.historyPreload && this.historyLoader) {
      this._loadHistoryOnce();
    }
  }

  async onBar(bar) {
    if (this.done) return null;
    const normalized = normalizeBar(bar);
    if (normalized) {
      this.bars.push(normalized);
      if (this.bars.length > this.historyBars * 2) {
        this.bars = this.bars.slice(-this.historyBars * 2);
      }
    }
    if (this.historyPreload && this.historyLoader && this._getAvailableCount() < this.barCount) {
      await this._loadHistoryOnce();
    }
    const seq = this._getSequence();
    if (!seq) return null;
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
    const limitPrice = this.dealPriceRule(seq, this.side, p);
    const stopLoss = this.stoppLossRule(seq, this.side, p);
    return { limitPrice, stopLoss };
  }

  _getAvailableCount() {
    return this.initialBars.length + this.bars.length;
  }

  _getSequence() {
    let merged = dedupeBars([...this.initialBars, ...this.bars]);
    if (!merged.length) return null;
    merged = sortBarsAsc(merged);
    if (merged.length < this.barCount) return null;
    return merged.slice(-this.barCount);
  }

  async _loadHistoryOnce() {
    if (!this.historyLoader) return;
    if (this.historyLoadPromise) return this.historyLoadPromise;
    this.historyLoadPromise = (async () => {
      try {
        const fetched = await this.historyLoader({
          limit: this.historyBars,
          timeframe: this.historyTimeframe,
          price: this.price,
          side: this.side,
          symbol: this.symbol
        });
        if (Array.isArray(fetched)) {
          const normalized = fetched.map(normalizeBar).filter(Boolean);
          if (normalized.length) {
            const merged = dedupeBars([...this.initialBars, ...normalized]);
            this.initialBars = sortBarsAsc(merged);
            if (this.initialBars.length > this.historyBars * 2) {
              this.initialBars = this.initialBars.slice(-this.historyBars * 2);
            }
          }
        }
      } catch (err) {
        console.error('consolidation: historyLoader failed', err);
        this.historyLoadPromise = null;
      }
    })();
    return this.historyLoadPromise;
  }
}

module.exports = {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  KNOWN_EXTREMUM,
  B1_TAIL,
  B1_10p_GAP
};

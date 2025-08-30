class OrderCalculator {
  constructor({ tradeRules } = {}) {
    this.tradeRules = tradeRules;
  }

  // Calculate stop loss points from entry and stop prices
  stopPts({ tickSize, symbol, entryPrice, stopPrice, instrumentType }) {
    const { toPoints } = require('./points');
    let pts = toPoints(tickSize, symbol, Math.abs(entryPrice - stopPrice), entryPrice);

    const tr = this.tradeRules;
    const minRule = tr?.rules?.find(r => r instanceof tr.MinStopPointsRule);
    if (minRule) {
      const minPts = minRule._min({ instrumentType });
      if (Number.isFinite(minPts) && Number.isFinite(pts) && pts < minPts) {
        pts = minPts;
      }
    }
    return pts;
  }

  // Default take profit is triple the stop points
  takePts(stopPts) {
    return Number.isFinite(stopPts) ? stopPts * 3 : undefined;
  }

  // Calculate position size from risk in USD
  qty({ riskUsd, stopPts, tickSize = 1, lot = 1, instrumentType }) {
    if (Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(stopPts) && stopPts > 0) {
      const tick = tickSize || 1;
      let q;
      if (instrumentType === 'FX') {
        const lotSize = Number(lot) || 100000;
        q = Math.floor((riskUsd / tick) / stopPts / lotSize / 0.01) * 0.01;
      } else if (instrumentType === 'CX') {
        const lotSize = Number(lot) || 1;
        q = Math.floor((riskUsd / tick) / stopPts / lotSize / 0.001) * 0.001;
      } else {
        q = Math.floor((riskUsd / tick) / stopPts);
      }
      if (!Number.isFinite(q) || q < 0) q = 0;
      return q;
    }
    return 0;
  }
}

module.exports = { OrderCalculator };

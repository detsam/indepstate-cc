const loadConfig = require('../../config/load');

class OrderCalculator {
  constructor({ config, tradeRules } = {}) {
    this.config = config || this._loadDefaultConfig();
    this.tradeRules = tradeRules;
  }

  _loadDefaultConfig() {
    try {
      return loadConfig('../services/orderCalculator/config/order-calculator.json');
    } catch (e) {
      return { profitRate: 3 };
    }
  }

  // Calculate stop loss points from entry and stop prices
  stopPts({ tickSize, symbol, entryPrice, stopPrice, instrumentType }) {
    const { toPoints } = require('../points');
    let pts = toPoints(tickSize, symbol, Math.abs(entryPrice - stopPrice), entryPrice);

    const tr = this.tradeRules;
    const minRule = tr?.rules?.find(r => r.constructor.name === 'MinStopPointsRule');
    if (minRule) {
      const minPts = minRule._min({ instrumentType });
      if (Number.isFinite(minPts) && Number.isFinite(pts) && pts < minPts) {
        pts = minPts;
      }
    }
    return pts;
  }

  // Default take profit is triple the stop points or based on config profit rate
  takePts(stopPts) {
    const rate = this.config?.profitRate ?? 3;
    return Number.isFinite(stopPts) ? stopPts * rate : undefined;
  }

  // Calculate position size from risk in USD
  qty({ riskUsd, stopPts, tickSize, lot = 1, instrumentType }) {
    if (Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(stopPts) && stopPts > 0) {
      const tick = Number(tickSize);
      let q;
      if (instrumentType === 'FX') {
        const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 1;
        const lotSize = Number(lot) || 100000;
        q = Math.floor((riskUsd / safeTick) / stopPts / lotSize / 0.01) * 0.01;
      } else if (instrumentType === 'CX') {
        if (!Number.isFinite(tick) || tick <= 0) return 0;
        const lotSize = Number(lot) || 1;
        q = Math.floor((riskUsd / tick) / stopPts / lotSize / 0.001) * 0.001;
      } else {
        const safeTick = Number.isFinite(tick) && tick > 0 ? tick : 1;
        q = Math.floor((riskUsd / safeTick) / stopPts);
      }
      if (!Number.isFinite(q) || q < 0) q = 0;
      return q;
    }
    return 0;
  }
}

function buildOrderCalculator(cfg = {}, servicesApi = require('../servicesApi')) {
  return new OrderCalculator({
    config: cfg,
    get tradeRules() { return servicesApi.tradeRules; }
  });
}

let cfg = {};
try { cfg = loadConfig('../services/orderCalculator/config/order-calculator.json'); }
catch { cfg = {}; }

module.exports = buildOrderCalculator(cfg);
module.exports.OrderCalculator = OrderCalculator;
module.exports.buildOrderCalculator = buildOrderCalculator;

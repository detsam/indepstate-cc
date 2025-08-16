const loadConfig = require('../config/load');

class TradeRules {
  constructor(cfg = {}) {
    const { maxPriceDeviationPct = 0.5 } = cfg || {};
    this.maxDeviation = Number(maxPriceDeviationPct) / 100;
  }

  _marketPrice(quote = {}, side) {
    if (side === 'sell') return Number.isFinite(quote.bid) ? quote.bid : quote.price;
    if (side === 'buy') return Number.isFinite(quote.ask) ? quote.ask : quote.price;
    return quote.price;
  }

  validate(card = {}, quote) {
    const market = this._marketPrice(quote, card.side);
    if (!Number.isFinite(market) || market <= 0) {
      return { ok: false, reason: 'No quote' };
    }

    const price = Number(card.price);
    if (!Number.isFinite(price) || price <= 0) return { ok: true };

    const diff = Math.abs(price - market) / market;
    if (diff > this.maxDeviation) {
      return { ok: false, reason: 'Actual price gap restriction', diff };
    }

    return { ok: true };
  }
}

let cfg = {};
try { cfg = loadConfig('trade-rules.json'); }
catch { cfg = {}; }

module.exports = new TradeRules(cfg);
module.exports.TradeRules = TradeRules;

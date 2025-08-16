const loadConfig = require('../config/load');

class TradeRule {
  constructor(cfg = {}) {
    this.cfg = cfg;
  }

  validate() {
    return { ok: true };
  }
}

class MaxOrderPriceDeviationRule extends TradeRule {
  constructor(cfg = {}) {
    super(cfg);
    const { maxPriceDeviationPct = 0.5 } = cfg;
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

class TradeRules {
  constructor(rules = []) {
    this.rules = rules;
  }

  validate(card = {}, quote) {
    for (const rule of this.rules) {
      const res = rule.validate(card, quote);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
}

function buildTradeRules(cfg = {}) {
  const rules = [];
  const { rules: ruleCfgs = {} } = cfg;

  if (ruleCfgs.maxOrderPriceDeviation && ruleCfgs.maxOrderPriceDeviation.enabled !== false) {
    rules.push(new MaxOrderPriceDeviationRule(ruleCfgs.maxOrderPriceDeviation));
  }

  return new TradeRules(rules);
}

let cfg = {};
try { cfg = loadConfig('trade-rules.json'); }
catch { cfg = {}; }

module.exports = buildTradeRules(cfg);
module.exports.TradeRules = TradeRules;
module.exports.TradeRule = TradeRule;
module.exports.MaxOrderPriceDeviationRule = MaxOrderPriceDeviationRule;
module.exports.buildTradeRules = buildTradeRules;


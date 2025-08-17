const TradeRule = require('./tradeRule');

class MaxQtyRule extends TradeRule {
  constructor(cfg = {}) {
    super(cfg);
    const { byInstrumentType = {}, default: def } = cfg;
    this.byInstrumentType = byInstrumentType;
    this.defaultMax = Number.isFinite(def) ? Number(def) : undefined;
  }

  _max(card = {}) {
    const t = card.instrumentType;
    if (t && Number.isFinite(this.byInstrumentType[t])) return Number(this.byInstrumentType[t]);
    return this.defaultMax;
  }

  validate(card = {}) {
    const max = this._max(card);
    if (max == null) return { ok: true };
    const qty = Number(card.qty);
    if (!Number.isFinite(qty) || qty > max) {
      return { ok: false, reason: `Qty ≤ ${max}` };
    }
    return { ok: true };
  }
}

module.exports = { MaxQtyRule };

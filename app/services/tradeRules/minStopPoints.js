const TradeRule = require('./tradeRule');

class MinStopPointsRule extends TradeRule {
  constructor(cfg = {}) {
    super(cfg);
    const { byInstrumentType = {}, default: def, fn } = cfg;
    this.byInstrumentType = byInstrumentType;
    this.defaultMin = Number.isFinite(def) ? Number(def) : undefined;
    if (typeof fn === 'string') {
      try { this.fn = new Function('card', 'quote', fn); }
      catch { this.fn = null; }
    }
  }

  _min(card = {}) {
    const t = card.instrumentType;
    if (t && Number.isFinite(this.byInstrumentType[t])) return Number(this.byInstrumentType[t]);
    return this.defaultMin;
  }

  validate(card = {}, quote) {
    if (this.fn) {
      try {
        const res = this.fn(card, quote);
        if (typeof res === 'boolean') return { ok: res };
        if (res && typeof res.ok === 'boolean') return res;
        return { ok: true };
      } catch {
        return { ok: false, reason: 'Min stop rule error' };
      }
    }

    const min = this._min(card);
    if (min == null) return { ok: true };
    const sl = Number(card.sl);
    if (!Number.isFinite(sl) || sl < min) {
      return { ok: false, reason: `SL ≥ ${min}` };
    }
    return { ok: true };
  }
}

module.exports = { MinStopPointsRule };

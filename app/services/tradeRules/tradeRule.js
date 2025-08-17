class TradeRule {
  constructor(cfg = {}) {
    this.cfg = cfg;
  }

  validate() {
    return { ok: true };
  }
}

module.exports = TradeRule;

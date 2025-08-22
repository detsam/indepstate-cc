const { Command } = require('./base');
const { digitsFallbackPoints } = require('../points');

function _normNum(val) {
  if (val == null) return null;
  const s = String(val).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePts(token) {
  const n = digitsFallbackPoints(token);
  return Number.isFinite(n) ? n : null;
}

function isSL(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

class AddCommand extends Command {
  constructor(opts = {}) {
    super(['add', 'a']);
    this.onAdd = opts.onAdd;
  }

  run(args) {
    const [ticker, priceStr, slStr, tpStr, riskStr] = args;
    if (!ticker || priceStr == null || slStr == null) {
      return { ok: false, error: 'Usage: add {ticker} {price} {sl} {tp} {risk}' };
    }
    const price = _normNum(priceStr);
    const sl = parsePts(slStr);
    const tp = parsePts(tpStr);
    const risk = _normNum(riskStr);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, error: 'Invalid price' };
    }
    if (!isSL(sl)) {
      return { ok: false, error: 'Invalid SL' };
    }
    const row = {
      ticker,
      price,
      sl,
      time: Date.now(),
      event: 'manual'
    };
    if (tp != null) row.tp = tp;
    if (risk != null) row.risk = risk;
    if (typeof this.onAdd === 'function') this.onAdd(row);
    return { ok: true };
  }
}

module.exports = { AddCommand };

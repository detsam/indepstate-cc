// Формат: "TICKER EVENT PRICE"
const RE = /^\s*(\S+)\s+(\S+)\s+([+-]?\d+(?:\.\d+)?)\s*$/;

module.exports = {
  name: 'plain',
  test(raw) { return typeof raw === 'string' && RE.test(raw); },
  parse(raw, nowTs) {
    const m = raw.match(RE);
    if (!m) return null;
    const [ , ticker, event, priceStr ] = m;
    const price = Number(priceStr);
    if (!Number.isFinite(price)) return null;
    return { row: { ticker, event, price, time: nowTs() } };
  }
};

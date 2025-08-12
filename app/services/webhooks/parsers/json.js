// Универсальный JSON: {ticker|symbol, event|side, price, sl|stop|meta.stopPts, tp|take|meta.takePts, qty|meta.qty}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : undefined; }

module.exports = {
  name: 'json',
  test(raw) {
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    return s.startsWith('{') && s.endsWith('}');
  },
  parse(raw, nowTs) {
    let js;
    try { js = JSON.parse(raw); } catch { return null; }
    const ticker = js.ticker || js.symbol || '';
    const event  = js.event  || js.side   || '';
    const price  = num(js.price);

    if (!ticker || !Number.isFinite(price)) return null;

    const sl = num(js.sl ?? js.stop ?? js.meta?.stopPts);
    const tp = num(js.tp ?? js.take ?? js.meta?.takePts);
    const qty = num(js.qty ?? js.meta?.qty);

    return {
      row: {
        ticker, event, price, time: nowTs(),
        sl, tp, qty
      }
    };
  }
};

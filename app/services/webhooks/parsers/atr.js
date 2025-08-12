// app/services/webhooks/parsers/atr.js
const { toPoints } = require('../../points');

const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const RE_NESTED = new RegExp(
  String.raw`@ATR\s*\(\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)[\s\S]*?\)\s*Crossing\s*(${NUM})\s*on\s*([^,\s]+)`,
  'i'
);

module.exports = {
  name: 'atr',
  test(raw) { return typeof raw === 'string' && raw.includes('@ATR') && RE_NESTED.test(raw); },
  parse(raw, nowTs) {
    const m = raw.match(RE_NESTED);
    if (!m) return null;

    // Сохраняем и числовое, и строковое представление
    const stopTok = m[1], takeTok = m[2], poseTok = m[3], levelTok = m[4], ticker = String(m[5]);
    const stopNum = Number(stopTok);
    const takeNum = Number(takeTok);
    const poseNum = Number(poseTok);
    const level   = Number(levelTok);

    if (!ticker || !Number.isFinite(level)) return null;

    // Переводим в пункты: приоритет tickSize из конфига, иначе цифровой fallback
    const slPts = Number.isFinite(stopNum) ? toPoints(ticker, stopNum, level, stopTok) : undefined;
    const tpPts = Number.isFinite(takeNum) ? toPoints(ticker, takeNum, level, takeTok) : undefined;

    return {
      row: {
        ticker,
        event: 'ATR',
        price: level,
        time: nowTs(),
        sl: slPts,
        tp: tpPts,
        qty: Number.isFinite(poseNum) ? poseNum : undefined,
        // для отладки при желании можно сохранять сырьё:
        // slRaw: stopTok, tpRaw: takeTok
      }
    };
  }
};

const fs = require('fs');
const dealTrackers = require('../dealTrackers');
let cfg = {};
try {
  cfg = require('../../config/tv-logs.json');
} catch (_) {
  cfg = {};
}

function resolveEnvRef(str) {
  if (typeof str !== 'string') return str;
  const m = str.match(/^\s*(?:\$\{?ENV:([A-Z0-9_]+)\}?)\s*$/i);
  if (!m) return str;
  const v = process.env[m[1]];
  return v == null ? '' : v;
}
function resolveSecrets(obj) {
  if (!obj || typeof obj !== 'object') return resolveEnvRef(obj);
  if (Array.isArray(obj)) return obj.map(resolveSecrets);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = resolveSecrets(obj[k]);
  return out;
}

function parseCsvText(text) {
  function parsePrice(str) {
    if (str === '') return { num: undefined, int: undefined, dec: 0 };
    const dec = (str.split('.')[1] || '').length;
    const int = Number(str.replace('.', ''));
    return { num: Number(str), int, dec };
  }

  const lines = String(text).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('Symbol')) continue;
    const parts = line.split(',');
    if (parts.length < 13) continue;
    const [
      symbol, side, type, qtyStr, limitPriceStr, stopPriceStr, fillPriceStr,
      status, commissionStr, _lev, _margin, placingTime, closingTime, orderIdStr
    ] = parts.map(p => p.trim());

    const limit = parsePrice(limitPriceStr);
    const stop = parsePrice(stopPriceStr);
    const fill = parsePrice(fillPriceStr);

    const row = {
      symbol,
      side,
      type,
      qty: Number(qtyStr),
      limitPrice: limit.num,
      limitPriceInt: limit.int,
      limitPriceDec: limit.dec,
      stopPrice: stop.num,
      stopPriceInt: stop.int,
      stopPriceDec: stop.dec,
      fillPrice: fill.num,
      fillPriceInt: fill.int,
      fillPriceDec: fill.dec,
      status,
      commission: commissionStr === '' ? 0 : Number(commissionStr),
      placingTime,
      closingTime,
      orderId: Number(orderIdStr)
    };
    rows.push(row);
  }
  return rows;
}

function groupOrders(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.symbol}|${r.placingTime}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function buildDeal(group) {
  if (!Array.isArray(group) || group.length === 0) return null;
  group.sort((a, b) => a.orderId - b.orderId);
  const entry = group[0];
  const rawSymbol = entry.symbol || '';
  const rawPlacingTime = entry.placingTime || '';
  const ticker = rawSymbol.split(':').pop();
  const placingDate = rawPlacingTime.split(' ')[0];
  const filled = group.filter(o => String(o.status).toLowerCase() === 'filled');
  if (filled.length < 2) return null;
  const closing = filled.find(o => o !== entry) || filled[1];

  function diffInt(aInt, aDec, bInt, bDec) {
    const scale = Math.max(aDec, bDec);
    const a = aInt * Math.pow(10, scale - aDec);
    const b = bInt * Math.pow(10, scale - bDec);
    return Math.abs(a - b);
  }

  function ensureIntDec(num, intVal, decVal) {
    if (intVal != null && decVal != null) return { int: intVal, dec: decVal };
    const str = String(num);
    const dec = (str.split('.')[1] || '').length;
    const int = Number(str.replace('.', ''));
    return { int, dec };
  }

  const side = String(entry.side).toLowerCase() === 'sell' ? 'short' : 'long';
  const type = String(entry.type).toLowerCase();
  let price, priceInt, priceDec;
  if (type === 'limit') {
    price = entry.limitPrice;
    ({ int: priceInt, dec: priceDec } = ensureIntDec(entry.limitPrice, entry.limitPriceInt, entry.limitPriceDec));
  } else if (type === 'stop') {
    price = entry.stopPrice;
    ({ int: priceInt, dec: priceDec } = ensureIntDec(entry.stopPrice, entry.stopPriceInt, entry.stopPriceDec));
  } else {
    price = entry.fillPrice;
    ({ int: priceInt, dec: priceDec } = ensureIntDec(entry.fillPrice, entry.fillPriceInt, entry.fillPriceDec));
  }
  const qty = Number(entry.qty) || 0;

  let takeOrder, stopOrder;
  for (const o of group.slice(1)) {
    if (side === 'long') {
      if (o.limitPrice != null && o.limitPrice > price) takeOrder = o;
      if (o.stopPrice != null && o.stopPrice < price) stopOrder = o;
    } else {
      if (o.limitPrice != null && o.limitPrice < price) takeOrder = o;
      if (o.stopPrice != null && o.stopPrice > price) stopOrder = o;
    }
  }

  let takeSetup, stopSetup;
  if (takeOrder && takeOrder.limitPrice != null) {
    const t = ensureIntDec(takeOrder.limitPrice, takeOrder.limitPriceInt, takeOrder.limitPriceDec);
    takeSetup = diffInt(t.int, t.dec, priceInt, priceDec);
  }
  if (stopOrder && stopOrder.stopPrice != null) {
    const s = ensureIntDec(stopOrder.stopPrice, stopOrder.stopPriceInt, stopOrder.stopPriceDec);
    stopSetup = diffInt(s.int, s.dec, priceInt, priceDec);
  }

  const result = side === 'long'
    ? (closing.fillPrice > entry.fillPrice ? 'take' : 'stop')
    : (closing.fillPrice < entry.fillPrice ? 'take' : 'stop');

  let takePoints, stopPoints;
  const c = ensureIntDec(closing.fillPrice, closing.fillPriceInt, closing.fillPriceDec);
  const diffPoints = diffInt(c.int, c.dec, priceInt, priceDec);
  if (result === 'take') {
    takePoints = diffPoints;
  } else {
    stopPoints = diffPoints;
  }

  const rawCommission = filled.reduce((sum, o) => sum + (Number(o.commission) || 0), 0);
  const commission = Math.round(rawCommission * 100) / 100;
  const rawProfit = side === 'short'
    ? (price - closing.fillPrice) * qty
    : (closing.fillPrice - price) * qty;
  const profit = Math.round(rawProfit * 100) / 100;

  return {
    _key: `${rawSymbol}|${rawPlacingTime}`,
    symbol: ticker,
    placingTime: placingDate,
    side,
    type,
    price,
    qty,
    takeSetup,
    stopSetup,
    result,
    takePoints,
    stopPoints,
    commission,
    profit
  };
}

function processFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = parseCsvText(text);
  const groups = groupOrders(rows);
  const deals = [];
  for (const arr of groups.values()) {
    const d = buildDeal(arr);
    if (d) deals.push(d);
  }
  return deals;
}

function processAll(config = cfg) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  for (const acc of accounts) {
    const file = acc.path;
    if (!file) continue;
    const deals = processFile(file);
    for (const d of deals) {
      dealTrackers.notifyPositionClosed({
        ticker: d.symbol,
        tp: d.takeSetup,
        sp: d.stopSetup,
        status: d.result,
        profit: d.profit,
        commission: d.commission,
        takePoints: d.takePoints,
        stopPoints: d.stopPoints,
        _key: d._key
      });
    }
  }
}

function start(config = cfg) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  const pollMs = resolved.pollMs || 5000;
  const state = new Map(); // file -> { mtime, keys:Set }

  function tick() {
    for (const acc of accounts) {
      const file = acc.path;
      if (!file) continue;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      let info = state.get(file);
      if (!info) {
        info = { mtime: 0, keys: new Set() };
        state.set(file, info);
      }
      if (stat.mtimeMs <= info.mtime) continue;
      info.mtime = stat.mtimeMs;
      const deals = processFile(file);
      for (const d of deals) {
        const key = d._key || `${d.symbol}|${d.placingTime}`;
        if (info.keys.has(key)) continue;
        info.keys.add(key);
        dealTrackers.notifyPositionClosed({
          ticker: d.symbol,
          tp: d.takeSetup,
          sp: d.stopSetup,
          status: d.result,
          profit: d.profit,
          commission: d.commission,
          takePoints: d.takePoints,
          stopPoints: d.stopPoints,
          _key: d._key
        });
      }
    }
  }

  tick();
  const timer = setInterval(tick, pollMs);
  return { stop() { clearInterval(timer); } };
}

module.exports = { processAll, processFile, buildDeal, start };


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

function timeToMinutes(hm) {
  const [h, m] = hm.split(':').map(n => Number(n) || 0);
  return h * 60 + m;
}

function findSession(timeStr, map) {
  if (!timeStr || !map) return undefined;
  const hm = timeStr.slice(0, 5);
  const t = timeToMinutes(hm);
  for (const [range, val] of Object.entries(map)) {
    const [startStr, endStr] = range.split('-');
    const start = timeToMinutes(startStr);
    const end = timeToMinutes(endStr);
    if (start <= end) {
      if (t >= start && t < end) return val;
    } else {
      if (t >= start || t < end) return val;
    }
  }
  return undefined;
}

function parseCsvText(text) {
  function parsePrice(str) {
    if (str === '') return { num: undefined, int: undefined, dec: 0, raw: '' };
    const dec = (str.split('.')[1] || '').length;
    const int = Number(str.replace('.', ''));
    return { num: Number(str), int, dec, raw: str };
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
      limitPriceStr: limit.raw,
      stopPrice: stop.num,
      stopPriceInt: stop.int,
      stopPriceDec: stop.dec,
      stopPriceStr: stop.raw,
      fillPrice: fill.num,
      fillPriceInt: fill.int,
      fillPriceDec: fill.dec,
      fillPriceStr: fill.raw,
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

function buildDeal(group, sessions = cfg.sessions) {
  if (!Array.isArray(group) || group.length === 0) return null;
  group.sort((a, b) => a.orderId - b.orderId);
  const entry = group[0];
  const rawSymbol = entry.symbol || '';
  const rawPlacingTime = entry.placingTime || '';
  const ticker = rawSymbol.split(':').pop();
  const placingParts = rawPlacingTime.split(' ');
  const placingDate = placingParts[0];
  const placingTime = placingParts[1];
  const filled = group.filter(o => String(o.status).toLowerCase() === 'filled');
  if (filled.length < 2) return null;
  const closing = filled.find(o => o !== entry) || filled[1];

  function pricePoints(aStr, bStr) {
    if (!aStr || !bStr) return undefined;
    const fracLen = s => (s.includes('.') ? s.split('.')[1].length : 0);
    const decimals = Math.max(fracLen(aStr), fracLen(bStr));
    const scale = 10 ** decimals;
    const a = Math.round(parseFloat(aStr) * scale);
    const b = Math.round(parseFloat(bStr) * scale);
    return Math.abs(a - b);
  }

  const side = String(entry.side).toLowerCase() === 'sell' ? 'short' : 'long';
  const type = String(entry.type).toLowerCase();
  let price, priceStr;
  if (type === 'limit') {
    price = entry.limitPrice;
    priceStr = entry.limitPriceStr;
  } else if (type === 'stop') {
    price = entry.stopPrice;
    priceStr = entry.stopPriceStr;
  } else {
    price = entry.fillPrice;
    priceStr = entry.fillPriceStr;
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
  if (takeOrder && takeOrder.limitPriceStr) {
    takeSetup = pricePoints(takeOrder.limitPriceStr, priceStr);
    if (takeSetup != null) takeSetup = Math.floor(takeSetup);
  }
  if (stopOrder && stopOrder.stopPriceStr) {
    stopSetup = pricePoints(stopOrder.stopPriceStr, priceStr);
    if (stopSetup != null) stopSetup = Math.floor(stopSetup);
  }

  const result = side === 'long'
    ? (closing.fillPrice > entry.fillPrice ? 'take' : 'stop')
    : (closing.fillPrice < entry.fillPrice ? 'take' : 'stop');

  let takePoints, stopPoints;
  const diffPoints = pricePoints(closing.fillPriceStr, priceStr);
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

  let tradeRisk;
  if (stopSetup != null) {
    if (result === 'stop' && stopPoints && stopPoints !== 0) {
      const pricePerPoint = Math.abs(profit) / stopPoints;
      tradeRisk = Math.round(pricePerPoint * stopSetup * 100) / 100;
    } else if (result === 'take' && takePoints && takePoints !== 0) {
      const pricePerPoint = Math.abs(profit) / takePoints;
      tradeRisk = Math.round(pricePerPoint * stopSetup * 100) / 100;
    }
  }

  const tradeSession = findSession(placingTime, sessions);

  return {
    _key: `${rawSymbol}|${rawPlacingTime}`,
    symbol: ticker,
    placingTime: placingDate,
    tradeSession,
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
    profit,
    tradeRisk
  };
}

function processFile(file, sessions = cfg.sessions) {
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
    const d = buildDeal(arr, sessions);
    if (d) deals.push(d);
  }
  return deals;
}

function processAll(config = cfg) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  const sessions = resolved.sessions;
  const opts = Array.isArray(resolved.skipExisting) ? { skipExisting: resolved.skipExisting } : undefined;
  for (const acc of accounts) {
    const file = acc.path;
    if (!file) continue;
    const deals = processFile(file, sessions);
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
        side: d.side,
        tactic: acc.tactic,
        tradeRisk: d.tradeRisk,
        tradeSession: d.tradeSession,
        _key: d._key
      }, opts);
    }
  }
}

function start(config = cfg) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  const pollMs = resolved.pollMs || 5000;
  const sessions = resolved.sessions;
  const opts = Array.isArray(resolved.skipExisting) ? { skipExisting: resolved.skipExisting } : undefined;
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
      const deals = processFile(file, sessions);
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
          side: d.side,
          tactic: acc.tactic,
          tradeRisk: d.tradeRisk,
          tradeSession: d.tradeSession,
          _key: d._key
        }, opts);
      }
    }
  }

  tick();
  const timer = setInterval(tick, pollMs);
  return { stop() { clearInterval(timer); } };
}

module.exports = { processAll, processFile, buildDeal, start };


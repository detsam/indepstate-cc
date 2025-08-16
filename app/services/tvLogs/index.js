const fs = require('fs');
const dealTrackers = require('../dealTrackers');
const { calcDealData } = require('../dealTrackers/calc');
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

// ---- tick detection helpers ----
// BigInt GCD
function bgcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function fracLen(s) {
  s = String(s);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

// convert price to integer units at scale D
function toUnits(s, D) {
  s = String(s).trim();
  let neg = false;
  if (s[0] === '-') {
    neg = true;
    s = s.slice(1);
  }
  const [ip = '0', fp = ''] = s.split('.');
  const fpad = (fp + '0'.repeat(D)).slice(0, D);
  const digits = (ip.replace(/^0+(?=\d)/, '') || '0') + fpad;
  const bi = BigInt(digits);
  return neg ? -bi : bi;
}

function detectTick(prices, { minDecimals = 8 } = {}) {
  if (!prices || prices.length < 2) return { D: minDecimals, tickUnits: 1n };
  let D = Math.max(...prices.map(p => fracLen(String(p))));
  if (D < minDecimals) D = minDecimals;
  const U = prices.map(p => toUnits(p, D)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const diffs = [];
  for (let i = 1; i < U.length; i++) {
    let d = U[i] - U[i - 1];
    if (d !== 0n) {
      if (d < 0n) d = -d;
      diffs.push(d);
    }
  }
  if (!diffs.length) return { D, tickUnits: 1n };
  let tickUnits = diffs[0];
  for (let i = 1; i < diffs.length; i++) tickUnits = bgcd(tickUnits, diffs[i]);
  if (tickUnits <= 0n) tickUnits = 1n;
  return { D, tickUnits };
}

function pointsBetween(a, b, meta) {
  if (!meta) throw new Error('tick meta required');
  const { D, tickUnits } = meta;
  const A = toUnits(a, D);
  const B = toUnits(b, D);
  const diffUnits = A > B ? A - B : B - A;
  const q = diffUnits / tickUnits;
  const r = diffUnits % tickUnits;
  return r === 0n ? Number(q) : Number(diffUnits) / Number(tickUnits);
}

function detectTicks(rows) {
  const map = new Map();
  for (const r of rows) {
    const arr = map.get(r.symbol) || [];
    if (r.limitPriceStr) arr.push(r.limitPriceStr);
    if (r.stopPriceStr) arr.push(r.stopPriceStr);
    if (r.fillPriceStr) arr.push(r.fillPriceStr);
    map.set(r.symbol, arr);
  }
  const out = new Map();
  for (const [sym, prices] of map) {
    out.set(sym, detectTick(prices));
  }
  return out;
}

function buildDeal(group, sessions = cfg.sessions, tickMeta) {
  if (!Array.isArray(group) || group.length === 0) return null;
  group.sort((a, b) => a.orderId - b.orderId);
  const entry = group[0];
  const rawSymbol = entry.symbol || '';
  const rawPlacingTime = entry.placingTime || '';
  const symParts = rawSymbol.split(':');
  const ticker = symParts.pop();
  const exchange = symParts.length ? symParts[0] : undefined;
  const placingParts = rawPlacingTime.split(' ');
  const placingDate = placingParts[0];
  const placingTime = placingParts[1];
  const filled = group.filter(o => String(o.status).toLowerCase() === 'filled');
  if (filled.length < 2) return null;
  const closing = filled.find(o => o !== entry) || filled[1];

  if (!tickMeta) {
    const priceStrs = [];
    for (const o of group) {
      if (o.limitPriceStr) priceStrs.push(o.limitPriceStr);
      if (o.stopPriceStr) priceStrs.push(o.stopPriceStr);
      if (o.fillPriceStr) priceStrs.push(o.fillPriceStr);
    }
    tickMeta = detectTick(priceStrs);
  }

  function pricePoints(aStr, bStr) {
    if (!aStr || !bStr) return undefined;
    try {
      return pointsBetween(aStr, bStr, tickMeta);
    } catch {
      return undefined;
    }
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

  const rawCommission = filled.reduce((sum, o) => sum + (Number(o.commission) || 0), 0);
  const result = side === 'long'
    ? (closing.fillPrice > entry.fillPrice ? 'take' : 'stop')
    : (closing.fillPrice < entry.fillPrice ? 'take' : 'stop');

  let takePoints; let stopPoints;
  const diffPoints = pricePoints(closing.fillPriceStr, priceStr);
  if (result === 'take') {
    takePoints = diffPoints;
  } else {
    stopPoints = diffPoints;
  }

  const base = calcDealData({
    symbol: { exchange, ticker },
    side,
    entryPrice: price,
    exitPrice: closing.fillPrice,
    qty,
    takeSetup,
    stopSetup,
    commission: rawCommission,
    placingTime,
    sessions,
    takePoints,
    stopPoints,
    status: result
  });
  return { _key: `${rawSymbol}|${rawPlacingTime}`, placingTime: placingDate, ...base };
}

function processFile(file, sessions = cfg.sessions) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = parseCsvText(text);
  const metas = detectTicks(rows);
  const groups = groupOrders(rows);
  const deals = [];
  for (const arr of groups.values()) {
    const sym = arr[0] && arr[0].symbol;
    const meta = metas.get(sym);
    const d = buildDeal(arr, sessions, meta);
    if (d) deals.push(d);
  }
  return deals;
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
        const symKey = d.symbol && [d.symbol.exchange, d.symbol.ticker].filter(Boolean).join(':');
        const key = d._key || `${symKey}|${d.placingTime}`;
        if (info.keys.has(key)) continue;
        info.keys.add(key);
        dealTrackers.notifyPositionClosed({
          symbol: d.symbol,
          tp: d.tp,
          sp: d.sp,
          status: d.status,
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

module.exports = { processFile, buildDeal, start };

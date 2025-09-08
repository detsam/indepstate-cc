const fs = require('fs');
const path = require('path');
const dealTrackers = require('../../dealTrackers/comps');
const { calcDealData } = require('../../dealTrackers/comps/calc');
const { compose1D, compose5M } = require('../../dealTrackers-chartImages/comps');

const loadConfig = require('../../../config/load');
const DEFAULT_MAX_AGE_DAYS = 2;
const DEFAULT_SYMBOL_REPLACE = s => String(s || '').replace(/(.*)PERP$/, 'BINANCE:$1.P');
const DEFAULT_MAKER_FEE_PCT = 0.02;
const DEFAULT_TAKER_FEE_PCT = 0.05;
let cfg = {};
try {
  cfg = loadConfig('../services/dealTrackers-source-tv-log/config/tv-logs.json');
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

  function splitLine(str) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"') {
        if (inQuotes && str[i + 1] === '"') { // escaped quote
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  const lines = String(text).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('Symbol')) continue;
    const parts = splitLine(line);
    if (parts.length < 13) continue;
    let symbol, side, type, qtyStr, limitPriceStr, stopPriceStr, fillPriceStr;
    let status, commissionStr = '', placingTime, closingTime, orderIdStr;

    // New format: Symbol,Side,Type,Qty,QtyFilled,Limit Price,Stop Price,Fill Price,Status,Time,Reduce Only,Post Only,Close On Trigger,Order ID
    const looksLikeDate = s => !isNaN(Date.parse(s));
    const newFmt = parts.length >= 14 && isNaN(Number(parts[8])) && looksLikeDate(parts[9]);
    if (newFmt) {
      [symbol, side, type, qtyStr, _filledQty, limitPriceStr, stopPriceStr, fillPriceStr,
        status, placingTime, _reduceOnly, _postOnly, _closeOnTrigger, orderIdStr] = parts;
      closingTime = placingTime;
    } else {
      [symbol, side, type, qtyStr, limitPriceStr, stopPriceStr, fillPriceStr,
        status, commissionStr, /* _lev */, /* _margin */, placingTime, closingTime, orderIdStr] = parts;
    }

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
      ...(function parseOrderId(idStr) {
        const nums = String(idStr).match(/\d+/g) || [];
        if (!nums.length) return { orderId: 0 };
        const base = Number(nums[0]);
        if (nums.length === 1) return { orderId: base, groupId: base };
        const frac = Number(nums[1]);
        const denom = Math.pow(10, String(frac).length + 1);
        return { orderId: base + frac / denom, groupId: base };
      })(orderIdStr)
    };
    rows.push(row);
  }
  return rows;
}

function groupOrders(rows) {
  // Keep rows in chronological order so we can pair market exits
  // with the latest open deal for the symbol.
  rows = Array.isArray(rows) ? [...rows] : [];
  rows.sort((a, b) => {
    const ta = Date.parse(a.placingTime);
    const tb = Date.parse(b.placingTime);
    if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
    return a.orderId - b.orderId;
  });

  const map = new Map();
  const lastKey = new Map(); // symbol -> latest group key awaiting close

  for (const r of rows) {
    let key = `${r.symbol}|${r.groupId != null ? r.groupId : r.placingTime}`;
    const type = String(r.type).toLowerCase();
    const status = String(r.status).toLowerCase();

    // TradingView assigns a new placing time to exit orders. If there is an
    // existing open group for this symbol, merge subsequent opposite-side
    // orders into that group so the deal closes properly.
    const prev = lastKey.get(r.symbol);
    if (prev && prev !== key && map.has(prev)) {
      if (type === 'market' && status === 'filled') {
        key = prev;
      } else {
        const prevArr = map.get(prev);
        const entry = prevArr && prevArr.find(o => String(o.status).toLowerCase() === 'filled');
        if (entry && String(entry.side).toLowerCase() !== String(r.side).toLowerCase()) {
          key = prev;
        }
      }
    }

    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    arr.push(r);

    if (status === 'filled') {
      // remember this group as the active one for the symbol
      lastKey.set(r.symbol, key);
      const filledCount = arr.filter(o => String(o.status).toLowerCase() === 'filled').length;
      if (filledCount >= 2) {
        // deal has both entry and exit, stop tracking
        lastKey.delete(r.symbol);
      }
    }
  }

  return map;
}


function buildDeal(group, sessions = cfg.sessions, fees) {
  if (!Array.isArray(group) || group.length === 0) return null;
  group.sort((a, b) => {
    const ta = Date.parse(a.placingTime);
    const tb = Date.parse(b.placingTime);
    if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
    return a.orderId - b.orderId;
  });
  const filled = group.filter(o => String(o.status).toLowerCase() === 'filled');
  const entry = filled.find(o => !/stop loss|take profit/i.test(o.type));
  if (!entry) return null;
  const closing = filled.find(o => o !== entry);
  if (!closing) return null;
  const rawSymbol = entry.symbol || '';
  const rawPlacingTime = entry.placingTime || '';
  const symParts = rawSymbol.split(':');
  const ticker = symParts.pop();
  const exchange = symParts.length ? symParts[0] : undefined;
  const [placingDate, placingTime] = String(rawPlacingTime).split(/\s+/);

  function pricePoints(aStr, bStr) {
    if (!aStr || !bStr) return undefined;
    const D = (String(bStr).split('.')[1] || '').length;
    const tick = Math.pow(10, -D);
    const diff = Math.abs(Number(aStr) - Number(bStr));
    if (!Number.isFinite(diff) || tick === 0) return undefined;
    return diff / tick;
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

  let takeOrder = group.find(o => /take profit/i.test(o.type));
  let stopOrder = group.find(o => /stop loss/i.test(o.type));
  if (!takeOrder || !stopOrder) {
    for (const o of group) {
      if (o === entry) continue;
      if (!takeOrder) {
        if (side === 'long') {
          if (o.limitPrice != null && o.limitPrice > price) takeOrder = o;
        } else {
          if (o.limitPrice != null && o.limitPrice < price) takeOrder = o;
        }
      }
      if (!stopOrder) {
        if (side === 'long') {
          if (o.stopPrice != null && o.stopPrice < price) stopOrder = o;
        } else {
          if (o.stopPrice != null && o.stopPrice > price) stopOrder = o;
        }
      }
    }
  }

  let takeSetup, stopSetup;
  if (takeOrder) {
    const tpStr = takeOrder.limitPriceStr || takeOrder.stopPriceStr || takeOrder.fillPriceStr;
    if (tpStr) {
      takeSetup = pricePoints(tpStr, priceStr);
      if (takeSetup != null) takeSetup = Math.floor(takeSetup);
    }
  }
  if (stopOrder) {
    const spStr = stopOrder.stopPriceStr || stopOrder.limitPriceStr || stopOrder.fillPriceStr;
    if (spStr) {
      stopSetup = pricePoints(spStr, priceStr);
      if (stopSetup != null) stopSetup = Math.floor(stopSetup);
    }
  }

  let rawCommission = filled.reduce((sum, o) => sum + (Number(o.commission) || 0), 0);
  if (!rawCommission && fees) {
    const makerPct = typeof fees.maker === 'number' ? fees.maker : DEFAULT_MAKER_FEE_PCT;
    const takerPct = typeof fees.taker === 'number' ? fees.taker : DEFAULT_TAKER_FEE_PCT;
    const rate = t => (/market|stop/i.test(String(t)) ? takerPct : makerPct) / 100;
    rawCommission = qty * price * rate(entry.type) + qty * closing.fillPrice * rate(closing.type);
  }
  const result = side === 'long'
    ? (closing.fillPrice > entry.fillPrice ? 'take' : 'stop')
    : (closing.fillPrice < entry.fillPrice ? 'take' : 'stop');

  let takePoints; let stopPoints;
  let diffPoints = pricePoints(closing.fillPriceStr, priceStr);
  if (diffPoints != null) diffPoints = Math.floor(diffPoints);
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
  return { _key: `${rawSymbol}|${rawPlacingTime}`, placingDate, placingTime, ...base };
}

function processFile(file, sessions = cfg.sessions, maxAgeDays = DEFAULT_MAX_AGE_DAYS, symbolReplace = DEFAULT_SYMBOL_REPLACE, fees) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = parseCsvText(text);
  if (typeof symbolReplace === 'function') {
    for (const r of rows) r.symbol = symbolReplace(r.symbol);
  }
  const groups = groupOrders(rows);
  const deals = [];
  for (const arr of groups.values()) {
    const d = buildDeal(arr, sessions, fees);
    if (d) deals.push(d);
  }
  if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    return deals.filter(d => {
      const t = Date.parse(d.placingDate);
      return isNaN(t) ? true : t >= cutoff;
    });
  }
  return deals;
}

function start(config = cfg) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts)
    ? resolved.accounts.map(acc => {
      let fn = acc.symbolReplace;
      if (typeof fn === 'string') {
        try { fn = new Function('s', fn); } catch { fn = null; }
      }
      if (typeof fn !== 'function') fn = DEFAULT_SYMBOL_REPLACE;
      let fees = acc.fees;
      if (fees === null || fees === false) {
        fees = undefined;
      } else {
        const maker = fees && typeof fees.maker === 'number' ? fees.maker : DEFAULT_MAKER_FEE_PCT;
        const taker = fees && typeof fees.taker === 'number' ? fees.taker : DEFAULT_TAKER_FEE_PCT;
        fees = { maker, taker };
      }
      return { ...acc, symbolReplace: fn, fees };
    })
    : [];
  const pollMs = resolved.pollMs || 5000;
  const sessions = resolved.sessions;
  const opts = Array.isArray(resolved.skipExisting) ? { skipExisting: resolved.skipExisting } : undefined;
  const state = new Map(); // dir -> { files:Set, keys:Set, initialized:bool }

  // chart image composer handled by default service

  function processAndNotify(file, acc, info) {
    const maxAgeDays = typeof acc.maxAgeDays === 'number' ? acc.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    const deals = processFile(file, sessions, maxAgeDays, acc.symbolReplace, acc.fees);
    for (const d of deals) {
      const symKey = d.symbol && [d.symbol.exchange, d.symbol.ticker].filter(Boolean).join(':');
      const key = d._key || `${symKey}|${d.placingDate} ${d.placingTime}`;
      if (info.keys.has(key)) continue;
      if (!dealTrackers.shouldWritePositionClosed(d, opts)) continue;
      info.keys.add(key);
      const chart1D = symKey ? compose1D(symKey) : undefined;
      const chart5M = symKey ? compose5M(symKey) : undefined;
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
        placingDate: d.placingDate,
        chart1D,
        chart5M,
        _key: d._key
      }, opts);
    }
  }

  function listFiles(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      const t = stat.birthtimeMs || stat.mtimeMs || 0;
      out.push({ file: full, time: t });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function tick() {
    for (const acc of accounts) {
      const dir = acc.dir || acc.path;
      if (!dir) continue;
      const files = listFiles(dir);
      if (!files.length) continue;
      let info = state.get(dir);
      if (!info) {
        info = { files: new Set(), keys: new Set(), initialized: false };
        state.set(dir, info);
      }
      if (!info.initialized) {
        const latest = files[files.length - 1].file;
        processAndNotify(latest, acc, info);
        info.files.add(latest);
        info.initialized = true;
      } else {
        for (const { file } of files) {
          if (info.files.has(file)) continue;
          processAndNotify(file, acc, info);
          info.files.add(file);
        }
      }
    }
  }

  tick();
  const timer = setInterval(tick, pollMs);
  return { stop() { clearInterval(timer); } };
}

module.exports = { processFile, buildDeal, start };

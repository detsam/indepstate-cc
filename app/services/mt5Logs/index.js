const fs = require('fs');
const path = require('path');
const dealTrackers = require('../dealTrackers');
const { calcDealData } = require('../dealTrackers/calc');
const loadConfig = require('../../config/load');
const DEFAULT_MAX_AGE_DAYS = 2;
let cfg = {};
try {
  cfg = loadConfig('mt5-logs.json');
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

function extractText(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function parseHtmlText(text) {
  const rows = [];
  // Extract the Positions section. If no later section header is found, fall back to the end of the document
  const sectionMatch = String(text).match(
    /<b>Positions<\/b>[\s\S]*?(?:<b>Orders<\/b>|<b>Deals<\/b>|<b>Open Positions<\/b>|$)/i
  );
  const section = sectionMatch ? sectionMatch[0] : '';
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = trRe.exec(section))) {
    const rowHtml = match[1];
    if (/^\s*<th/i.test(rowHtml)) continue;
    const cells = [];
    // Skip hidden cells regardless of quoting style
    const tdRe = /<td(?![^>]*class=['"]?hidden['"]?)[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = tdRe.exec(rowHtml))) {
      cells.push(extractText(m[1]));
    }
    if (cells.length < 13) continue;
    if (!/^\d{4}/.test(cells[0])) continue;
    const [openTime, positionId, symbol, side, volumeStr, openPriceStr, slStr, tpStr, closeTime, closePriceStr, commissionStr, swapStr, profitStr] = cells;
    rows.push({
      openTime,
      positionId: Number(positionId),
      symbol,
      side,
      volume: Number(volumeStr),
      openPrice: Number(openPriceStr),
      openPriceStr,
      sl: slStr ? Number(slStr) : undefined,
      slStr: slStr || undefined,
      tp: tpStr ? Number(tpStr) : undefined,
      tpStr: tpStr || undefined,
      closeTime,
      closePrice: Number(closePriceStr),
      closePriceStr,
      commission: commissionStr ? Number(commissionStr) : 0,
      swap: swapStr ? Number(swapStr) : 0,
      profit: profitStr ? Number(profitStr) : 0
    });
  }
  return rows;
}

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

function buildDeal(row, sessions = cfg.sessions) {
  if (!row) return null;
  const {
    symbol: rawSymbol,
    openTime: rawOpenTime,
    side: rawSide,
    volume: qty,
    openPrice,
    openPriceStr,
    slStr,
    tpStr,
    closePrice,
    closePriceStr,
    commission,
    profit
  } = row;
  const [placingDate, placingTime] = String(rawOpenTime).split(/\s+/);
  const side = String(rawSide).toLowerCase() === 'sell' ? 'short' : 'long';

  const priceStrs = [openPriceStr];
  if (slStr) priceStrs.push(slStr);
  if (tpStr) priceStrs.push(tpStr);
  if (closePriceStr) priceStrs.push(closePriceStr);
  const tickMeta = detectTick(priceStrs);

  function pricePoints(aStr, bStr) {
    if (!aStr || !bStr) return undefined;
    try {
      return pointsBetween(aStr, bStr, tickMeta);
    } catch {
      return undefined;
    }
  }

  let takeSetup, stopSetup;
  if (tpStr) {
    takeSetup = pricePoints(tpStr, openPriceStr);
    if (takeSetup != null) takeSetup = Math.floor(takeSetup);
  }
  if (slStr) {
    stopSetup = pricePoints(slStr, openPriceStr);
    if (stopSetup != null) stopSetup = Math.floor(stopSetup);
  }

  const status = profit >= 0 ? 'take' : 'stop';
  let takePoints; let stopPoints;
  const diffPoints = pricePoints(closePriceStr, openPriceStr);
  if (status === 'take') {
    takePoints = diffPoints;
  } else {
    stopPoints = diffPoints;
  }

  const base = calcDealData({
    symbol: { ticker: rawSymbol },
    side,
    entryPrice: openPrice,
    exitPrice: closePrice,
    qty,
    takeSetup,
    stopSetup,
    commission,
    profit,
    takePoints,
    stopPoints,
    placingTime: rawOpenTime,
    sessions,
    status
  });
  return { _key: `${rawSymbol}|${rawOpenTime}`, placingDate, placingTime, ...base };
}

function processFile(file, sessions = cfg.sessions, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  let text;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      text = buf.toString('utf16le');
    } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      text = buf.toString('utf16be');
    } else {
      text = buf.toString('utf8');
    }
  } catch {
    return [];
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = parseHtmlText(text);
  const deals = rows.map(r => buildDeal(r, sessions)).filter(Boolean);
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
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  const pollMs = resolved.pollMs || 5000;
  const sessions = resolved.sessions;
  const opts = Array.isArray(resolved.skipExisting) ? { skipExisting: resolved.skipExisting } : undefined;
  const state = new Map();

  function processAndNotify(file, acc, info) {
    const maxAgeDays = typeof acc.maxAgeDays === 'number' ? acc.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    const deals = processFile(file, sessions, maxAgeDays);
    for (const d of deals) {
      const symKey = d.symbol && [d.symbol.exchange, d.symbol.ticker].filter(Boolean).join(':');
      const key = d._key || `${symKey}|${d.placingDate} ${d.placingTime}`;
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
        placingDate: d.placingDate,
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

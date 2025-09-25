const fs = require('fs');
const path = require('path');
const dealTrackers = require('../../dealTrackers/comps');
const { calcDealData } = require('../../dealTrackers/comps/calc');
const loadConfig = require('../../../config/load');
const { resolveFilePath: resolveExecutionLogPath } = require('../../execution-log');

const DEFAULT_MAX_AGE_DAYS = 2;
const CID_IN_TEXT_RE = /cid[:=]\s*([a-z0-9]+)/i;
let cfg = {};
try {
  cfg = loadConfig('../services/dealTrackers-source-mt5-log/config/mt5-logs.json');
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

function normalizeCid(candidate) {
  if (candidate == null) return '';
  let str = String(candidate).trim();
  if (!str) return '';
  const cidMatch = str.match(CID_IN_TEXT_RE);
  if (cidMatch) return cidMatch[1];
  if (str.startsWith('pending:')) return str.slice('pending:'.length);
  return str;
}

function extractCidFromRow(html) {
  if (!html) return undefined;
  const match = String(html).match(CID_IN_TEXT_RE);
  if (!match) return undefined;
  return normalizeCid(match[0]);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function resolveExecutionLogFilePathFromConfig() {
  let executionCfg = {};
  try {
    executionCfg = loadConfig('../services/execution-log/config/execution-log.json');
  } catch {
    executionCfg = {};
  }
  if (typeof resolveExecutionLogPath === 'function') {
    try {
      return resolveExecutionLogPath(executionCfg.file);
    } catch {}
  }
  const base = loadConfig.USER_ROOT || loadConfig.APP_ROOT || process.cwd();
  if (executionCfg && typeof executionCfg.file === 'string' && executionCfg.file.trim()) {
    const normalized = executionCfg.file.trim();
    if (path.isAbsolute(normalized)) return normalized;
    return path.join(base, normalized);
  }
  return path.join(base, 'logs', 'execution-log.jsonl');
}

function createExecutionLogLookup(filePath) {
  if (!filePath) return null;
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('mt5Logs: cannot read execution log', err);
    }
    return null;
  }
  if (!text) {
    return () => undefined;
  }
  const map = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line && line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const cid = normalizeCid(entry?.cid || entry?.meta?.cid || entry?.comment || entry?.meta?.comment || entry?.clientOrderId);
    if (!cid || map.has(cid)) continue;
    const sl = toNumber(entry?.sl ?? entry?.stopPrice ?? entry?.meta?.sl ?? entry?.meta?.stopPrice);
    const tp = toNumber(entry?.tp ?? entry?.meta?.tp ?? entry?.takeProfit ?? entry?.meta?.takeProfit);
    map.set(cid, { sl, tp });
  }
  if (!map.size) {
    return () => undefined;
  }
  return (rawCid) => {
    const cid = normalizeCid(rawCid);
    if (!cid) return undefined;
    return map.get(cid);
  };
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
    const cid = extractCidFromRow(rowHtml);
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
      sl: slStr ? Number(slStr) : undefined,
      tp: tpStr ? Number(tpStr) : undefined,
      closeTime,
      closePrice: Number(closePriceStr),
      commission: commissionStr ? Number(commissionStr) : 0,
      swap: swapStr ? Number(swapStr) : 0,
      profit: profitStr ? Number(profitStr) : 0,
      cid
    });
  }
  return rows;
}

function priceDiff(a, b) {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return undefined;
  return Math.abs(A - B);
}

function diffPoints(a, b) {
  const diff = priceDiff(a, b);
  if (diff == null) return undefined;
  return Math.round(diff * 100);
}

function parseMtTime(str) {
  const [datePart = '', timePart = ''] = String(str).split(' ');
  const [y, m, d] = datePart.split('.').map(n => Number(n) || 0);
  const [H = 0, M = 0, S = 0] = timePart.split(':').map(n => Number(n) || 0);
  return new Date(y, m - 1, d, H, M, S).getTime();
}

function computeMoveActual({ side, openPrice, openTime }, bars = []) {
  if (!Array.isArray(bars) || bars.length === 0) return undefined;
  const entryTs = parseMtTime(openTime);
  const relevant = bars.filter(b => {
    const t = b.time != null && typeof b.time === 'number' ? b.time : parseMtTime(b.time);
    return t >= entryTs;
  });
  if (!relevant.length) return undefined;
  let extreme = openPrice;
  for (const bar of relevant) {
    const high = Number(bar.high);
    const low = Number(bar.low);
    if (side === 'long') {
      if (high > extreme) extreme = high;
    } else {
      if (low < extreme) extreme = low;
    }
  }
  return diffPoints(extreme, openPrice) || 0;
}

function computeMoveReverse({ side, openPrice, openTime, closeTime }, bars = []) {
  if (!Array.isArray(bars) || bars.length === 0) return undefined;
  const entryTs = parseMtTime(openTime);
  const exitTs = parseMtTime(closeTime);
  const relevant = bars.filter(b => {
    const t = b.time != null && typeof b.time === 'number' ? b.time : parseMtTime(b.time);
    return t >= entryTs && t <= exitTs;
  });
  if (!relevant.length) return undefined;
  let extreme = openPrice;
  for (const bar of relevant) {
    const high = Number(bar.high);
    const low = Number(bar.low);
    if (side === 'long') {
      if (low < extreme) extreme = low;
    } else {
      if (high > extreme) extreme = high;
    }
  }
  return diffPoints(extreme, openPrice) || 0;
}

async function buildDeal(row, sessions = cfg.sessions, fetchBars, include, executionLookup) {
  if (!row) return null;
  const {
    symbol: rawSymbol,
    openTime: rawOpenTime,
    side: rawSide,
    volume: qty,
    openPrice,
    sl,
    tp,
    closeTime: rawCloseTime,
    closePrice,
    commission: rawCommission,
    profit,
    cid
  } = row;
  const [placingDateRaw = '', placingTime = ''] = String(rawOpenTime).split(/\s+/);
  const placingDate = placingDateRaw.replace(/\./g, '-');
  const side = String(rawSide).toLowerCase() === 'sell' ? 'short' : 'long';
  const key = `${rawSymbol}|${placingDate} ${placingTime}`;
  if (typeof include === 'function' && !include({ _key: key, placingDate, placingTime, symbol: { ticker: rawSymbol } })) {
    return null;
  }

  let takeSetup;
  let stopSetup;
  if (executionLookup && cid) {
    try {
      const initial = executionLookup(cid);
      if (initial) {
        if (initial.tp != null) {
          const tpPrice = toNumber(initial.tp);
          if (tpPrice != null) takeSetup = diffPoints(tpPrice, openPrice);
        }
        if (initial.sl != null) {
          const slPrice = toNumber(initial.sl);
          if (slPrice != null) stopSetup = diffPoints(slPrice, openPrice);
        }
      }
    } catch {}
  }
  if (takeSetup == null && tp != null) takeSetup = diffPoints(tp, openPrice);
  if (stopSetup == null && sl != null) stopSetup = diffPoints(sl, openPrice);

  const status = profit >= 0 ? 'take' : 'stop';
  let takePoints; let stopPoints;
  const resPoints = diffPoints(closePrice, openPrice);
  if (status === 'take') {
    takePoints = resPoints;
  } else {
    stopPoints = resPoints;
  }

  let commission = Math.abs(rawCommission);
  if (commission < 3) {
    const fee = qty < 500 ? 3 : qty * 0.006 * 2;
    commission = fee;
  }

  let moveActualEP;
  let moveReverse;
  if (typeof fetchBars === 'function') {
    try {
      const bars = await fetchBars(rawSymbol, placingDateRaw);
      moveActualEP = computeMoveActual({ side, openPrice, openTime: rawOpenTime }, bars);
      if (status === 'take') {
        moveReverse = computeMoveReverse({ side, openPrice, openTime: rawOpenTime, closeTime: rawCloseTime }, bars);
      }
    } catch {}
  }
  if (status === 'stop') moveReverse = stopSetup;

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
    placingTime,
    sessions,
    status
  });
  return { _key: key, placingDate, placingTime, moveActualEP, moveReverse, cid, ...base };
}

async function processFile(file, sessions = cfg.sessions, maxAgeDays = DEFAULT_MAX_AGE_DAYS, fetchBars, include, options = {}) {
  const opts = options || {};
  let executionLookup = opts.executionLookup;
  if (!executionLookup && (opts.executionLogPath || opts.useExecutionLogProvider)) {
    const resolvedPath = opts.executionLogPath || resolveExecutionLogFilePathFromConfig();
    executionLookup = createExecutionLogLookup(resolvedPath);
  }
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
  const deals = (await Promise.all(rows.map(r => buildDeal(r, sessions, fetchBars, include, executionLookup)))).filter(Boolean);
  if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    return deals.filter(d => {
      const t = Date.parse(d.placingDate);
      return isNaN(t) ? true : t >= cutoff;
    });
  }
  return deals;
}

function waitFor(fn, timeout = 5000, interval = 100) {
  const end = Date.now() + timeout;
  return new Promise(resolve => {
    (function check() {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() >= end) return resolve(null);
      setTimeout(check, interval);
    })();
  });
}

function start(config = cfg, { dwxClients = {}, compose1D, compose5M } = {}) {
  const resolved = resolveSecrets(config);
  const accounts = Array.isArray(resolved.accounts)
    ? resolved.accounts.map(acc => ({
      ...acc,
      deleteProcessedLogs: acc.deleteProcessedLogs !== false
    }))
    : [];
  const pollMs = resolved.pollMs || 5000;
  const sessions = resolved.sessions;
  const opts = Array.isArray(resolved.skipExisting) ? { skipExisting: resolved.skipExisting } : undefined;
  const state = new Map();

  const providerConfigs = typeof resolved.dwx === 'object' ? resolved.dwx : {};
  const clients = { ...dwxClients };
  const fetchBarsCache = new Map();
  const defaultProvider = resolved.dwxProvider;
  const useExecutionLogProvider =
    resolved.executionLogProvider === true ||
    (resolved.executionLogProvider == null && cfg.executionLogProvider === true);

  function getFetchBars(name) {
    const provider = name || defaultProvider;
    if (!provider) return undefined;
    if (fetchBarsCache.has(provider)) return fetchBarsCache.get(provider);
    let client = clients[provider];
    if (!client) {
      const cfg = providerConfigs[provider];
      if (cfg?.metatraderDirPath) {
        try {
          const { dwx_client } = require('../../brokerage-adapter-dwx/comps/dwx_client');
          client = new dwx_client({ metatrader_dir_path: cfg.metatraderDirPath });
          client.start();
          clients[provider] = client;
        } catch (e) {
          console.error('mt5Logs: failed to init dwx_client', e);
        }
      }
    }
    const fb = client ? async (symbol, date) => {
      const startTs = Math.floor(parseMtTime(`${date} 00:00`) / 1000);
      const endTs = startTs + 86400;
      try { await client.get_historic_data({ symbol, time_frame: 'M5', start: startTs, end: endTs }); } catch {}
      const key = `${symbol}_M5`;
      const data = await waitFor(() => client.historic_data[key], 5000);
      if (!data) return [];
      return Object.entries(data).map(([time, o]) => ({ time, ...o }));
    } : undefined;
    fetchBarsCache.set(provider, fb);
    return fb;
  }

  // chart image composer handled by default service

  async function processAndNotify(file, acc, info, executionOptions) {
    const maxAgeDays = typeof acc.maxAgeDays === 'number' ? acc.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    const fetchBars = getFetchBars(acc.dwxProvider);
    const include = d => dealTrackers.shouldWritePositionClosed(d, opts);
    const deals = await processFile(file, sessions, maxAgeDays, fetchBars, include, executionOptions);
    for (const d of deals) {
      const symKey = d.symbol && [d.symbol.exchange, d.symbol.ticker].filter(Boolean).join(':');
      const key = d._key || `${symKey}|${d.placingDate} ${d.placingTime}`;
      if (info.keys.has(key)) continue;
      info.keys.add(key);
      const chart1D = symKey && typeof compose1D === 'function' ? compose1D(symKey) : undefined;
      const chart5M = symKey && typeof compose5M === 'function' ? compose5M(symKey) : undefined;
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
        moveActualEP: d.moveActualEP,
        moveReverse: d.moveReverse,
        chart1D,
        chart5M,
        _key: d._key
      }, opts);
    }
  }

  function deleteProcessedFile(file, info) {
    try {
      fs.unlinkSync(file);
      if (info && info.files) info.files.delete(file);
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        if (info && info.files) info.files.delete(file);
        return true;
      }
      console.error('mt5Logs: failed to delete processed log', err);
      return false;
    }
  }

  function handleProcessedFile(file, acc, info) {
    if (acc.deleteProcessedLogs) {
      const deleted = deleteProcessedFile(file, info);
      if (!deleted && info && info.files) info.files.add(file);
    } else if (info && info.files) {
      info.files.add(file);
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

  async function tick() {
    let executionOptions;
    if (useExecutionLogProvider) {
      const logPath = resolveExecutionLogFilePathFromConfig();
      const lookup = logPath ? createExecutionLogLookup(logPath) : null;
      executionOptions = lookup
        ? { executionLookup: lookup }
        : { useExecutionLogProvider: true, executionLogPath: logPath };
    }
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
        await processAndNotify(latest, acc, info, executionOptions);
        handleProcessedFile(latest, acc, info);
        info.initialized = true;
      } else {
        for (const { file } of files) {
          if (info.files.has(file)) continue;
          await processAndNotify(file, acc, info, executionOptions);
          handleProcessedFile(file, acc, info);
        }
      }
    }
  }

  tick().catch(e => console.error('mt5Logs tick error', e));
  const timer = setInterval(() => { tick().catch(e => console.error('mt5Logs tick error', e)); }, pollMs);
  return { stop() { clearInterval(timer); } };
}

module.exports = { processFile, buildDeal, start };

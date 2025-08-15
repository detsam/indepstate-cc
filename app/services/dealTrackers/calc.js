const points = require('../points');

function round2(n) {
  return Math.round(n * 100) / 100;
}

function timeToMinutes(hm) {
  const [h, m] = String(hm).split(':').map(n => Number(n) || 0);
  return h * 60 + m;
}

function findSession(timeStr, map) {
  if (!timeStr || !map) return undefined;
  const hm = String(timeStr).slice(0, 5);
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

function calcDealData(data = {}) {
  const {
    ticker,
    side,
    entryPrice,
    exitPrice: rawExit,
    qty,
    takeSetup,
    stopSetup,
    commission = 0,
    profit: rawProfit,
    placingTime,
    sessions,
    tradeSession: preSession
  } = data;

  let exitPrice = Number(rawExit);
  let profit = rawProfit != null ? Number(rawProfit) : undefined;
  const entry = Number(entryPrice);
  const quantity = Number(qty);

  if (profit == null && exitPrice != null && entry != null && quantity != null) {
    profit = side === 'short'
      ? (entry - exitPrice) * quantity
      : (exitPrice - entry) * quantity;
  }
  if (exitPrice == null && profit != null && entry != null && quantity != null) {
    exitPrice = side === 'short'
      ? entry - profit / quantity
      : entry + profit / quantity;
  }
  if (!Number.isFinite(profit)) profit = 0;

  const status = profit >= 0 ? 'take' : 'stop';

  let takePoints; let stopPoints;
  if (exitPrice != null && entry != null) {
    const diff = exitPrice - entry;
    const pts = points.toPoints(ticker, diff, undefined, diff);
    if (status === 'take') {
      takePoints = pts;
    } else {
      stopPoints = pts;
    }
  }

  let tradeRisk;
  if (stopSetup != null) {
    const basePts = status === 'take' ? takePoints : stopPoints;
    if (basePts && basePts !== 0) {
      const pricePerPoint = Math.abs(profit) / basePts;
      tradeRisk = round2(pricePerPoint * stopSetup);
    }
  }

  let tradeSession = preSession;
  if (tradeSession == null && placingTime && sessions) {
    tradeSession = findSession(placingTime, sessions);
  }

  const out = {
    ticker,
    tp: takeSetup,
    sp: stopSetup,
    status,
    profit: round2(profit),
    commission: commission ? round2(commission) : undefined,
    takePoints,
    stopPoints,
    side,
    tradeRisk,
    tradeSession
  };
  return out;
}

module.exports = { calcDealData };


function normalizeBar(bar) {
  if (!bar || typeof bar !== 'object') return null;
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  const timeRaw = bar.time != null ? Number(bar.time) : (bar.timestamp != null ? Number(bar.timestamp) : undefined);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }
  const normalized = { open: Number.isFinite(open) ? open : undefined, high, low, close };
  if (Number.isFinite(timeRaw)) normalized.time = timeRaw;
  return normalized;
}

function dedupeBars(bars) {
  const byTime = new Map();
  for (const bar of bars) {
    if (!bar) continue;
    if (bar.time == null) {
      byTime.set(Symbol('no-time'), bar);
      continue;
    }
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values());
}

function sortBarsAsc(bars) {
  return bars.slice().sort((a, b) => {
    const ta = a.time == null ? -Infinity : a.time;
    const tb = b.time == null ? -Infinity : b.time;
    return ta - tb;
  });
}

function mergeBars(existing, incoming, maxBars) {
  const base = Array.isArray(existing) ? existing : [];
  const additions = Array.isArray(incoming) ? incoming : (incoming ? [incoming] : []);
  if (!base.length && !additions.length) return [];
  const merged = dedupeBars([...base, ...additions]);
  const sorted = sortBarsAsc(merged);
  if (Number.isFinite(maxBars) && maxBars > 0 && sorted.length > maxBars) {
    return sorted.slice(-maxBars);
  }
  return sorted;
}

async function loadAndMergeHistory({
  historyLoader,
  historyTimeframe,
  historyLimit,
  price,
  side,
  symbol,
  existingBars,
  normalizeBar: normalize,
  mergeBars: merge,
  maxBars
} = {}) {
  if (typeof historyLoader !== 'function') return Array.isArray(existingBars) ? existingBars : [];
  const fetched = await historyLoader({
    limit: historyLimit,
    timeframe: historyTimeframe,
    price,
    side,
    symbol
  });
  if (!Array.isArray(fetched)) return Array.isArray(existingBars) ? existingBars : [];
  const normalized = fetched.map(normalize).filter(Boolean);
  if (!normalized.length) return Array.isArray(existingBars) ? existingBars : [];
  return merge(existingBars, normalized, maxBars);
}

module.exports = {
  normalizeBar,
  dedupeBars,
  sortBarsAsc,
  mergeBars,
  loadAndMergeHistory
};

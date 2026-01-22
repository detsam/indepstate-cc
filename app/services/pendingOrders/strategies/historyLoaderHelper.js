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

function defaultMergeBars(existing, incoming, maxBars) {
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
  normalizeBar,
  mergeBars,
  maxBars
} = {}) {
  if (typeof historyLoader !== 'function') return null;
  const fetched = await historyLoader({
    limit: historyLimit,
    timeframe: historyTimeframe,
    price,
    side,
    symbol
  });
  if (!Array.isArray(fetched)) return null;
  const normalized = typeof normalizeBar === 'function'
    ? fetched.map(normalizeBar).filter(Boolean)
    : fetched.filter(Boolean);
  if (!normalized.length) return null;
  const merger = typeof mergeBars === 'function' ? mergeBars : defaultMergeBars;
  return merger(existingBars, normalized, maxBars);
}

module.exports = {
  loadAndMergeHistory
};

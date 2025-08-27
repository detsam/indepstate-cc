// services/dealTrackers/index.js
// Registry for deal trackers interested in position close events

const trackers = [];
let enabled = true;

// Support secrets like "$ENV:NAME" or "${ENV:NAME}" similar to adapter config
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

function buildChartComposer(cfg = {}) {
  const type = String(cfg.type || '').toLowerCase();
  switch (type) {
    case 'tv': {
      const { TvChartImageComposer } = require('../chartImages/tv');
      return new TvChartImageComposer(cfg);
    }
    default:
      console.warn('[dealTrackers] unknown chart composer type', type);
      return null;
  }
}

function init(cfg = {}) {
  enabled = cfg.enabled !== false;
  trackers.length = 0;
  const list = Array.isArray(cfg.trackers) ? cfg.trackers : [];
  for (const t of list) {
    const resolved = resolveSecrets(t);
    const type = String(resolved.type || '').toLowerCase();
    switch (type) {
      case 'obsidian': {
        const { ObsidianDealTracker } = require('./obsidian');
        if (resolved.chartImageComposer) {
          resolved.chartImageComposer = buildChartComposer(resolved.chartImageComposer);
        }
        trackers.push(new ObsidianDealTracker(resolved));
        break;
      }
      default:
        console.warn('[dealTrackers] unknown tracker type', type);
    }
  }
}

function notifyPositionClosed(info, opts) {
  if (!enabled) return;
  for (const t of trackers) {
    try {
      const res = t.onPositionClosed(info, opts);
      if (res && typeof res.then === 'function') res.catch(e => console.error('DealTracker error', e));
    } catch (e) {
      console.error('DealTracker error', e);
    }
  }
}

function shouldWritePositionClosed(info, opts) {
  for (const t of trackers) {
    try {
      if (typeof t.shouldWrite === 'function' && t.shouldWrite(info, opts)) return true;
    } catch (e) {
      console.error('DealTracker error', e);
    }
  }
  return false;
}

module.exports = { init, notifyPositionClosed, shouldWritePositionClosed };

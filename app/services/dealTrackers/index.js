// services/dealTrackers/index.js
// Registry for deal trackers interested in position close events

const trackers = [];

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

function init(cfg = {}) {
  trackers.length = 0;
  const list = Array.isArray(cfg.trackers) ? cfg.trackers : [];
  for (const t of list) {
    const resolved = resolveSecrets(t);
    const type = String(resolved.type || '').toLowerCase();
    switch (type) {
      case 'obsidian': {
        const { ObsidianDealTracker } = require('./obsidian');
        trackers.push(new ObsidianDealTracker(resolved));
        break;
      }
      default:
        console.warn('[dealTrackers] unknown tracker type', type);
    }
  }
}

function notifyPositionClosed(info) {
  for (const t of trackers) {
    try {
      t.onPositionClosed(info);
    } catch (e) {
      console.error('DealTracker error', e);
    }
  }
}

module.exports = { init, notifyPositionClosed };

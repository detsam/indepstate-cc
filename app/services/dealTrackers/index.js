// services/dealTrackers/index.js
// Registry for deal trackers interested in position close events

const trackers = [];

function init(cfg = {}) {
  trackers.length = 0;
  const list = Array.isArray(cfg.trackers) ? cfg.trackers : [];
  for (const t of list) {
    const type = String(t.type || '').toLowerCase();
    switch (type) {
      case 'obsidian': {
        const { ObsidianDealTracker } = require('./obsidian');
        trackers.push(new ObsidianDealTracker(t));
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

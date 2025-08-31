const tvLogs = require('./comps');
const loadConfig = require('../../config/load');

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('tv-logs.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled !== false) {
    tvLogs.start(cfg);
  }
}

module.exports = { initService };

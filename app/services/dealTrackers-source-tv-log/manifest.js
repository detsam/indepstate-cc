const tvLogs = require('./comps');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');

settings.register(
  'tv-logs',
  path.join(__dirname, 'config', 'tv-logs.json'),
  path.join(__dirname, 'config', 'tv-logs-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/dealTrackers-source-tv-log/config/tv-logs.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled !== false) {
    tvLogs.start(cfg);
  }
}

module.exports = { initService };

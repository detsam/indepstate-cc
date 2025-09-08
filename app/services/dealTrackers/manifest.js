const dealTrackers = require('./comps');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');

settings.register(
  'deal-trackers',
  path.join(__dirname, 'config', 'deal-trackers.json'),
  path.join(__dirname, 'config', 'deal-trackers-settings-descriptor.json')
);

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/dealTrackers/config/deal-trackers.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;
  dealTrackers.init(cfg);
  servicesApi.dealTrackers = dealTrackers;
}

module.exports = { initService };

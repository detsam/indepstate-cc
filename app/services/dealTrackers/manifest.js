const dealTrackers = require('./comps');
const loadConfig = require('../../config/load');

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('deal-trackers.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;
  dealTrackers.init(cfg);
  servicesApi.dealTrackers = dealTrackers;
}

module.exports = { initService };

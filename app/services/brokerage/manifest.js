const { initExecutionConfig, getAdapter, getProviderConfig } = require('./adapterRegistry');
const loadConfig = require('../../config/load');

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('execution.json');
  } catch {
    cfg = {};
  }
  initExecutionConfig(cfg);
  servicesApi.brokerage = { getAdapter, getProviderConfig };
}

module.exports = { initService };

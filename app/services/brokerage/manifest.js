const { initExecutionConfig, getAdapter, getProviderConfig } = require('./adapterRegistry');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');

settings.register(
  'execution',
  path.join(__dirname, 'config', 'execution.json'),
  path.join(__dirname, 'config', 'execution-settings-descriptor.json')
);

/**
 * @param {import('../servicesApi').ServicesApi} servicesApi
 */
function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/brokerage/config/execution.json');
  } catch {
    cfg = {};
  }
  initExecutionConfig(cfg);
  servicesApi.brokerage = { getAdapter, getProviderConfig };
}

module.exports = { initService };

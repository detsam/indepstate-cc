const { initExecutionConfig } = require('./adapterRegistry');
const loadConfig = require('../../config/load');

/**
 * @param {import('../serviceContext').ServiceContext} context
 */
function initService(context = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('execution.json');
  } catch {
    cfg = {};
  }
  initExecutionConfig(cfg);
}

module.exports = { initService };

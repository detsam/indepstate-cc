const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { CCXTExecutionAdapter } = require('./comps/ccxt');

function initService() {
  brokerageAdapters.ccxt = (cfg = {}) => new CCXTExecutionAdapter(cfg);
}

module.exports = { initService };

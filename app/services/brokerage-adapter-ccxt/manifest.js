const brokerageAdapters = require('../brokerage/brokerageAdapters');

function initService() {
  brokerageAdapters.ccxt = (cfg = {}) => {
    const { CCXTExecutionAdapter } = require('./comps/ccxt');
    return new CCXTExecutionAdapter(cfg);
  };
}

module.exports = { initService };

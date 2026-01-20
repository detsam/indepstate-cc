const brokerageAdapters = require('../brokerage/brokerageAdapters');

function initService() {
  brokerageAdapters.ccxt = (cfg = {}, providerName) => {
    const { CCXTExecutionAdapter } = require('./comps/ccxt');
    const inst = new CCXTExecutionAdapter(cfg);
    if (providerName) inst.provider = providerName;
    return inst;
  };
}

module.exports = { initService };

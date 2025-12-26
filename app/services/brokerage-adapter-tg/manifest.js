const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { TGExecutionAdapter } = require('./comps/tg');

function initService() {
  brokerageAdapters.tg = (cfg = {}) => new TGExecutionAdapter(cfg);
}

module.exports = { initService };

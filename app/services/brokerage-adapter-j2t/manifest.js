const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { J2TExecutionAdapter } = require('./comps/j2t');

function initService() {
  brokerageAdapters.j2t = (cfg = {}) => new J2TExecutionAdapter(cfg);
}

module.exports = { initService };

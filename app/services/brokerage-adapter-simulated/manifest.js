const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { SimulatedAdapter } = require('./comps/simulated');

function initService() {
  brokerageAdapters.simulated = (cfg = {}) => new SimulatedAdapter(cfg);
}

module.exports = { initService };

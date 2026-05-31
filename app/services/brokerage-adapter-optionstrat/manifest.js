const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { OptionStratAdapter } = require('./comps/optionstrat');

function initService() {
  brokerageAdapters.optionstrat = (cfg = {}, providerName) => new OptionStratAdapter(cfg, providerName);
}

module.exports = { initService };

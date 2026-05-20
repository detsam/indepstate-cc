const brokerageAdapters = require('../brokerage/brokerageAdapters');
const { DWXAdapter } = require('./comps/dwx');
const events = require('../events');

function initService() {
  brokerageAdapters.dwx = (cfg = {}, providerName) => {
    const userHandler = cfg.event_handler || {};
    cfg.event_handler = {
      ...userHandler,
      on_bar_data(symbol, tf, time, open, high, low, close, vol) {
        try {
          events.emit('bar', { provider: providerName, symbol, tf, time, open, high, low, close, vol });
        } catch {}
        userHandler.on_bar_data?.(symbol, tf, time, open, high, low, close, vol);
      },
      on_market_depth(symbol, levels) {
        try {
          events.emit('depth', { provider: providerName, symbol, levels });
        } catch {}
        userHandler.on_market_depth?.(symbol, levels);
      }
    };
    return new DWXAdapter(cfg);
  };
}

module.exports = { initService };

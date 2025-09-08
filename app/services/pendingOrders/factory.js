const loadConfig = require('../../config/load');
const {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  defaultLimitPrice,
  defaultStopLoss
} = require('./strategies/consolidation');
const { FalseBreakStrategy } = require('./strategies/falseBreak');

function createStrategyFactory(strategyConfig, extraStrategies = {}, extraHelpers = {}) {
  const cfg = strategyConfig || loadConfig('../services/pendingOrders/config/pending-strategies.json');
  const helpers = {
    B1_RANGE_CONSOLIDATION,
    defaultLimitPrice,
    defaultStopLoss,
    ...extraHelpers
  };
  const classes = { consolidation: ConsolidationStrategy, falseBreak: FalseBreakStrategy, ...extraStrategies };
  return function (name, params = {}) {
    const Strategy = classes[name];
    if (!Strategy) throw new Error(`Unknown strategy: ${name}`);
    const base = cfg?.[name] || {};
    const opts = { ...base, ...params };
    if (name === 'consolidation') {
      ['rangeRule', 'limitPriceFn', 'stopLossFn'].forEach(key => {
        if (typeof opts[key] === 'string') {
          opts[key] = helpers[opts[key]] || opts[key];
        }
      });
    }
    return new Strategy(opts);
  };
}

module.exports = { createStrategyFactory };

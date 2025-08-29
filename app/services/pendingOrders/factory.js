const loadConfig = require('../../config/load');
const { ConsolidationStrategy, B1_RANGE_CONSOLIDATION } = require('./strategies/consolidation');
const { FalseBreakStrategy } = require('./strategies/falseBreak');

function createStrategyFactory(strategyConfig, extraStrategies = {}) {
  const cfg = strategyConfig || loadConfig('pending-strategies.json');
  const helpers = { B1_RANGE_CONSOLIDATION };
  const classes = { consolidation: ConsolidationStrategy, falseBreak: FalseBreakStrategy, ...extraStrategies };
  return function (name, params = {}) {
    const Strategy = classes[name];
    if (!Strategy) throw new Error(`Unknown strategy: ${name}`);
    const base = cfg?.[name] || {};
    const opts = { ...base, ...params };
    if (name === 'consolidation' && typeof opts.rangeRule === 'string') {
      opts.rangeRule = helpers[opts.rangeRule] || opts.rangeRule;
    }
    return new Strategy(opts);
  };
}

module.exports = { createStrategyFactory };

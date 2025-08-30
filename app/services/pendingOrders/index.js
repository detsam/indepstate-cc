const { PendingOrderService } = require('./service');
const {
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  defaultLimitPrice,
  defaultStopLoss
} = require('./strategies/consolidation');
const { FalseBreakStrategy } = require('./strategies/falseBreak');
const { PendingOrderHub, createPendingOrderHub } = require('./hub');
const { createStrategyFactory } = require('./factory');

function createPendingOrderService(opts = {}) {
  const createStrategy = opts.strategyFactory || createStrategyFactory(opts.strategyConfig, opts.strategies);
  return new PendingOrderService({ createStrategy });
}

module.exports = {
  createPendingOrderService,
  PendingOrderService,
  ConsolidationStrategy,
  B1_RANGE_CONSOLIDATION,
  defaultLimitPrice,
  defaultStopLoss,
  FalseBreakStrategy,
  PendingOrderHub,
  createPendingOrderHub,
  createStrategyFactory
};

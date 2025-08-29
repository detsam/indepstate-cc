const { PendingOrderService } = require('./service');
const { ConsolidationStrategy } = require('./strategies/consolidation');
const { FalseBreakStrategy } = require('./strategies/falseBreak');
const { PendingOrderHub, createPendingOrderHub } = require('./hub');

function createPendingOrderService(opts = {}) {
  const strategies = {
    consolidation: ConsolidationStrategy,
    falseBreak: FalseBreakStrategy,
    ...(opts.strategies || {})
  };
  return new PendingOrderService({ strategies });
}

module.exports = {
  createPendingOrderService,
  PendingOrderService,
  ConsolidationStrategy,
  FalseBreakStrategy,
  PendingOrderHub,
  createPendingOrderHub
};

const { PendingOrderService } = require('./service');
const { ConsolidationStrategy } = require('./strategies/consolidation');

function createPendingOrderService(opts = {}) {
  const strategies = { consolidation: ConsolidationStrategy, ...(opts.strategies || {}) };
  return new PendingOrderService({ strategies });
}

module.exports = { createPendingOrderService, PendingOrderService, ConsolidationStrategy };

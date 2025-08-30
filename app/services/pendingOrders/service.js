class PendingOrderService {
  constructor({ createStrategy } = {}) {
    if (typeof createStrategy !== 'function') {
      throw new Error('createStrategy callback required');
    }
    this.createStrategy = createStrategy;
    this.orders = new Map();
    this.nextId = 1;
  }

  addOrder(opts = {}) {
    const {
      price,
      side,
      strategy = 'consolidation',
      tickSize,
      bars,
      rangeRule,
      limitPriceFn,
      stopLossFn,
      onExecute,
      onCancel
    } = opts;
    const params = { price, side };
    if (tickSize != null) params.tickSize = tickSize;
    if (bars != null) params.bars = bars;
    if (rangeRule != null) params.rangeRule = rangeRule;
    if (limitPriceFn != null) params.limitPriceFn = limitPriceFn;
    if (stopLossFn != null) params.stopLossFn = stopLossFn;
    const strategyInst = this.createStrategy(strategy, params);
    const id = this.nextId++;
    this.orders.set(id, { id, side, strategy: strategyInst, onExecute, onCancel });
    return id;
  }

  cancelOrder(id) {
    this.orders.delete(id);
  }

  onBar(bar) {
    for (const [id, order] of Array.from(this.orders.entries())) {
      const res = order.strategy.onBar(bar);
      if (res) {
        this.orders.delete(id);
        if (res.limitPrice != null && res.stopLoss != null) {
          if (typeof order.onExecute === 'function') {
            order.onExecute({ id, side: order.side, ...res });
          }
        } else if (res.cancel && typeof order.onCancel === 'function') {
          order.onCancel({ id, side: order.side });
        }
      }
    }
  }
}

module.exports = { PendingOrderService };

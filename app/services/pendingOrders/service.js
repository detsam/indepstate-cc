class PendingOrderService {
  constructor({ strategies = {} } = {}) {
    this.strategies = strategies;
    this.orders = new Map();
    this.nextId = 1;
  }

  addOrder(opts = {}) {
    const {
      price,
      side,
      strategy = 'consolidation',
      tickSize,
      onExecute,
      onCancel
    } = opts;
    const Strategy = this.strategies[strategy];
    if (!Strategy) throw new Error(`Unknown strategy: ${strategy}`);
    const strategyInst = new Strategy({ price, side, tickSize });
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

class PendingOrderService {
  constructor({ strategies = {} } = {}) {
    this.strategies = strategies;
    this.orders = new Map();
    this.nextId = 1;
  }

  addOrder(opts = {}) {
    const { price, side, strategy = 'consolidation', onExecute } = opts;
    const Strategy = this.strategies[strategy];
    if (!Strategy) throw new Error(`Unknown strategy: ${strategy}`);
    const strategyInst = new Strategy({ price, side });
    const id = this.nextId++;
    this.orders.set(id, { id, side, strategy: strategyInst, onExecute });
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
        if (typeof order.onExecute === 'function') {
          order.onExecute({ id, side: order.side, ...res });
        }
      }
    }
  }
}

module.exports = { PendingOrderService };

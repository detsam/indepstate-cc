class ExecutionAdapter {
  /** @returns {Promise<{status:'ok'|'rejected'|'simulated', provider:'string', providerOrderId?:string, reason?:string, raw?:any}>} */
  async placeOrder(order /* normalized */) {
    throw new Error('Not implemented');
  }
  // На вырост:
  // async cancelOrder(id) {}
  // async getOrderStatus(id) {}

  /** @returns {Promise<any[]>} список открытых ордеров */
  async listOpenOrders() { return []; }

  /** @returns {Promise<any[]>} история закрытых позиций */
  async listClosedPositions() { return []; }

  /**
   * Получить котировку/информацию по инструменту.
   * @param {string} symbol
   * @returns {Promise<{bid?:number, ask?:number, price?:number}|null>}
   */
  async getQuote(_symbol) { return null; }
}
module.exports = { ExecutionAdapter };

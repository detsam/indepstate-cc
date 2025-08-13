class OrderCardsSource {
  /** @returns {Promise<void>} */
  async start() { throw new Error('Not implemented'); }
  /** @returns {Promise<void>} */
  async stop() { throw new Error('Not implemented'); }
  /** @param {number} rows
      @returns {Promise<any[]>} */
  async getOrdersList(_rows) { throw new Error('Not implemented'); }
}

module.exports = { OrderCardsSource };

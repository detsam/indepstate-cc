// services/orderCards/index.js
// Factory for order card sources. Currently supports only 'webhook'.

const { OrderCardsSource } = require('./base');
const sources = {
  webhook: require('./webhook').WebhookOrderCardsSource,
};

function createOrderCardService(opts = {}) {
  const type = opts.type || 'webhook';
  const Source = sources[type];
  if (!Source) throw new Error(`Unknown order card source: ${type}`);
  return new Source(opts);
}

module.exports = { createOrderCardService, OrderCardsSource };

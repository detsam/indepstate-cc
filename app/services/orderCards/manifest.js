const path = require('path');
const settings = require('../settings');

settings.register(
  'order-cards',
  path.join(__dirname, 'config', 'order-cards.json'),
  path.join(__dirname, 'config', 'order-cards-settings-descriptor.json')
);

function initService() {}

module.exports = { initService };

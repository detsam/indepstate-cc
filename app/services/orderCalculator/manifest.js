const path = require('path');
const settings = require('../settings');
const { OrderCalculator } = require('./index');

settings.register(
  'order-calculator',
  path.join(__dirname, 'config', 'order-calculator.json'),
  path.join(__dirname, 'config', 'order-calculator-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  const orderCalculator = require('./index');
  // If it's already a singleton from require('./index'), we just ensure it's in servicesApi
  // The singleton might need servicesApi for its getter
  servicesApi.orderCalculator = orderCalculator;
}

module.exports = { initService };

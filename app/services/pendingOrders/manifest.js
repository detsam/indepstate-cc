const path = require('path');
const settings = require('../settings');

settings.register(
  'pending-strategies',
  path.join(__dirname, 'config', 'pending-strategies.json'),
  path.join(__dirname, 'config', 'pending-strategies-settings-descriptor.json')
);

function initService() {}

module.exports = { initService };

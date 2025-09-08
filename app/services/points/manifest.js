const path = require('path');
const settings = require('../settings');

settings.register(
  'tick-sizes',
  path.join(__dirname, 'config', 'tick-sizes.json'),
  path.join(__dirname, 'config', 'tick-sizes-settings-descriptor.json')
);

function initService() {}

module.exports = { initService };

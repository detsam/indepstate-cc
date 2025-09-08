const path = require('path');
const settings = require('../settings');

settings.register(
  'ui',
  path.join(__dirname, 'config', 'ui.json'),
  path.join(__dirname, 'config', 'ui-settings-descriptor.json')
);

function initService() {}

module.exports = { initService };

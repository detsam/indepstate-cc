const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOptionStratCommands } = require('./command');

settings.register(
  'optionstrat',
  path.join(__dirname, 'config', 'optionstrat.json'),
  path.join(__dirname, 'config', 'optionstrat-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/optionstrat/config/optionstrat.json');
  } catch {
    cfg = {};
  }
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(...createOptionStratCommands(cfg));
}

module.exports = { initService };

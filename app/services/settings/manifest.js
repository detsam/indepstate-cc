const { ipcMain } = require('electron');
const path = require('path');
const settings = require('./index');
const { listConfigs, readConfig, writeConfig } = settings;

settings.register(
  'services',
  path.join(__dirname, 'config', 'services.json'),
  path.join(__dirname, 'config', 'services-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  servicesApi.settings = { listConfigs, readConfig, writeConfig };
  ipcMain.handle('settings:list', () => listConfigs());
  ipcMain.handle('settings:get', (_evt, name) => readConfig(name));
  ipcMain.handle('settings:set', (_evt, name, data) => writeConfig(name, data));
}

module.exports = { initService };

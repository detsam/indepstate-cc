const { ipcMain } = require('electron');
const { listConfigs, readConfig, writeConfig } = require('./index');

function initService(servicesApi = {}) {
  servicesApi.settings = { listConfigs, readConfig, writeConfig };
  ipcMain.handle('settings:list', () => listConfigs());
  ipcMain.handle('settings:get', (_evt, name) => readConfig(name));
  ipcMain.handle('settings:set', (_evt, name, data) => writeConfig(name, data));
}

module.exports = { initService };

const { app } = require('electron');
const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { start } = require('./index');

settings.register(
  'auto-updater',
  path.join(__dirname, 'config', 'auto-updater.json'),
  path.join(__dirname, 'config', 'auto-updater-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/autoUpdater/config/auto-updater.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  app.whenReady().then(() => {
    const svc = start(cfg);
    servicesApi.autoUpdater = svc;
  }).catch((err) => {
    console.error('[auto-updater] init failed', err);
  });
}

module.exports = { initService };

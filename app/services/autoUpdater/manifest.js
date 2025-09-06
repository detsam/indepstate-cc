const { app } = require('electron');
const loadConfig = require('../../config/load');
const { start } = require('./index');

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('auto-updater.json');
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

const path = require('path');

const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createExecutionLogService } = require('./index');

settings.register(
  'execution-log',
  path.join(__dirname, 'config', 'execution-log.json'),
  path.join(__dirname, 'config', 'execution-log-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/execution-log/config/execution-log.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const svc = createExecutionLogService(cfg);
  try {
    svc.start();
  } catch (err) {
    console.error('[execution-log] failed to start:', err.message);
    return;
  }

  servicesApi.executionLog = svc;

  let electronApp;
  try { ({ app: electronApp } = require('electron')); } catch {}
  if (electronApp) {
    electronApp.on('quit', () => {
      try { svc.stop(); } catch {}
    });
  }
}

module.exports = { initService };

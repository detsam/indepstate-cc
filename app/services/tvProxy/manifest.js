const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { start } = require('./index');

settings.register(
  'tv-proxy',
  path.join(__dirname, 'config', 'tv-proxy.json'),
  path.join(__dirname, 'config', 'tv-proxy-settings-descriptor.json')
);

function intVal(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/tvProxy/config/tv-proxy.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const proxyPort = intVal(cfg.proxyPort, 8888);
  const opts = { proxyPort };
  if (cfg.log) opts.log = true;

  const svc = start(opts);
  servicesApi.tvProxy = svc;
  let app;
  try { ({ app } = require('electron')); } catch {}
  if (app) {
    app.on('quit', () => {
      try { svc.stop(); } catch {}
    });
  }
}

module.exports = { initService };

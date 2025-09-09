const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { start } = require('./index');

settings.register(
  'tv-proxy',
  path.join(__dirname, 'config', 'tv-proxy.json'),
  path.join(__dirname, 'config', 'tv-proxy-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/tvProxy/config/tv-proxy.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const opts = {};
  if (cfg.log) opts.log = true;
  if (typeof cfg.proxyPort === 'number') opts.proxyPort = cfg.proxyPort;

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

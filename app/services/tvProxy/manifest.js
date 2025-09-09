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
  const webhookEnabled = cfg.webhookEnabled === true;
  const opts = { proxyPort, webhookEnabled };
  if (cfg.log) opts.log = true;
  if (webhookEnabled) {
    const webhookPort = intVal(cfg.webhookPort);
    const webhookUrl = typeof cfg.webhookUrl === 'string' ? cfg.webhookUrl : null;
    if (!webhookUrl && !webhookPort) {
      console.error('[tv-proxy] missing webhookPort or webhookUrl');
      return;
    }
    if (webhookUrl) opts.webhookUrl = webhookUrl; else opts.webhookPort = webhookPort;
  }

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

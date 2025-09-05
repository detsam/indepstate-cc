const loadConfig = require('../../config/load');
const { start } = require('./index');

function intVal(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('tv-proxy.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const proxyPort = intVal(cfg.proxyPort, 8888);
  const webhookPort = intVal(cfg.webhookPort);
  const webhookUrl = typeof cfg.webhookUrl === 'string' ? cfg.webhookUrl : null;

  if (!webhookUrl && !webhookPort) {
    console.error('[tv-proxy] missing webhookPort or webhookUrl');
    return;
  }

  const opts = { proxyPort };
  if (webhookUrl) opts.webhookUrl = webhookUrl; else opts.webhookPort = webhookPort;

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

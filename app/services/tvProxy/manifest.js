const { start } = require('./index');

function envInt(name, fallback = 0) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function initService(servicesApi = {}) {
  const proxyPort = envInt('TV_PROXY_PORT', 8888);
  const webhookPort = envInt('TV_WEBHOOK_PORT');
  if (!webhookPort) {
    console.error('[tv-proxy] missing TV_WEBHOOK_PORT');
    return;
  }
  const svc = start({ proxyPort, webhookPort });
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

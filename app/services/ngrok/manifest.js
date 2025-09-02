const loadConfig = require('../../config/load');
const { start } = require('./index');

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('ngrok.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const port = cfg.port || parseInt(process.env.TV_WEBHOOK_PORT || '0', 10);
  if (!port) {
    console.error('[ngrok] missing port to forward');
    return;
  }

  const authToken = cfg.authToken;
  const domain = cfg.domain;

  start({ authToken, domain, port })
    .then((listener) => {
      servicesApi.ngrok = {
        url: listener.url(),
        stop: () => listener.close().catch(() => {}),
      };
    })
    .catch((err) => {
      console.error('[ngrok] failed to start', err);
    });
}

module.exports = { initService };

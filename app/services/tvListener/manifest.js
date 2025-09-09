const path = require('path');
const fetch = require('node-fetch');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { AddCommand } = require('../commands/add');

settings.register(
  'tv-listener',
  path.join(__dirname, 'config', 'tv-listener.json'),
  path.join(__dirname, 'config', 'tv-listener-settings-descriptor.json')
);

function intVal(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/tvListener/config/tv-listener.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  let lastActivity = null;

  const tvProxy = servicesApi.tvProxy;
  if (tvProxy && typeof tvProxy.addListener === 'function') {
    tvProxy.addListener((rec) => {
      if (rec && rec.event === 'http_request' && typeof rec.text === 'string' && rec.text.includes('LineToolHorzLine')) {
        try {
          const payload = JSON.parse(rec.text);
          const src = payload?.sources && Object.values(payload.sources)[0];
          if (src?.state?.type === 'LineToolHorzLine') {
            const symbol = src.symbol;
            const price = Number(src.state?.points?.[0]?.price);
            if (symbol && Number.isFinite(price)) {
              lastActivity = { symbol, price };
            }
          }
        } catch {}
      }
    });

    if (cfg.webhook && cfg.webhook.enabled === true) {
      let webhookUrl = typeof cfg.webhook.url === 'string' ? cfg.webhook.url : null;
      if (!webhookUrl) {
        const port = intVal(cfg.webhook.port);
        if (port) webhookUrl = `http://localhost:${port}/webhook`;
      }
      if (webhookUrl) {
        tvProxy.addListener((rec) => {
          if (rec.event === 'message' && typeof rec.text === 'string' && rec.text.includes('@ATR')) {
            fetch(webhookUrl, {
              method: 'POST',
              body: rec.text,
              headers: { 'content-type': 'text/plain' }
            }).catch(() => {});
          }
        });
      } else {
        console.error('[tv-listener] missing webhook.port or webhook.url');
      }
    }
  }

  class LastCommand extends AddCommand {
    constructor() {
      super();
      this.names = ['last', 'l'];
      this.name = this.names[0];
    }
    run(args) {
      if (!lastActivity) return { ok: false, error: 'No last activity' };
      const [tpStr, riskStr] = args;
      const { symbol, price } = lastActivity;
      const ticker = typeof symbol === 'string' && symbol.includes(':') ? symbol.split(':')[1] : symbol;
      return super.run([ticker, price, 6, tpStr, riskStr]);
    }
  }

  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new LastCommand());
}

module.exports = { initService };

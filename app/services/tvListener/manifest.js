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
  const tvApi = servicesApi.tvListener = servicesApi.tvListener || {};

  let lastActivity = null;
  tvApi.getLastActivity = () => lastActivity;

  let cfg = {};
  try {
    cfg = loadConfig('../services/tvListener/config/tv-listener.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;


  const tvProxy = servicesApi.tvProxy;
  if (tvProxy && typeof tvProxy.addListener === 'function') {
    tvProxy.addListener((rec) => {
      if (!rec || rec.event !== 'http_request' || typeof rec.text !== 'string') return;
      try {
        const payload = JSON.parse(rec.text);
        const sources = payload?.sources;
        if (!sources || typeof sources !== 'object') return;

        Object.entries(sources).forEach(([sourceId, src]) => {
          const lineId = sourceId != null && sourceId !== '' ? String(sourceId) : null;
          if (src && src.state?.type === 'LineToolHorzLine') {
            const symbol = src.symbol;
            const price = Number(src.state?.points?.[0]?.price);
            if (symbol && Number.isFinite(price)) {
              const payload = { symbol, price };
              if (lineId) payload.lineId = lineId;
              lastActivity = payload;
              if (servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function') {
                servicesApi.actionBus.emit('tv-tool-horzline', payload);
              }
            }
          } else if (src === null && lineId) {
            if (servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function') {
              servicesApi.actionBus.emit('tv-tool-horzline-remove', { lineId });
            }
          }
        });
      } catch {}
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
      const { symbol, price, lineId } = lastActivity;
      const ticker = typeof symbol === 'string' && symbol.includes(':') ? symbol.split(':')[1] : symbol;
      const hasLine = typeof lineId === 'string' && lineId !== '';
      const prevOnAdd = this.onAdd;
      if (hasLine) {
        const producingLineId = lineId;
        this.onAdd = (row) => {
          row.producingLineId = producingLineId;
          if (typeof prevOnAdd === 'function') prevOnAdd(row);
        };
      }
      try {
        return super.run([ticker, price, 6, tpStr, riskStr]);
      } finally {
        this.onAdd = prevOnAdd;
      }
    }
  }

  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new LastCommand());
}

module.exports = { initService };

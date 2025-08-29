const events = require('../events');
const { PendingOrderService } = require('./service');
const { ConsolidationStrategy } = require('./strategies/consolidation');

class PendingOrderHub {
  constructor({ strategies = {}, subscribe } = {}) {
    this.subscribe = subscribe;
    this.strategies = { consolidation: ConsolidationStrategy, ...strategies };
    this.services = new Map(); // key: provider:symbol -> service
    this.subscriptions = new Map(); // provider -> Set(symbol)
    events.on('bar', ({ provider, symbol, tf, open, high, low, close }) => {
      if (tf !== 'M1') return;
      const svc = this.services.get(`${provider}:${symbol}`);
      if (svc) svc.onBar({ open, high, low, close });
    });
  }

  ensureService(provider, symbol) {
    const key = `${provider}:${symbol}`;
    let svc = this.services.get(key);
    if (!svc) {
      svc = new PendingOrderService({ strategies: this.strategies });
      this.services.set(key, svc);
    }
    const subs = this.subscriptions.get(provider) || new Set();
    if (!subs.has(symbol)) {
      subs.add(symbol);
      this.subscriptions.set(provider, subs);
      try { this.subscribe?.(provider, [...subs]); } catch {}
    }
    return svc;
  }

  addOrder(provider, symbol, opts) {
    const svc = this.ensureService(provider, symbol);
    const localId = svc.addOrder(opts);
    return `${provider}:${symbol}:${localId}`;
  }
}

function createPendingOrderHub(opts) {
  return new PendingOrderHub(opts);
}

module.exports = { PendingOrderHub, createPendingOrderHub };

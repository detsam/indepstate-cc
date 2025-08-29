const fs = require('fs');
const path = require('path');
const events = require('../events');
const { PendingOrderService } = require('./service');
const { ConsolidationStrategy } = require('./strategies/consolidation');
const { getAdapter } = require('../adapterRegistry');
const loadConfig = require('../../config/load');

const execCfg = loadConfig('execution.json');
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');

function nowTs() { return Date.now(); }

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}

function pickProviderName(instrumentType) {
  return execCfg.byInstrumentType?.[instrumentType] || execCfg.default || 'simulated';
}

class PendingOrderHub {
  constructor({ strategies = {}, subscribe, ipcMain, queuePlaceOrder, wireAdapter, mainWindow } = {}) {
    this.subscribe = subscribe;
    this.strategies = { consolidation: ConsolidationStrategy, ...strategies };
    this.services = new Map(); // key: provider:symbol -> service
    this.subscriptions = new Map(); // provider -> Set(symbol)
    this.queuePlaceOrder = queuePlaceOrder;
    this.wireAdapter = wireAdapter;
    this.mainWindow = mainWindow;

    events.on('bar', ({ provider, symbol, tf, open, high, low, close }) => {
      if (tf !== 'M1') return;
      const svc = this.services.get(`${provider}:${symbol}`);
      if (svc) svc.onBar({ open, high, low, close });
    });

    if (ipcMain) {
      if (queuePlaceOrder) {
        ipcMain.handle('queue-place-order', async (_evt, payload) => queuePlaceOrder(payload));
      }
      ipcMain.handle('queue-place-pending', async (_evt, payload) => this.queuePlacePending(payload));
    }
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

  queuePlacePending(payload) {
    const symbol = String(payload.ticker || payload.symbol || '');
    const providerName = pickProviderName(payload.instrumentType);
    const adapter = getAdapter(providerName);
    try { this.wireAdapter?.(adapter, providerName); } catch {}

    const ts = nowTs();
    const reqId = payload?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
    if (!payload.meta) payload.meta = {};
    payload.meta.requestId = reqId;

    const pendingId = this.addOrder(providerName, symbol, {
      price: Number(payload.price),
      side: payload.side,
      onExecute: ({ limitPrice, stopLoss }) => {
        const stopPts = Math.abs(limitPrice - stopLoss);
        const finalPayload = {
          ticker: symbol,
          event: payload.event,
          price: limitPrice,
          kind: payload.side === 'long' ? 'BL' : 'SL',
          instrumentType: payload.instrumentType,
          tickSize: payload.tickSize,
          meta: { ...payload.meta, stopPts }
        };
        this.queuePlaceOrder?.(finalPayload);
      }
    });

    appendJsonl(EXEC_LOG, {
      t: ts,
      kind: 'place-queued',
      reqId,
      provider: providerName,
      pendingId,
      order: { symbol, side: payload.side, strategy: payload.strategy || 'consolidation' }
    });

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('execution:pending', {
        ts,
        reqId,
        provider: providerName,
        pendingId,
        order: { symbol }
      });
    }

    return { status: 'ok', provider: providerName, providerOrderId: `pending:${pendingId}` };
  }
}

function createPendingOrderHub(opts) {
  return new PendingOrderHub(opts);
}

module.exports = { PendingOrderHub, createPendingOrderHub };

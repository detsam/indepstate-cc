const fs = require('fs');
const path = require('path');
const events = require('../events');
const { PendingOrderService } = require('./service');
const { createStrategyFactory } = require('./factory');
const { getAdapter: defaultGetAdapter } = require('../adapterRegistry');
const { toPoints } = require('../points');
const tradeRules = require('../tradeRules');
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
  constructor({ strategies = {}, strategyConfig, subscribe, ipcMain, queuePlaceOrder, wireAdapter, mainWindow, getAdapter = defaultGetAdapter } = {}) {
    this.subscribe = subscribe;
    this.createStrategy = createStrategyFactory(strategyConfig, strategies);
    this.services = new Map(); // key: provider:symbol -> service
    this.subscriptions = new Map(); // provider -> Set(symbol)
    this.pendingIndex = new Map(); // pendingId -> { reqId, provider, symbol, side }
    if (typeof queuePlaceOrder !== 'function') {
      throw new Error('queuePlaceOrder callback required');
    }
    this.queuePlaceOrder = queuePlaceOrder;
    this.wireAdapter = wireAdapter;
    this.mainWindow = mainWindow;
    this.getAdapter = getAdapter;

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
      ipcMain.handle('pending:cancel', async (_evt, pendingId) => this.cancelPending(pendingId));
    }
  }

  ensureService(provider, symbol) {
    const key = `${provider}:${symbol}`;
    let svc = this.services.get(key);
    if (!svc) {
      svc = new PendingOrderService({ createStrategy: this.createStrategy });
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
    const adapter = this.getAdapter(providerName);
    try { this.wireAdapter?.(adapter, providerName); } catch {}

    const ts = nowTs();
    const reqId = payload?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
    if (!payload.meta) payload.meta = {};
    payload.meta.requestId = reqId;

    const pendingId = this.addOrder(providerName, symbol, {
      price: Number(payload.price),
      side: payload.side,
      strategy: payload.strategy,
      tickSize: payload.tickSize,
      bars: payload.bars,
      onExecute: async ({ limitPrice, stopLoss, takeProfit }) => {
        this.pendingIndex.delete(pendingId);

        let stopPts = toPoints(payload.tickSize, symbol, Math.abs(limitPrice - stopLoss), limitPrice);
        let takePts = takeProfit == null ? undefined :
          toPoints(payload.tickSize, symbol, Math.abs(takeProfit - limitPrice), limitPrice);
        if (takePts == null && payload.meta?.takePts != null) {
          const t = Number(payload.meta.takePts);
          takePts = Number.isFinite(t) ? t : undefined;
        }

        const { MinStopPointsRule } = tradeRules;
        const minRule = tradeRules.rules?.find(r => r instanceof MinStopPointsRule);
        const minPts = minRule ? minRule._min({ instrumentType: payload.instrumentType }) : undefined;
        if (Number.isFinite(minPts) && Number.isFinite(stopPts) && stopPts < minPts) {
          stopPts = minPts;
        }

        const finalPayload = {
          symbol,
          side: payload.side === 'long' ? 'buy' : 'sell',
          type: 'limit',
          price: limitPrice,
          instrumentType: payload.instrumentType,
          tickSize: payload.tickSize,
          qty: Number(payload.meta?.qty || payload.qty || 0),
          sl: stopPts,
          tp: takePts,
          meta: { ...payload.meta, stopPts, ...(takePts != null ? { takePts } : {}) }
        };
        try {
          await this.queuePlaceOrder(finalPayload);
        } catch (err) {
          console.error('pending order execution failed', err);
        }
      },
      onCancel: () => {
        this.pendingIndex.delete(pendingId);
        appendJsonl(EXEC_LOG, {
          t: nowTs(),
          kind: 'pending-cancelled',
          reqId,
          provider: providerName,
          pendingId,
          order: { symbol, side: payload.side, strategy: payload.strategy || 'falseBreak' }
        });
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('execution:result', {
            status: 'rejected',
            reason: 'trigger not satisfied',
            reqId,
            order: { symbol, side: payload.side, meta: payload.meta }
          });
        }
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

    this.pendingIndex.set(pendingId, { reqId, provider: providerName, symbol, side: payload.side });

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

  cancelPending(pendingId) {
    const rec = this.pendingIndex.get(pendingId);
    if (!rec) return { status: 'not-found' };
    this.pendingIndex.delete(pendingId);
    const [provider, symbol, local] = pendingId.split(':');
    const svc = this.services.get(`${provider}:${symbol}`);
    if (svc) svc.cancelOrder(Number(local));

    appendJsonl(EXEC_LOG, {
      t: nowTs(),
      kind: 'pending-cancelled',
      reqId: rec.reqId,
      provider: rec.provider,
      pendingId,
      order: { symbol: rec.symbol, side: rec.side }
    });

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('execution:result', {
        status: 'cancelled',
        reason: 'cancelled',
        reqId: rec.reqId,
        order: { symbol: rec.symbol, side: rec.side, meta: { requestId: rec.reqId } }
      });
    }
    return { status: 'ok' };
  }
}

function createPendingOrderHub(opts) {
  return new PendingOrderHub(opts);
}

module.exports = { PendingOrderHub, createPendingOrderHub };

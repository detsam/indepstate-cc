const fs = require('fs');
const path = require('path');
const events = require('../events');
const { PendingOrderService } = require('./service');
const { createStrategyFactory } = require('./factory');
const servicesApi = require('../servicesApi');
const tradeRules = require('../tradeRules');
const { OrderCalculator } = require('../orderCalculator');
const loadConfig = require('../../config/load');

const execCfg = loadConfig('../services/brokerage/config/execution.json');
const userData = require('electron')?.app?.getPath('userData') || path.join(__dirname, '..', '..');
const LOG_DIR = path.join(userData, 'logs');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');

function nowTs() { return Date.now(); }

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}

function pickProviderName(instrumentType) {
  return execCfg.byInstrumentType?.[instrumentType] || execCfg.default || 'simulated';
}

const orderCalc = new OrderCalculator({ tradeRules });

const TF_SECONDS = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400
};

async function waitFor(fn, attempts = 10, delay = 100) {
  for (let i = 0; i < attempts; i++) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return fn();
}

async function fetchAdapterHistory(adapter, symbol, timeframe = 'M1', limit = 15) {
  if (!adapter || !symbol) return [];
  if (typeof adapter.getHistoricBars === 'function') {
    try {
      const res = await adapter.getHistoricBars({ symbol, timeframe, limit });
      return Array.isArray(res) ? res : [];
    } catch (err) {
      console.error('pending: getHistoricBars failed', err);
      return [];
    }
  }
  const client = adapter?.client;
  if (!client || typeof client.get_historic_data !== 'function') return [];
  const seconds = TF_SECONDS[timeframe] || TF_SECONDS.M1;
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds * Math.max(5, limit + 5);
  try {
    await client.get_historic_data({ symbol, time_frame: timeframe, start, end });
  } catch (err) {
    console.error('pending: get_historic_data failed', err);
    return [];
  }
  const key = `${symbol}_${timeframe}`;
  const data = await waitFor(() => client.historic_data?.[key], 10, 100);
  if (!data) return [];
  return Object.entries(data)
    .map(([time, o]) => ({
      time: Number(time),
      open: Number(o?.open),
      high: Number(o?.high),
      low: Number(o?.low),
      close: Number(o?.close)
    }))
    .filter(b => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

class PendingOrderHub {
  constructor({ strategies = {}, strategyConfig, subscribe, ipcMain, queuePlaceOrder, wireAdapter, mainWindow, getAdapter } = {}) {
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
    this.getAdapter = getAdapter || servicesApi.brokerage?.getAdapter;

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

    const historyBars = payload.historyBars;
    const historyTimeframe = payload.historyTimeframe;
    const historyLoader = adapter
      ? async ({ limit, timeframe } = {}) => fetchAdapterHistory(
        adapter,
        symbol,
        timeframe || historyTimeframe || 'M1',
        Math.max(1, Number(limit) || Number(historyBars) || 15)
      )
      : null;
    const getQuote = adapter
      ? async () => {
        try { return await adapter.getQuote?.(symbol); }
        catch (err) {
          console.error('pending: getQuote failed', err);
          return null;
        }
      }
      : async () => null;

    const pendingId = this.addOrder(providerName, symbol, {
      price: Number(payload.price),
      side: payload.side,
      strategy: payload.strategy,
      tickSize: payload.tickSize,
      bars: payload.bars,
      priceSource: payload.priceSource,
      historyBars,
      historyTimeframe,
      historyLoader,
      getQuote,
      symbol,
      onExecute: async ({ limitPrice, stopLoss, takeProfit }) => {
        this.pendingIndex.delete(pendingId);

        const stopPts = orderCalc.stopPts({
          tickSize: payload.tickSize,
          symbol,
          entryPrice: limitPrice,
          stopPrice: stopLoss,
          instrumentType: payload.instrumentType
        });

        const takePts = orderCalc.takePts(stopPts);

        let qty;
        const risk = Number(payload.meta?.riskUsd);
        if (Number.isFinite(risk) && risk > 0) {
          qty = orderCalc.qty({
            riskUsd: risk,
            stopPts,
            tickSize: payload.tickSize,
            lot: payload.lot,
            instrumentType: payload.instrumentType
          });
        } else {
          qty = Number(payload.meta?.qty || payload.qty || 0);
        }

        const finalPayload = {
          symbol,
          side: payload.side === 'long' ? 'buy' : 'sell',
          type: 'limit',
          price: limitPrice,
          instrumentType: payload.instrumentType,
          tickSize: payload.tickSize,
          qty,
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

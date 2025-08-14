// app/main.js
// Electron main: Express(3210) + JSONL logs + IPC "queue-place-order" + execution adapters (из ./services/adapterRegistry)

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..','.env') });

const { getAdapter, initExecutionConfig } = require('./services/adapterRegistry');
const { createOrderCardService } = require('./services/orderCards');
const { detectInstrumentType } = require('./services/instruments');
const events = require('./services/events');
const execCfg = require('./config/execution.json');
const orderCardsCfg = require('./config/order-cards.json');
const dealTrackersCfg = require('./config/deal-trackers.json');
const dealTrackers = require('./services/dealTrackers');
initExecutionConfig(execCfg);
dealTrackers.init(dealTrackersCfg);

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', ''].includes(s)) return false;
  return fallback; // если пришло что-то странное — вернём дефолт
}

function envInt(name, fallback = 0) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}
function envFloat(name, fallback = 0) {
  const n = parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
}

// ----------------- CONSTS -----------------
const PORT = envInt("TV_WEBHOOK_PORT");
const IS_ELECTRON_MENU_ENABLED = envBool("IS_ELECTRON_MENU_ENABLED");
const LOG_DIR = path.join(__dirname, 'logs');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');

// ----------------- FS utils -----------------
function ensureLogs({ truncateExecutionsOnStart = false } = {}) {
   if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
   if (!fs.existsSync(EXEC_LOG)) fs.writeFileSync(EXEC_LOG, '');
   if (truncateExecutionsOnStart) {
     // обнуляем лог заявок при старте
     fs.writeFileSync(EXEC_LOG, '');
   }
}

// --- Pending registry + wiring для адаптеров DWX-подтверждений ---
const wiredAdapters = new WeakSet();
const pendingIndex = new Map(); // pendingId(cID) -> { reqId, adapter, order, ts }
const trackerPending = new Map(); // reqId -> { ticker, tp, sp }
const trackerIndex = new Map(); // ticket -> { ticker, tp, sp }

function wireAdapter(adapter, adapterName) {
  if (!adapter?.on || wiredAdapters.has(adapter)) return;
  wiredAdapters.add(adapter);

  adapter.on('order:confirmed', ({ pendingId, ticket, mtOrder, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: adapterName,
      status: 'ok',
      providerOrderId: String(ticket || ''),
      pendingId,
      order: rec.order
    };
    appendJsonl(EXEC_LOG, { t: payload.ts, kind: 'confirm', ...payload, mtOrder });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:result', payload);
    }
    const info = trackerPending.get(rec.reqId);
    if (info) {
      trackerIndex.set(String(ticket), info);
      trackerPending.delete(rec.reqId);
    }
    console.log('[EXEC][CONFIRMED]', { reqId: rec.reqId, ticket: payload.providerOrderId });
  });

  adapter.on('order:rejected', ({ pendingId, reason, msg, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: adapterName,
      status: 'rejected',
      reason: reason || 'EA error',
      pendingId,
      order: rec.order
    };
    appendJsonl(EXEC_LOG, { t: payload.ts, kind: 'reject', ...payload, msg });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:result', payload);
    }
    trackerPending.delete(rec.reqId);
    console.log('[EXEC][REJECTED]', { reqId: rec.reqId, reason: payload.reason });
  });

  adapter.on('order:timeout', ({ pendingId, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: adapterName,
      status: 'rejected',
      reason: 'timeout',
      pendingId,
      order: rec.order
    };
    appendJsonl(EXEC_LOG, { t: payload.ts, kind: 'timeout', ...payload });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:result', payload);
    }
    trackerPending.delete(rec.reqId);
    console.log('[EXEC][TIMEOUT]', { reqId: rec.reqId });
  });

  adapter.on('position:opened', ({ ticket, order, origOrder }) => {
    events.emit('position:opened', { ticket, order, origOrder, adapter: adapterName });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:opened', { ticket, order, origOrder, provider: adapterName });
    }
  });

  adapter.on('position:closed', ({ ticket, trade }) => {
    events.emit('position:closed', { ticket, trade, adapter: adapterName });
    const profit = trade?.profit;
    const info = trackerIndex.get(String(ticket));
    if (info) {
      const status = profit >= 0 ? 'take' : 'loss';
      dealTrackers.notifyPositionClosed({ ...info, status });
      trackerIndex.delete(String(ticket));
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:closed', { ticket, trade, profit, provider: adapterName });
    }
  });

  adapter.on('order:cancelled', ({ ticket }) => {
    events.emit('order:cancelled', { ticket, adapter: adapterName });
    trackerIndex.delete(String(ticket));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('order:cancelled', { ticket, provider: adapterName });
    }
  });
}

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}
const nowTs = () => Date.now();

// ----------------- Electron window -----------------
let mainWindow;
let orderCardServices = [];
let orderCardService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (IS_ELECTRON_MENU_ENABLED == false) {
    Menu.setApplicationMenu(null);
  }
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  ensureLogs({ truncateExecutionsOnStart: true });

  const sourcesCfg = orderCardsCfg?.sources || [{ type: 'webhook' }];
  orderCardServices = sourcesCfg.map((src) => {
    const opts = {
      ...src,
      nowTs,
      onRow(row) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('orders:new', row);
        }
      }
    };
    if (src.type === 'webhook') {
      opts.port = src.port ?? PORT;
      opts.logFile = path.join(LOG_DIR, src.logFile || 'webhooks.jsonl');
      opts.truncateOnStart = src.truncateOnStart ?? true;
    }
    return createOrderCardService(opts);
  });
  for (const svc of orderCardServices) svc.start();

  orderCardService = {
    async getOrdersList(rows = 100) {
      const lists = await Promise.all(orderCardServices.map((s) => s.getOrdersList(rows)));
      return lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
    }
  };

  createWindow();
  setupIpc(orderCardService);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ----------------- IPC: queue-place-order -----------------

// Поддерживаем 2 формата payload:
// A) legacy: { ticker,event,price,kind,meta:{qty,stopPts,takePts,riskUsd?} }
// B) new:    { symbol,side,qty,price,sl,tp,meta:{riskUsd?} }
function normalizeOrderPayload(payload) {
  // определим формат
  const legacy = payload && payload.ticker && payload.meta;
  if (legacy) {
    const symbol = String(payload.ticker || '');
    const instrumentType = detectInstrumentType(symbol);
    return {
      instrumentType,                // 'CX' | 'EQ'
      symbol,                        // 'BTCUSDT.P' | 'AAPL'
      side: payload.kind,            // 'BL'|'BSL'|'SL'|'SSL'
      qty: instrumentType === 'EQ'
        ? Math.floor(Number(payload.meta.qty || 0))
        : Number(payload.meta.qty || 0),
      price: Number(payload.price || 0),
      sl: Number(payload.meta.stopPts || 0),
      tp: payload.meta.takePts == null ? undefined : Number(payload.meta.takePts),
      meta: payload.meta || {}
    };
  }

  // новый формат
  const symbol = String(payload.symbol || payload.ticker || '');
  const instrumentType = detectInstrumentType(symbol);

  return {
    instrumentType,
    symbol,
    side: payload.side || payload.action, // 'BL'|'BSL'|'SL'|'SSL'
    qty: instrumentType === 'EQ'
      ? Math.floor(Number(payload.qty || 0))
      : Number(payload.qty || 0),
    price: Number(payload.price || 0),
    sl: Number(payload.sl || 0),
    tp: payload.tp === '' || payload.tp == null ? undefined : Number(payload.tp),
    meta: payload.meta || {}
  };
}

function validateOrder(order) {
  if (order.instrumentType === 'CX') {
    const ok = order.qty > 0 && order.price > 0 && order.sl >= 6;
    return ok ? { ok: true } : { ok: false, reason: 'CX: qty>0, price>0, sl>=6 required' };
  } else {
    const sideCodeOk = ['BL','BSL','SL','SSL'].includes(String(order.side || '').toUpperCase());
    const ok = (order.meta?.riskUsd > 0) && order.sl >= 6 && order.price > 0 && order.qty >= 1 && sideCodeOk;
    return ok ? { ok: true } : { ok: false, reason: 'EQ: riskUsd>0, sl>=6, price>0, qty>=1 and side in BL/BSL/SL/SSL' };
  }
}

function pickAdapterName(instrumentType) {
  return execCfg.byInstrumentType?.[instrumentType] || execCfg.default || 'simulated';
}

// --- EQ normalization: BL/BSL/SL/SSL -> buy/sell + limit/stoplimit (для адаптеров типа J2T)
function normalizeEquityOrderForExecution(order) {
  if (order.instrumentType !== 'EQ') return order;

  const action = String(order.side || '').toUpperCase();
  let side, type, limitPrice, stopPrice;

  // Базовая интерпретация
  switch (action) {
    case 'BL':
      side = 'buy';  type = 'limit';     limitPrice = Number(order.price); break;
    case 'SL':
      side = 'sell'; type = 'limit';     limitPrice = Number(order.price); break;
    case 'BSL':
      side = 'buy';  type = 'stoplimit'; stopPrice = Number(order.price);  limitPrice = Number(order.price); break;
    case 'SSL':
      side = 'sell'; type = 'stoplimit'; stopPrice = Number(order.price);  limitPrice = Number(order.price); break;
    default:
      return order; // пусть упадёт на валидации адаптера
  }

  const norm = { ...order, side, type };
  if (type === 'limit' || type === 'stoplimit') norm.limitPrice = limitPrice;
  if (type === 'stop' || type === 'stoplimit')  norm.stopPrice  = stopPrice;
  return norm;
}

function setupIpc(orderSvc) {
  ipcMain.handle('queue-place-order', async (_evt, payload) => {
    const order = normalizeOrderPayload(payload);

    // серверная валидация (зеркалит UI)
    const v = validateOrder(order);
    if (!v.ok) {
      const rej = { status: 'rejected', reason: v.reason };
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: false, order, result: rej });
      return rej;
    }

    // выбор адаптера, requestId и нормализация под исполнение
    const adapterName = pickAdapterName(order.instrumentType);
    let execOrder;
    try {
      const ts = nowTs();
      const reqId = order?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
      if (!order.meta) order.meta = {};
      order.meta.requestId = reqId;

        trackerPending.set(reqId, {
          ticker: order.meta?.ticker || order.symbol,
          tp: order.meta?.takePts,
          sp: order.meta?.stopPts,
        });

      execOrder = normalizeEquityOrderForExecution(order);

      console.log('[EXEC][REQ]', { adapter: adapterName, reqId, symbol: execOrder.symbol, action: order.side, side: execOrder.side, type: execOrder.type, qty: execOrder.qty, price: execOrder.price });

      const adapter = getAdapter(adapterName);      
      // разово подключим слушатели подтверждений (если адаптер их поддерживает)
      wireAdapter(adapter, adapterName);

      const result = await adapter.placeOrder(execOrder);

      // если адаптер вернул "pending:<cid>" — не закрываем карточку,
      // отправляем в UI спец-событие и ждём order:confirmed
      const maybePending = String(result?.providerOrderId || '');
      if (maybePending.startsWith('pending:')) {
        const pendingId = maybePending.slice('pending:'.length);
        pendingIndex.set(pendingId, { reqId, adapter: adapterName, order: execOrder, ts });

        appendJsonl(EXEC_LOG, {
          t: ts,
          kind: 'place-queued',
          reqId,
          adapter: adapterName,
          pendingId,
          order: execOrder
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('execution:pending', {
            ts,
            reqId,
            provider: adapterName,
            pendingId,
            order: execOrder
          });
        }

        events.emit('order:placed', { order: execOrder, result: { status: 'ok', provider: adapterName, providerOrderId: result.providerOrderId } });

        console.log('[EXEC][QUEUED]', { reqId, pendingId });
        // для синхронного ответа IPC можно вернуть «ok» с pendingId,
        // но UI должен ждать финального события 'execution:result'
        return { status: 'ok', provider: adapterName, providerOrderId: result.providerOrderId };
      }

      // иначе — поведение как раньше (simulated/rejected/другие адаптеры)
      const execRecord = {
        t: ts,
        kind: 'place',
        reqId,
        valid: true,
        adapter: (result && result.provider) || adapterName,
        order: execOrder,
        result
      };
      appendJsonl(EXEC_LOG, execRecord);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts,
          reqId,
          provider: execRecord.adapter,
          status: result?.status || 'rejected',
          reason: result?.reason,
          providerOrderId: result?.providerOrderId,
          order: execOrder
        });
      }

      const info = trackerPending.get(reqId);
      if (info && result?.status !== 'rejected' && result?.providerOrderId) {
        trackerIndex.set(String(result.providerOrderId), info);
      }
      trackerPending.delete(reqId);

      events.emit('order:placed', { order: execOrder, result: { status: result?.status || 'rejected', provider: execRecord.adapter, providerOrderId: result?.providerOrderId, reason: result?.reason } });

      console.log('[EXEC][RES]', { reqId, status: result?.status, reason: result?.reason, providerOrderId: result?.providerOrderId });
      return result;
    } catch (err) {
      const rej = { status: 'rejected', reason: err.message || 'adapter error' };
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: true, order, error: String(err) });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts: nowTs(),
          reqId: order?.meta?.requestId,
          provider: adapterName,
          status: 'rejected',
          reason: rej.reason,
          order
        });
      }
      trackerPending.delete(order?.meta?.requestId);
      console.log('[EXEC][ERR]', { adapter: adapterName, reqId: order?.meta?.requestId, error: String(err) });
      events.emit('order:placed', { order: execOrder, result: { status: 'rejected', provider: adapterName, reason: rej.reason } });
      return rej;
    }
  });

  // --- IPC: orders:list (tail JSONL файлов, совместим с старым вызовом) ---
  ipcMain.handle('orders:list', async (_evt, arg) => {
    // Совместимость: могут передать число (rows) или объект {file, rows}
    let file = 'webhooks';
    let rows = 100;
    if (typeof arg === 'number') {
      rows = arg;
    } else if (arg && typeof arg === 'object') {
      file = arg.file || file;
      rows = arg.rows || rows;
    }

    if (file === 'webhooks') {
      return orderSvc.getOrdersList(rows);
    }
    if (file === 'executions') {
      // Читаем весь файл (объёмы небольшие); при росте — заменить на tail по байтам
      let text = '';
      try {
        text = fs.readFileSync(EXEC_LOG, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }

      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(-Math.max(1, rows));
      const result = [];
      for (const l of tail) {
        try {
          const rec = JSON.parse(l);
          result.push(rec);
        } catch {
          // skip bad line
        }
      }
      return result;
    }

    throw new Error(`Unknown file alias: ${file}`);
  });
}

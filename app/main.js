// app/main.js
// Electron main: Express(3210) + JSONL logs + IPC "queue-place-order" + execution adapters via the brokerage service

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..','.env') });

const servicesApi = require('./services/servicesApi');
const { createOrderCardService } = require('./services/orderCards');
const { detectInstrumentType } = require('./services/instruments');
const events = require('./services/events');
const { createPendingOrderHub } = require('./services/pendingOrders');
const tradeRules = require('./services/tradeRules');
const loadConfig = require('./config/load');
const execCfg = loadConfig('execution.json');
const orderCardsCfg = loadConfig('order-cards.json');
const { createCommandService } = require('./services/commandLine');

function loadServices(servicesApi = {}) {
  let dirs = [];
  try {
    dirs = loadConfig('services.json');
  } catch {
    dirs = [];
  }
  if (!Array.isArray(dirs)) return;
  for (const dir of dirs) {
    try {
      const manifest = require(path.join(__dirname, dir, 'manifest.js'));
      if (typeof manifest?.initService === 'function') {
        manifest.initService(servicesApi);
      }
    } catch (err) {
      console.error('[serviceLoader] Failed to load', dir, err);
    }
  }
}

loadServices(servicesApi);
const { getAdapter, getProviderConfig } = servicesApi.brokerage || {};

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
const trackerIndex = new Map(); // ticket -> { ticker, tp, sp, cid }

function extractCid(s) {
  const m = String(s).match(/cid[:=]\s*([a-f0-9]{8,})/i);
  return m ? m[1] : undefined;
}

function wireAdapter(adapter, providerName) {
  if (!adapter?.on || wiredAdapters.has(adapter)) return;
  wiredAdapters.add(adapter);

  adapter.on('order:confirmed', ({ pendingId, ticket, mtOrder, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: providerName,
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
      const cid = extractCid(mtOrder?.comment || '');
      if (cid) info.cid = cid;
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
      provider: providerName,
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

  adapter.on('order:retry', ({ pendingId, count }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:retry', { reqId: rec.reqId, pendingId, count });
    }
  });

  adapter.on('position:opened', ({ ticket, order, origOrder }) => {
    events.emit('position:opened', { ticket, order, origOrder, provider: providerName });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:opened', { ticket, order, origOrder, provider: providerName });
    }
  });

  adapter.on('position:closed', ({ ticket, trade }) => {
    events.emit('position:closed', { ticket, trade, provider: providerName });
    const info = trackerIndex.get(String(ticket));
    const profit = trade?.profit;
    if (info) {
      trackerIndex.delete(String(ticket));
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:closed', { ticket, trade, profit, provider: providerName });
    }
  });

  adapter.on('order:cancelled', ({ ticket }) => {
    events.emit('order:cancelled', { ticket, provider: providerName });
    trackerIndex.delete(String(ticket));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('order:cancelled', { ticket, provider: providerName });
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
        const ticker = row.ticker || row.symbol;
        const instrumentType = detectInstrumentType(String(ticker || ''));
        row.provider = pickProviderName(instrumentType);
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
      const combined = lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
      return combined.map((row) => {
        const ticker = row.ticker || row.symbol;
        const instrumentType = detectInstrumentType(String(ticker || ''));
        return { ...row, provider: row.provider || pickProviderName(instrumentType) };
      });
    }
  };

  const cmdService = createCommandService({
    onAdd(row) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orders:new', row);
      }
    }
  });
  ipcMain.handle('cmdline:run', (_evt, str) => cmdService.run(str));

  createWindow();
  setupIpc(orderCardService);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
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

    const instrumentType =  payload.instrumentType;
    return {
        instrumentType ,                // 'CX' | 'EQ' | 'FX'
      symbol,                        // 'BTCUSDT.P' | 'AAPL'
      side: payload.kind,            // 'BL'|'BSL'|'SL'|'SSL'
      type: payload.type,
      tickSize: payload.tickSize,
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
  const instrumentType =  payload.instrumentType;
  return {
    instrumentType,
    symbol,
    side: payload.side || payload.action, // 'BL'|'BSL'|'SL'|'SSL'
    type: payload.type,
    tickSize: payload.tickSize,
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
    const ok = order.qty > 0 && order.price > 0 && order.sl > 0;
    return ok ? { ok: true } : { ok: false, reason: 'CX: qty>0, price>0, sl>0 required' };
  } else if (order.instrumentType === 'FX') {
    const ok = (order.meta?.riskUsd > 0) && order.sl > 0 && order.price > 0 && order.qty > 0;
    return ok ? { ok: true } : { ok: false, reason: 'FX: riskUsd>0, sl>0, price>0, qty>0 required' };
  } else {
    const ok = (order.meta?.riskUsd > 0) && order.sl > 0 && order.price > 0 && (order.qty >= 1);
    return ok ? { ok: true } : { ok: false, reason: 'EQ: riskUsd>0, sl>0, price>0, qty>=1 required' };
  }
}

function pickProviderName(instrumentType) {
  return execCfg.byInstrumentType?.[instrumentType] || execCfg.default || 'simulated';
}

// --- EQ normalization: BL/BSL/SL/SSL -> buy/sell + limit/stoplimit (для адаптеров типа J2T)
function normalizeEquityOrderForExecution(order) {
  if (!['EQ','FX','CX'].includes(String(order.instrumentType))) return order;

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
  async function queuePlaceOrderInternal(payload) {
    const order = normalizeOrderPayload(payload);

    // серверная валидация (зеркалит UI)
    const v = validateOrder(order);
    if (!v.ok) {
      const rej = { status: 'rejected', reason: v.reason };
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: false, order, result: rej });
      return rej;
    }

    // выбор адаптера, requestId и нормализация под исполнение
    const providerName = pickProviderName(order.instrumentType);
    let execOrder;
    try {
      const ts = nowTs();
      const reqId = order?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
      if (!order.meta) order.meta = {};
      order.meta.requestId = reqId;

        const sideCode = String(order.side || '').toUpperCase();
        const sideDir = sideCode.startsWith('S') || sideCode === 'SELL' ? 'short' : 'long';
        trackerPending.set(reqId, {
          ticker: order.meta?.ticker || order.symbol,
          tp: order.meta?.takePts,
          sp: order.meta?.stopPts,
          side: sideDir,
          price: order.price,
          qty: order.qty
        });

      execOrder = normalizeEquityOrderForExecution(order);

      const adapter = getAdapter(providerName);
      // разово подключим слушатели подтверждений (если адаптер их поддерживает)
      wireAdapter(adapter, providerName);

      const quote = await adapter.getQuote?.(execOrder.symbol);
      if (!quote || !Number.isFinite(quote.price)) {
        const rej = { status: 'rejected', provider: providerName, reason: 'No quote' };
        appendJsonl(EXEC_LOG, { t: ts, kind: 'place', valid: true, reqId, provider: providerName, order: execOrder, result: rej });
        return rej;
      }
      const rule = tradeRules.validate(execOrder, quote);
      if (!rule.ok) {
        const rej = { status: 'rejected', provider: providerName, reason: rule.reason };
        appendJsonl(EXEC_LOG, { t: ts, kind: 'place', valid: true, reqId, provider: providerName, order: execOrder, result: rej });
        return rej;
      }

      console.log('[EXEC][REQ]', { provider: providerName, reqId, symbol: execOrder.symbol, action: order.side, side: execOrder.side, type: execOrder.type, qty: execOrder.qty, price: execOrder.price, sl: execOrder.sl, tp: execOrder.tp });

      const result = await adapter.placeOrder(execOrder);

      // если адаптер вернул "pending:<cid>" — не закрываем карточку,
      // отправляем в UI спец-событие и ждём order:confirmed
      const maybePending = String(result?.providerOrderId || '');
      if (maybePending.startsWith('pending:')) {
        const pendingId = maybePending.slice('pending:'.length);
        pendingIndex.set(pendingId, { reqId, adapter, providerName, order: execOrder, ts });

        appendJsonl(EXEC_LOG, {
          t: ts,
          kind: 'place-queued',
          reqId,
          provider: providerName,
          pendingId,
          order: execOrder
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('execution:pending', {
            ts,
            reqId,
            provider: providerName,
            pendingId,
            order: execOrder
          });
        }

        events.emit('order:placed', { order: execOrder, result: { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId } });

        console.log('[EXEC][QUEUED]', { reqId, pendingId });
        // для синхронного ответа IPC можно вернуть «ok» с pendingId,
        // но UI должен ждать финального события 'execution:result'
        return { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId };
      }

      // иначе — поведение как раньше (simulated/rejected/другие адаптеры)
      const execRecord = {
        t: ts,
        kind: 'place',
        reqId,
        valid: true,
        provider: (result && result.provider) || providerName,
        order: execOrder,
        result
      };
      appendJsonl(EXEC_LOG, execRecord);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts,
          reqId,
          provider: execRecord.provider,
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

      events.emit('order:placed', { order: execOrder, result: { status: result?.status || 'rejected', provider: execRecord.provider, providerOrderId: result?.providerOrderId, reason: result?.reason } });

      console.log('[EXEC][RES]', { reqId, status: result?.status, reason: result?.reason, providerOrderId: result?.providerOrderId });
      return result;
  } catch (err) {
      const rej = { status: 'rejected', reason: err.message || 'adapter error' };
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: true, order, error: String(err) });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts: nowTs(),
          reqId: order?.meta?.requestId,
          provider: providerName,
          status: 'rejected',
          reason: rej.reason,
          order
        });
      }
      trackerPending.delete(order?.meta?.requestId);
      console.log('[EXEC][ERR]', { provider: providerName, reqId: order?.meta?.requestId, error: String(err) });
      events.emit('order:placed', { order: execOrder, result: { status: 'rejected', provider: providerName, reason: rej.reason } });
      return rej;
    }
  }

  const pendingHub = createPendingOrderHub({
    subscribe: (provider, symbols) => {
      const adapter = getAdapter(provider);
      try { adapter.client?.subscribe_symbols_bar_data(symbols.map(s => [s, 'M1'])); } catch {}
    },
    ipcMain,
    queuePlaceOrder: queuePlaceOrderInternal,
    wireAdapter,
    mainWindow
  });

  ipcMain.handle('execution:stop-retry', async (_evt, reqId) => {
    for (const [pendingId, rec] of pendingIndex.entries()) {
      if (rec.reqId === reqId) {
        rec.adapter?.stopOpenOrder?.(pendingId);
        pendingIndex.delete(pendingId);
        trackerPending.delete(reqId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('execution:retry-stopped', { reqId, pendingId });
        }
        break;
      }
    }
  });

  ipcMain.handle('instrument:get', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = provider || pickProviderName(instrumentType);
      const adapter = getAdapter(providerName);
      const q = await adapter.getQuote?.(String(symbol || ''));
      return q || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('instrument:forget', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = provider || pickProviderName(instrumentType);
      const adapter = getAdapter(providerName);
      await adapter.forgetQuote?.(String(symbol || ''));
      return true;
    } catch {
      return false;
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

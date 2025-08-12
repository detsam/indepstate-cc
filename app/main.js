// app/main.js
// Electron main: Express(3210) + JSONL logs + IPC "queue-place-order" + execution adapters (из ./services/adapterRegistry)

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');

require('dotenv').config({ path: path.resolve(__dirname, '..','.env') });

const { getAdapter, initExecutionConfig } = require('./services/adapterRegistry');
const { parseWebhook } = require('./services/webhooks');
const { detectInstrumentType } = require('./services/instruments');
const execCfg = require('./config/execution.json');
initExecutionConfig(execCfg);

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
const WEBHOOK_LOG = path.join(LOG_DIR, 'webhooks.jsonl');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');

// ----------------- FS utils -----------------
function ensureLogs({ truncateExecutionsOnStart = false } = {}) {
   if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
   if (!fs.existsSync(WEBHOOK_LOG)) fs.writeFileSync(WEBHOOK_LOG, '');
   if (!fs.existsSync(EXEC_LOG)) fs.writeFileSync(EXEC_LOG, '');
   if (truncateExecutionsOnStart) {
     // обнуляем лог заявок при старте
    fs.writeFileSync(EXEC_LOG, '');
    fs.writeFileSync(WEBHOOK_LOG, '');
   }
}

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}
const nowTs = () => Date.now();

// ----------------- Electron window -----------------
let mainWindow;

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
  createWindow();
  setupServer();
  setupIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ----------------- Express /webhook -----------------
function setupServer() {
  const srv = express();
  // Принимаем text/plain и JSON (парсим вручную из raw)
  srv.use(express.text({ type: '*/*', limit: '256kb' }));

  srv.post('/webhook', (req, res) => {
    const t = nowTs();
    try {
      const raw = req.body || '';

      const parsed = parseWebhook(String(raw), () => t);
      if (!parsed)
        throw new Error('Invalid payload');

      const row = parsed.row; // уже содержит time
      // унификация (если хотите принудительно проставить time здесь)
      row.time = row.time || t;

      appendJsonl(WEBHOOK_LOG, { t, kind: 'webhook', parser: parsed.name, row });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webhook:new', row);
      }

      res.json({ status: 'ok' });
    } catch (e) {
      appendJsonl(WEBHOOK_LOG, { t, kind: 'webhook-error', error: String(e) });
      res.status(400).json({ status: 'error', error: String(e) });
    }
  });

  srv.listen(PORT, () => {
    console.log(`Express listening on http://localhost:${PORT}`);
  });
}

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

function setupIpc() {
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
    try {
      const ts = nowTs();
      const reqId = order?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
      if (!order.meta) order.meta = {};
      order.meta.requestId = reqId;

      const execOrder = normalizeEquityOrderForExecution(order);

      console.log('[EXEC][REQ]', { adapter: adapterName, reqId, symbol: execOrder.symbol, action: order.side, side: execOrder.side, type: execOrder.type, qty: execOrder.qty, price: execOrder.price });

      const adapter = getAdapter(adapterName);
      const result = await adapter.placeOrder(execOrder);

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

      // прокинуть в UI, чтобы карточка закрылась/подсветилась
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

      console.log('[EXEC][RES]', { reqId, status: result?.status, reason: result?.reason, providerOrderId: result?.providerOrderId });
      return result; // {status:'ok'|'simulated'|'rejected', ...}

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

      console.log('[EXEC][ERR]', { adapter: adapterName, reqId: order?.meta?.requestId, error: String(err) });
      return rej;
    }
  });

  // --- IPC: get-last-rows (tail JSONL файлов, совместим с старым вызовом) ---
  const FILE_MAP = {
    webhooks: WEBHOOK_LOG,
    executions: EXEC_LOG,
  };

  ipcMain.handle('get-last-rows', async (_evt, arg) => {
    // Совместимость: могут передать число (rows) или объект {file, rows}
    let file = 'webhooks';
    let rows = 100;
    if (typeof arg === 'number') {
      rows = arg;
    } else if (arg && typeof arg === 'object') {
      file = arg.file || file;
      rows = arg.rows || rows;
    }

    const p = FILE_MAP[file];
    if (!p) throw new Error(`Unknown file alias: ${file}`);

    // Читаем весь файл (объёмы небольшие); при росте — заменить на tail по байтам
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
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
        if (rec && rec.kind === 'webhook' && rec.row) {
          result.push(rec.row);
        } else if (rec && rec.payload) {
          // старые записи: {payload:{ticker,event,price}, t}
          result.push({
            ticker: rec.payload.ticker,
            event: rec.payload.event,
            price: rec.payload.price,
            time: rec.t || nowTs()
          });
        }
      } catch {
        // skip bad line
      }
    }
    return result;
  });
}

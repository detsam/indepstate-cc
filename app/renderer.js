// renderer.js — crypto & equities cards, stable UI state, safe layout
const {ipcRenderer} = require('electron');
const loadConfig = require('./config/load');
const tradeRules = require('./services/tradeRules');
const {detectInstrumentType} = require("./services/instruments");
const { findTickSizeFromConfig } = require('./services/points');
const { OrderCalculator } = require('./services/orderCalculator');
const orderCardsCfg = loadConfig('../services/orderCards/config/order-cards.json');
const orderCalc = new OrderCalculator();
const envEquityStop = Number(process.env.DEFAULT_EQUITY_STOP_USD);
const EQUITY_DEFAULT_STOP_USD = Number.isFinite(envEquityStop)
  ? envEquityStop
  : Number(orderCardsCfg?.defaultEquityStopUsd) || 0;

const SHOW_BID_ASK = !!(orderCardsCfg && orderCardsCfg.showBidAsk);
const SHOW_SPREAD = !!(orderCardsCfg && orderCardsCfg.showSpread);



const envInstrRefresh = Number(process.env.INSTRUMENT_REFRESH_MS);
const INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh)
  ? envInstrRefresh
  : Number(orderCardsCfg?.instrumentRefreshMs) || 1000;

const CLOSED_CARD_EVENT_STRATEGY = orderCardsCfg?.closedCardEventStrategy || 'ignore';

const DEFAULT_CARD_BUTTONS = [
  { label: 'BL',  action: 'BL',  style: 'bl' },
  { label: 'BC',  action: 'BC',  style: 'bc' },
  { label: 'BFB', action: 'BFB', style: 'bc' },
  { label: 'SL',  action: 'SL',  style: 'sl' },
  { label: 'SC',  action: 'SC',  style: 'sc' },
  { label: 'SFB', action: 'SFB', style: 'sc' }
];
const CARD_BUTTONS = Array.isArray(orderCardsCfg?.buttons) && orderCardsCfg.buttons.length
  ? orderCardsCfg.buttons.map((b) => Array.isArray(b) ? { label: b[0], action: b[1], style: b[2] } : b)
      .filter((b) => b && b.label && b.action)
  : DEFAULT_CARD_BUTTONS;

const closedCardStrategies = {
  ignore: () => {},
  revive: ({ row, idx, oldRow, oldKey }) => {
    userTouchedByTicker.delete(row.ticker);
    setCardState(oldKey, null);
    const newRow = { ...oldRow, ...row };
    const newKey = rowKey(newRow);
    state.rows[idx] = newRow;
    migrateKey(oldKey, newKey, {
      preserveUi: false,
      nextUiPatch: (prevUi) => {
        const patch = {};
        if (row.qty != null) patch.qty = String(row.qty);
        if (row.price != null) patch.price = String(row.price);
        if (row.sl != null) patch.sl = String(row.sl);
        if (row.tp != null) patch.tp = String(row.tp);
        return patch;
      }
    });
    const updated = state.rows.splice(idx, 1)[0];
    state.rows.unshift(updated);
    if (state.rows.length > 500) state.rows.length = 500;
    render();
  }
};

const handleClosedCard = closedCardStrategies[CLOSED_CARD_EVENT_STRATEGY] || closedCardStrategies.ignore;

// ======= App state =======
const state = {rows: [], filter: '', autoscroll: true};
// load UI settings
ipcRenderer.invoke('settings:get', 'ui').then((res) => {
  if (res && typeof res.autoscroll === 'boolean') {
    state.autoscroll = res.autoscroll;
  } else if (res?.config && typeof res.config.autoscroll === 'boolean') {
    state.autoscroll = res.config.autoscroll;
  }
}).catch(() => {});

// Per-card UI state (persist across renders)
// Crypto:    { qty, price, sl, tp, tpTouched }
// Equities:  { qty, price, sl, tp, risk, tpTouched }
const uiState = new Map();

// Per-card execution state (pending/placed/executing/profit/loss)
const cardStates = new Map();
// Order for sorting cards by execution state
const cardStateOrder = {pending: 1, 'pending-exec': 2, placed: 3, executing: 4, profit: 5, loss: 6};

// Short labels for pending execution orders
const pendingExecLabels = new Map(); // key -> label

// --- pending заявки по requestId ---
const pendingByReqId = new Map();
const pendingIdByReqId = new Map();
const ticketToKey = new Map(); // ticket -> rowKey
const retryCounts = new Map(); // reqId -> retry count

// --- пользователь вручную менял поля карточки для этого тикера?
const userTouchedByTicker = new Map(); // ticker -> boolean

// котировки по тикерам
const instrumentInfo = new Map(); // ticker -> {price,bid,ask}
// історія спредів у пунктах: ticker -> number[] (trim до 100)
const spreadHistory = new Map();

// ======= DOM =======
const $wrap = document.getElementById('wrap');
const $grid = document.getElementById('grid');
const $filter = document.getElementById('filter');
const $cmdline = document.getElementById('cmdline');
const $settingsBtn = document.getElementById('settings-btn');
const $settingsPanel = document.getElementById('settings-panel');
const $settingsSections = document.getElementById('settings-sections');
const $settingsFields = document.getElementById('settings-fields');
const $settingsClose = document.getElementById('settings-close');
const settingsForms = new Map();

function loadSettingsSections() {
  settingsForms.clear();
  ipcRenderer.invoke('settings:list').then((sections = []) => {
    $settingsSections.innerHTML = '';
    let prevGroup;
    sections.forEach((s, idx) => {
      if (idx > 0 && (s.group !== prevGroup || idx === 3)) {
        const hr = document.createElement('hr');
        $settingsSections.appendChild(hr);
      }
      prevGroup = s.group;
      const div = document.createElement('div');
      div.textContent = s.name;
      div.dataset.section = s.key;
      div.addEventListener('click', () => showSection(s.key));
      $settingsSections.appendChild(div);
    });
    if (sections[0]) showSection(sections[0].key);
  }).catch(() => {});
}

function showSection(name) {
  [...$settingsSections.querySelectorAll('div[data-section]')].forEach(d => {
    d.classList.toggle('active', d.dataset.section === name);
  });
  const existing = settingsForms.get(name);
  if (existing) {
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(existing);
    return;
  }
  ipcRenderer.invoke('settings:get', name).then((res = {}) => {
    const cfg = res.config || res;
    const desc = (res.descriptor && res.descriptor.options) || {};
    const form = document.createElement('form');
    form.dataset.section = name;
    const build = (parent, cfgObj, descObj, prefix = '') => {
      if (Array.isArray(cfgObj) || Array.isArray(descObj)) {
        const arr = Array.isArray(cfgObj) ? cfgObj : [];
        const itemDesc = Array.isArray(descObj) ? descObj[0] : (descObj && descObj.item) || {};
        const itemsWrap = document.createElement('div');
        const baseParts = prefix ? prefix.split('.') : [];
        const itemIsObjDesc = itemDesc && typeof itemDesc === 'object' && !itemDesc.type && Object.keys(itemDesc).length;
        const renderItem = (val, idx) => {
          const d = itemDesc;
          const isObj = (val && typeof val === 'object' && !Array.isArray(val)) || itemIsObjDesc;
          const path = prefix ? `${prefix}.${idx}` : String(idx);
          if (isObj) {
            const group = document.createElement('div');
            group.className = 'settings-group';
            const head = document.createElement('div');
            head.style.display = 'flex';
            head.style.alignItems = 'center';
            const title = document.createElement('div');
            title.className = 'settings-group-title';
            title.textContent = (d && d.description) || String(idx);
            head.appendChild(title);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(group);
              reindex();
              form.dataset.dirty = '1';
            });
            head.appendChild(rm);
            group.appendChild(head);
            build(group, val || {}, d || {}, path);
            itemsWrap.appendChild(group);
          } else {
            const label = document.createElement('label');
            const span = document.createElement('span');
            span.textContent = (d && d.description) || String(idx);
            label.appendChild(span);
            let input;
            const type = (d && d.type) || typeof val;
            if (type === 'boolean') {
              input = document.createElement('input');
              input.type = 'checkbox';
              input.checked = !!val;
            } else if (type === 'number') {
              input = document.createElement('input');
              input.type = 'number';
              input.value = val ?? '';
            } else {
              input = document.createElement('input');
              input.type = 'text';
              input.value = val ?? '';
            }
            input.dataset.field = path;
            input.addEventListener('input', () => { form.dataset.dirty = '1'; });
            input.addEventListener('change', () => { form.dataset.dirty = '1'; });
            label.appendChild(input);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(label);
              reindex();
              form.dataset.dirty = '1';
            });
            label.appendChild(rm);
            itemsWrap.appendChild(label);
          }
        };
        const reindex = () => {
          Array.from(itemsWrap.children).forEach((child, i) => {
            for (const input of child.querySelectorAll('input')) {
              const parts = input.dataset.field.split('.');
              parts[baseParts.length] = String(i);
              input.dataset.field = parts.join('.');
            }
            const t = child.querySelector('.settings-group-title');
            if (t && !(itemDesc && itemDesc.description)) t.textContent = String(i);
          });
        };
        arr.forEach((val, idx) => renderItem(val, idx));
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+';
        addBtn.className = 'settings-array-add';
        addBtn.addEventListener('click', () => {
          let v;
          if (itemIsObjDesc) v = {};
          else if (itemDesc && itemDesc.type === 'number') v = 0;
          else if (itemDesc && itemDesc.type === 'boolean') v = false;
          else v = '';
          renderItem(v, itemsWrap.children.length);
          form.dataset.dirty = '1';
        });
        parent.appendChild(itemsWrap);
        parent.appendChild(addBtn);
        return;
      }
      const keys = new Set([
        ...Object.keys(cfgObj || {}),
        ...Object.keys(descObj || {})
      ]);
      for (const key of keys) {
        if (key === 'description' || key === 'type') continue;
        const val = cfgObj ? cfgObj[key] : undefined;
        const d = descObj ? descObj[key] : undefined;
        const isObj = (val && typeof val === 'object' && !Array.isArray(val)) ||
          (d && typeof d === 'object' && !d.type);
        if (isObj) {
          const group = document.createElement('div');
          group.className = 'settings-group';
          const title = document.createElement('div');
          title.className = 'settings-group-title';
          title.textContent = (d && d.description) || key;
          group.appendChild(title);
          build(group, val || {}, d || {}, prefix ? `${prefix}.${key}` : key);
          parent.appendChild(group);
        } else {
          const label = document.createElement('label');
          const span = document.createElement('span');
          span.textContent = (d && d.description) || key;
          label.appendChild(span);
          let input;
          const type = (d && d.type) || typeof val;
          if (type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!val;
          } else if (type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.value = val ?? '';
          } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = val ?? '';
          }
          const path = prefix ? `${prefix}.${key}` : key;
          input.dataset.field = path;
          input.addEventListener('input', () => { form.dataset.dirty = '1'; });
          input.addEventListener('change', () => { form.dataset.dirty = '1'; });
          label.appendChild(input);
          parent.appendChild(label);
        }
      }
    };
    build(form, cfg, desc);
    settingsForms.set(name, form);
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(form);
  }).catch(() => {});
}

// ======= Utils =======
function findKeyByTicker(ticker) {
  const idx = state.rows.findIndex(r => r.ticker === ticker);
  return idx >= 0 ? rowKey(state.rows[idx]) : null;
}

function rowKey(row) {
  return `${row.ticker}|${row.event}|${row.time}|${row.price}`;
}

function _normNum(val) {
  if (val == null) return null;
  const s = String(val).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isPos(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

function isSL(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

function isUpEvent(ev) {
  return /(up|long)/i.test(String(ev));
}

function priceToPoints(inp, price, row, commit = false) {
  const raw = String(inp?.value ?? '').trim();
  if (!raw || !raw.includes('.')) return _normNum(raw);
  const pr = _normNum(price);
  if (!isPos(pr)) return _normNum(raw);
  const val = _normNum(raw);
  if (val == null) return val;
  const pts = Math.abs(pr - val) / 0.01; // fixed minimal tick for testing
  if (Number.isFinite(pts)) {
    const rounded = Math.round(pts);
    if (commit) inp.value = String(rounded);
    return rounded;
  }
  return val;
}


function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function inputNumber(ph, cls) {
  const i = document.createElement('input');
  i.type = 'number';
  i.placeholder = ph;
  i.inputMode = 'decimal';
  i.step = 'any';
  i.className = cls ? `num ${cls}` : 'num';
  return i;
}

function btn(text, className, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${className}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function cssEsc(s) {
  try {
    return CSS.escape(s);
  } catch {
    return String(s).replace(/"/g, '\\"');
  }
}

function cardByKey(key) {
  return $grid.querySelector(`.card[data-rowkey="${cssEsc(key)}"]`);
}

function shakeCard(key) {
  const card = cardByKey(key);
  if (!card) return;
  card.classList.add('card--shake');
  setTimeout(() => card.classList.remove('card--shake'), 600);
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    Object.assign(t.style, {
      position: 'fixed', right: '12px', bottom: '12px',
      padding: '10px 12px', background: 'rgba(0,0,0,.8)', color: '#fff',
      fontSize: '12px', borderRadius: '8px', zIndex: 9999, maxWidth: '60ch'
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(() => {
    t.style.opacity = '0';
  }, 2500);
}

// ======= Command line handling =======
function runCommand(str) {
  return ipcRenderer.invoke('cmdline:run', str);
}

function setCardState(key, state) {
  const card = cardByKey(key);
  if (!card) return;
  const status = card.querySelector('.card__status');
  const close = card.querySelector('.card__close');
  const retryBtn = card.querySelector('.retry-btn');
  const spreadEl = card.querySelector('.card__spread');
  const btnsWrap = card.querySelector('.btns');
  if (!status) return;

  const inputs = card.querySelectorAll('input');
  const buttons = card.querySelectorAll('button.btn');

  if (state) {
    cardStates.set(key, state);
    status.style.display = 'inline-block';
    status.className = `card__status card__status--${state}`;
    if (state === 'pending-exec') {
      const lbl = pendingExecLabels.get(key);
      status.textContent = lbl ? `pe (${lbl})` : 'pe';
    } else {
      pendingExecLabels.delete(key);
      status.textContent = '';
    }
    card.classList.toggle('card--pending', state === 'pending' || state === 'pending-exec');
    if (close) close.style.display = 'none';
    if (spreadEl) spreadEl.style.display = 'none';
    inputs.forEach(inp => {
      inp.disabled = true;
    });
    buttons.forEach(btn => {
      btn.disabled = true;
    });
    if (btnsWrap) btnsWrap.style.display = state === 'pending-exec' ? 'none' : '';

    if (state === 'placed') {
      status.style.cursor = 'pointer';
      status.title = 'Вернуть в готово к отправке';
      status.onclick = () => {
        for (const [ticket, k] of ticketToKey.entries()) {
          if (k === key) ticketToKey.delete(ticket);
        }
        setCardState(key, null);
        render();
      };
    } else if (state === 'pending-exec') {
      status.style.cursor = 'pointer';
      status.title = 'Отменить pe';
      status.onclick = () => {
        const reqId = card.dataset.reqId;
        const pendingId = card.dataset.pendingId || (reqId ? pendingIdByReqId.get(reqId) : null);
        if (pendingId) ipcRenderer.invoke('pending:cancel', pendingId).catch(() => {});
        if (reqId) {
          pendingByReqId.delete(reqId);
          pendingIdByReqId.delete(reqId);
          retryCounts.delete(reqId);
          delete card.dataset.reqId;
        }
        delete card.dataset.pendingId;
        setCardState(key, null);
        render();
      };
    } else {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
    }

    if (state === 'pending' || state === 'pending-exec') {
      // restore full card for pending states
      card.classList.remove('card--mini');
      if (card._removedParts) {
        for (const {node, next} of card._removedParts) {
          if (next && next.parentNode === card) {
            card.insertBefore(node, next);
          } else {
            card.appendChild(node);
          }
        }
        card._removedParts = null;
      }
      card.querySelectorAll('input').forEach(inp => inp.disabled = true);
      card.querySelectorAll('button.btn').forEach(btn => btn.disabled = true);
      if (retryBtn) {
        if (state === 'pending') {
          retryBtn.style.display = 'inline-block';
          const rid = card.dataset.reqId;
          if (rid && retryCounts.has(rid)) retryBtn.textContent = String(retryCounts.get(rid));
        } else {
          retryBtn.style.display = 'none';
        }
      }
    } else {
      // shrink card to ticker + status
      card.classList.add('card--mini');
      if (!card._removedParts) {
        card._removedParts = [];
        ['.meta', '.quad-line', '.extraRow', '.btns', '.card__note'].forEach(sel => {
          const n = card.querySelector(sel);
          if (n) {
            card._removedParts.push({node: n, next: n.nextSibling});
            n.remove();
          }
        });
      }
      if (retryBtn) retryBtn.style.display = 'none';
    }
  } else {
    cardStates.delete(key);
    card.classList.remove('card--mini');
    status.style.display = 'none';
    status.textContent = '';
    pendingExecLabels.delete(key);
    status.style.cursor = '';
    status.title = '';
    status.onclick = null;
    card.classList.remove('card--pending');
    if (spreadEl) {
      spreadEl.style.display = '';
      if (SHOW_SPREAD) updateSpreadForTicker(card.dataset.ticker);
    }
    if (close) close.style.display = '';
    inputs.forEach(inp => {
      inp.disabled = false;
    });
    buttons.forEach(btn => {
      btn.disabled = false;
    });
    if (btnsWrap) btnsWrap.style.display = '';

    if (retryBtn) retryBtn.style.display = 'none';

    // restore removed sections
    if (card._removedParts) {
      for (const {node, next} of card._removedParts) {
        if (next && next.parentNode === card) {
          card.insertBefore(node, next);
        } else {
          card.appendChild(node);
        }
      }
      card._removedParts = null;
      // re-enable fields after restoration
      card.querySelectorAll('input').forEach(inp => inp.disabled = false);
      card.querySelectorAll('button.btn').forEach(btn => btn.disabled = false);
    }
  }
}

// --- touched helpers ---
function markTouched(ticker) {
  if (ticker) userTouchedByTicker.set(ticker, true);
}

function isTouched(ticker) {
  return !!userTouchedByTicker.get(ticker);
}

const pendingInstruments = new Set();

function ensureInstrument(ticker, provider) {
  if (!ticker) return;
  if (!state.rows.some(r => r.ticker === ticker && r.provider === provider)) return; // card removed
  if (instrumentInfo.has(ticker)) return; // already have data
  if (pendingInstruments.has(ticker)) return; // request in-flight
  pendingInstruments.add(ticker);
  ipcRenderer.invoke('instrument:get', { symbol: ticker, provider }).then(info => {
    if (info) {
      pendingInstruments.delete(ticker);
      instrumentInfo.set(ticker, info);
      updateSpreadForTicker(ticker);
      render();
    } else {
      setTimeout(() => {
        pendingInstruments.delete(ticker);
        ensureInstrument(ticker, provider);
      }, 1000);
    }
  }).catch(() => {
    setTimeout(() => {
      pendingInstruments.delete(ticker);
      ensureInstrument(ticker, provider);
    }, 1000);
  });
}

function forgetInstrument(ticker, provider) {
  if (!ticker) return;
  if (state.rows.some(r => r.ticker === ticker && r.provider === provider)) return;
  instrumentInfo.delete(ticker);
  pendingInstruments.delete(ticker);
  ipcRenderer.invoke('instrument:forget', { symbol: ticker, provider }).catch(() => {});
}

// Періодичне оновлення інструментної інформації для всіх видимих карток
(function refreshAllInstrumentsPeriodically() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const tickers = Array.from(new Set((state.rows || []).map(r => r.ticker).filter(Boolean)));
      if (!tickers.length) return;

      await Promise.all(tickers.map(async (t) => {
        const row = state.rows.find(r => r.ticker === t);
        if (!row) return; // пропускаємо, якщо картки вже немає
        const provider = row.provider;
        // не дублюємо запит, якщо вже є активний
        if (pendingInstruments.has(t)) return;

        pendingInstruments.add(t);
        try {
          const info = await ipcRenderer.invoke('instrument:get', { symbol: t, provider });
          if (info) {
            const prev = instrumentInfo.get(t);
            instrumentInfo.set(t, info);
            updateSpreadForTicker(t);
            revalidateCardsForTicker(t);
          }
        } catch {
          // ігноруємо помилку; наступна ітерація спробує знову
        } finally {
          pendingInstruments.delete(t);
        }
      }));
    } finally {
      running = false;
    }
  }, INSTRUMENT_REFRESH_MS);
})();

// Миграция ключей (rowKey зависит от полей row)
function migrateKey(oldKey, newKey, {preserveUi = false, nextUiPatch = null} = {}) {
  if (oldKey === newKey) return;

  // uiState
  if (uiState.has(oldKey)) {
    const prev = uiState.get(oldKey);
    const next = preserveUi ? prev : {...(prev || {})};
    if (typeof nextUiPatch === 'function') Object.assign(next, nextUiPatch(prev));
    uiState.set(newKey, next);
    uiState.delete(oldKey);
  }

  // pendingByReqId
  for (const [rid, key] of pendingByReqId.entries()) {
    if (key === oldKey) pendingByReqId.set(rid, newKey);
  }

  // cardStates
  if (cardStates.has(oldKey)) {
    cardStates.set(newKey, cardStates.get(oldKey));
    cardStates.delete(oldKey);
  }

  // pendingExecLabels
  if (pendingExecLabels.has(oldKey)) {
    pendingExecLabels.set(newKey, pendingExecLabels.get(oldKey));
    pendingExecLabels.delete(oldKey);
  }
}

// ======= Rendering =======
function render() {
  const f = (state.filter || '').trim().toLowerCase();
  let list = state.rows;
  if (f) {
    list = list.filter(r => (r.ticker || '').toLowerCase().startsWith(f));
  } else {
    list = list.slice();
  }

  list.sort((a, b) => {
    const stateA = cardStates.get(rowKey(a));
    const stateB = cardStates.get(rowKey(b));
    const orderA = stateA ? (cardStateOrder[stateA] ?? 6) : 0;
    const orderB = stateB ? (cardStateOrder[stateB] ?? 6) : 0;
    if (orderA !== orderB) return orderA - orderB;
    return 0; // stable sort keeps original order within groups
  });

  $grid.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const key = rowKey(row);
    const card = createCard(row, i);
    $grid.appendChild(card);
    // restore reqId if order is pending
    for (const [rid, k] of pendingByReqId.entries()) {
      if (k === key) card.dataset.reqId = rid;
    }
    const st = cardStates.get(key);
    if (st) setCardState(key, st);
  }
  if (state.autoscroll) {
    try {
      $wrap.scrollTo({top: 0, behavior: 'smooth'});
    } catch {
    }
  }
}

function createCard(row, index) {
  const key = rowKey(row);

  // ensure we have a quote for this symbol ASAP
  ensureInstrument(row.ticker, row.provider);

  const card = el('div', 'card');
  card.setAttribute('data-rowkey', key);
  card.setAttribute('data-ticker', row.ticker);

  // head
  const head = el('div', 'row');

  // Левая часть: тикер (+ bid/ask при наявності)
  const left = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  left.appendChild(el('div', null, row.ticker, {style: 'font-weight:600;font-size:13px'}));
  if (SHOW_BID_ASK) {
    const $bidask = el('span', 'card__bidask');
    $bidask.title = 'Bid / Ask';
    $bidask.style.fontSize = '11px';
    $bidask.style.color = '#6b7280';
    $bidask.textContent = formatBidAskText(instrumentInfo.get(row.ticker), row) || '';
    left.appendChild($bidask);
  }
  head.appendChild(left);

  // Правая часть: статус + кнопка удаления
  const right = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  const $status = el('span', 'card__status');
  $status.style.display = 'none';
  right.appendChild($status);

  if (SHOW_SPREAD) {
    const $spread = el('span', 'card__spread');
    $spread.title = 'Spread pts: current / avg10 / avg100';
    $spread.style.fontSize = '11px';
    $spread.style.color = '#6b7280';
    $spread.textContent = formatSpreadTriple(row.ticker, row) || '';
    right.appendChild($spread);
  }

  const $retry = document.createElement('button');
  $retry.type = 'button';
  $retry.className = 'retry-btn';
  $retry.textContent = '0';
  $retry.title = 'Stop retries';
  $retry.style.display = 'none';
  $retry.addEventListener('click', (e) => {
    e.stopPropagation();
    const cardEl = e.currentTarget.closest('.card');
    const reqId = cardEl?.dataset.reqId;
    if (reqId) ipcRenderer.invoke('execution:stop-retry', reqId);
  });
  right.appendChild($retry);

  const $close = document.createElement('button');
  $close.type = 'button';
  $close.textContent = '×';
  $close.className = 'card__close';
  Object.assign($close.style, {
    border: 'none',
    background: 'transparent',
    width: '22px',
    height: '22px',
    lineHeight: '22px',
    textAlign: 'center',
    fontSize: '16px',
    cursor: 'pointer',
    borderRadius: '4px',
    color: isUpEvent(row.event) ? '#2e7d32' : '#c62828',
    marginLeft: '8px'
  });
  $close.title = 'Удалить карточку';
  $close.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRow(row);
  });
  right.appendChild($close);
  head.appendChild(right);

  // meta
  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, `#${index + 1}`));


  const instrumentType = row.instrumentType || detectInstrumentType(row.ticker); // fallback to EQ if not set

  // body
  let body;
  switch (instrumentType) {
    case 'EQ':
      body = createEquitiesBody(row, key);
      break;
    case 'FX':
      body = createFxBody(row, key);
      break;
    case 'CX':
      body = createCryptoBody(row, key);
      break;
    default:
      body = createEquitiesBody(row, key); // fallback
      break;
  }


  // buttons
  const btns = el('div', 'btns');
  const mk = (label, cls, kind) => {
    const b = btn(label, cls, async () => {
      const v = body.validate();
      if (!v.valid) return;
      await place(kind, row, v, instrumentType, label);
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  btns.style.gridTemplateColumns = `repeat(${CARD_BUTTONS.length},1fr)`;
  for (const { label, action, style } of CARD_BUTTONS) {
    btns.appendChild(mk(label, (style || action).toLowerCase(), action));
  }

  // assemble
  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(body.line);
  if (body.extraRow) card.appendChild(body.extraRow); // Risk$ line for equities
  card.appendChild(btns);
  const note = el('div', 'card__note');
  card.appendChild(note);

  // let validator manage buttons state
  body.setButtons(btns);
  if (body.setNote) body.setNote(note);
  body.validate();
  // expose validator for external revalidation on instrument updates
  card._validate = (commit = false) => body.validate(commit);

  return card;
}

// ======= Crypto body (Qty, Price, SL, TP; TP auto = SL*3) =======
function createCryptoBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: EQUITY_DEFAULT_STOP_USD ? String(EQUITY_DEFAULT_STOP_USD) : '', // дефолтный риск из конфига, // як у FX: Risk $, використовується для автоперерахунку qty
    tpTouched: row.tp != null, // если TP пришёл с хуком — не перезатираем авто-логикой
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  const persist = () => {
    uiState.set(key, {qty: $qty.value, price: $price.value, sl: $sl.value, tp: $tp.value, risk: $risk.value, tpTouched});
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };
  const recomputeQtyFromRisk = () => {
    const r = _normNum($risk.value);
    const sl = priceToPoints($sl, _normNum($price.value), row);
    const lot = Number.isFinite(row.lot) && row.lot > 0 ? row.lot : 1;
    const tick = tickSize(row) || 1; //safe tick 1

    if (isPos(r) && isSL(sl)) {
      const q = orderCalc.qty({ riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'CX' });
      $qty.value = String(q);
    }
    persist();
  };

  const body = {
    type: 'crypto',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
      validate(commit = false) {
        const qty = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = priceToPoints($sl, pr, row, commit);
        const tpVal = priceToPoints($tp, pr, row, commit);
        const info = instrumentInfo.get(row.ticker);
        const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);
        const qtyOk = isPos(qty);
        const priceOk = isPos(pr);
        const slOk = isSL(sl);
        const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({price: pr, side: row.side, sl, instrumentType, qty}, info);
        const valid = qtyOk && priceOk && slOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));
        setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
        setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));

        const reason = !qtyOk ? 'Qty > 0'
          : !priceOk ? 'Price > 0'
            : !slOk ? 'SL > 0'
              : !rulesOk ? ruleReason
                : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }

      return {valid, type: 'crypto', qty, pr, sl, tp: tpVal};
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // Автопочатковий розрахунок qty з Risk/SL (якщо задано)
  recomputeQtyFromRisk();
  // Если TP не передан — вычисляем его из SL
  recomputeTP();
  return body;
}

// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createFxBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (EQUITY_DEFAULT_STOP_USD ? String(EQUITY_DEFAULT_STOP_USD) : ''), // дефолтный риск или из строки
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
    const recomputeQtyFromRisk = () => {
      const r = _normNum($risk.value);
      const sl = priceToPoints($sl, _normNum($price.value), row);
      if (isPos(r) && isSL(sl)) {
        const tick = tickSize(row);
        const lot = row.lot || 100000;
        const q = orderCalc.qty({ riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'FX' });
        $qty.value = String(q);
      }
      persist();
    };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'fx',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
      validate(commit = false) {
        const qtyRaw = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = priceToPoints($sl, pr, row, commit);
        const tpVal = priceToPoints($tp, pr, row, commit);
        const risk = _normNum($risk.value);
        const info = instrumentInfo.get(row.ticker);
        const instrumentType = row.instrumentType || 'FX';

        const qtyOk = Number.isFinite(qtyRaw) && qtyRaw > 0;
        const { ok: rulesOk, reason: ruleReason = '' } = tradeRules.validate({ price: pr, side: row.side, sl, instrumentType, qty: qtyRaw }, info);
        const valid = isPos(risk) && isSL(sl) && isPos(pr) && qtyOk && rulesOk;

        line.classList.toggle('card--invalid', !valid);

        const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
        setErr($risk, !isPos(risk));
        setErr($sl, !isSL(sl) || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
        setErr($price, !isPos(pr) || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
        setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

        const reason = !isPos(risk) ? 'Risk $ > 0'
          : !isSL(sl) ? 'SL > 0'
            : !isPos(pr) ? 'Price > 0'
              : !qtyOk ? 'Qty > 0'
                : !rulesOk ? ruleReason
                  : '';
        if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
          b.disabled = !valid;
          if (!valid) b.title = reason; else b.removeAttribute('title');
        });

        return {
          valid, type: 'fx',
          qty: qtyRaw, pr, sl, risk, tp: tpVal //todo normalize to min qty
        };
      }
    };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // if TP wasn't provided, derive it from SL
  recomputeTP();
  return body;
}


// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createEquitiesBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (EQUITY_DEFAULT_STOP_USD ? String(EQUITY_DEFAULT_STOP_USD) : ''), // дефолтный риск или из строки
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeQtyFromRisk = () => {
    const r = _normNum($risk.value);
    const sl = priceToPoints($sl, _normNum($price.value), row);
    if (isPos(r) && isSL(sl)) {
      const tick = tickSize(row);
      const q = orderCalc.qty({ riskUsd: r, stopPts: sl, tickSize: tick, instrumentType: 'EQ' });
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'equities',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
      validate(commit = false) {
        const qtyRaw = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = priceToPoints($sl, pr, row, commit);
        const tpVal = priceToPoints($tp, pr, row, commit);
        const risk = _normNum($risk.value);
        const info = instrumentInfo.get(row.ticker);
        const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);

        const qtyOk = Number.isFinite(qtyRaw) && qtyRaw >= 1 && Math.floor(qtyRaw) === qtyRaw;
        const priceOk = isPos(pr);
        const slOk = isSL(sl);
        const riskOk = isPos(risk);
        const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({price: pr, side: row.side, sl, instrumentType, qty: qtyRaw}, info);

        const valid = riskOk && slOk && priceOk && qtyOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($risk, !riskOk);
        setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
        setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

        const reason = !riskOk ? 'Risk $ > 0'
          : !slOk ? 'SL > 0'
            : !priceOk ? 'Price > 0'
              : !qtyOk ? 'Qty ≥ 1 (int)'
                : !rulesOk ? ruleReason
                  : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }

      return {
        valid, type: 'equities',
        qty: qtyRaw, pr, sl, risk, tp: tpVal,
        qtyInt: Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0
      };
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
   recomputeQtyFromRisk();
   recomputeTP();
   body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // prefill TP from SL when not explicitly passed
  recomputeTP();
  return body;
}


function tickSize(row) {
  const info = instrumentInfo.get(row.ticker);

  // 1) Прямо з рядка (якщо задано)
  const direct = Number(row?.tickSize);
  if (Number.isFinite(direct) && direct > 0) return direct;

  // 2) З instrumentInfo (біржа/адаптер)
  const fromInfo = Number(info?.tickSize);
  if (Number.isFinite(fromInfo) && fromInfo > 0) return fromInfo;

  // 3) З конфігурації через services/points
  const fromCfg = Number(findTickSizeFromConfig(row.ticker));
  if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg;

  // 4) Фолбек за типом інструмента
  const instrType = row.instrumentType || detectInstrumentType(row.ticker);
  return (instrType === 'FX') ? 0.00001 : 0.01;
}

function decimalsFromTick(tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return 5;
  const s = String(t);
  if (s.includes('e') || s.includes('E')) {
    const m = t.toString();
    const p = m.indexOf('.');
    return p >= 0 ? (m.length - p - 1) : 0;
  }
  const dot = s.indexOf('.');
  return dot >= 0 ? (s.length - dot - 1) : 0;
}

function formatPriceValue(info, row) {
  if (!info || typeof info !== 'object') return '';
  const bid = Number(info.bid);
  const ask = Number(info.ask);
  let price = Number(info.price);
  if (!Number.isFinite(price)) {
    if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
  }
  if (!Number.isFinite(price)) return '';
  const tick = tickSize(row);
  const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
  return price.toFixed(decimals);
}

// Повертає спред у пунктах (integer) або NaN
function computeSpreadPts(info, row) {
  if (!info || !Number.isFinite(info.ask) || !Number.isFinite(info.bid)) return NaN;
  const spread = info.ask - info.bid;
  const tick = tickSize(row);
  if (!Number.isFinite(spread) || !Number.isFinite(tick) || tick <= 0) return NaN;
  const pts = spread / tick;
  if (!Number.isFinite(pts)) return NaN;
  return Math.max(0, Math.round(pts));
}

function formatBidAskText(info, row) {
  if (!info || typeof info !== 'object') return '';
  const bid = Number(info.bid);
  const ask = Number(info.ask);
  if (!Number.isFinite(bid) && !Number.isFinite(ask)) return '';
  const tick = tickSize(row);
  const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
  const b = Number.isFinite(bid) ? bid.toFixed(decimals) : '-';
  const a = Number.isFinite(ask) ? ask.toFixed(decimals) : '-';
  return `${b} / ${a}`;
}

function calcAvg(arr, n) {
  const len = Array.isArray(arr) ? arr.length : 0;
  if (!len) return NaN;
  const k = Math.max(1, Math.min(n, len));
  let sum = 0;
  for (let i = len - k; i < len; i++) sum += arr[i];
  return Math.round(sum / k);
}

function formatSpreadTriple(ticker, row, curPtsOverride) {
  const info = instrumentInfo.get(ticker);
  const cur = Number.isFinite(curPtsOverride) ? curPtsOverride : computeSpreadPts(info, row);
  if (!Number.isFinite(cur)) return '';
  const hist = spreadHistory.get(ticker) || [];
  const avg10 = Number.isFinite(calcAvg(hist, 10)) ? calcAvg(hist, 10) : cur;
  const avg100 = Number.isFinite(calcAvg(hist, 100)) ? calcAvg(hist, 100) : (Number.isFinite(avg10) ? avg10 : cur);
  return `${cur}/${avg10}/${avg100}`;
}

function updateSpreadForTicker(ticker) {
  if (!ticker) return;
  const info = instrumentInfo.get(ticker);
  const row = state.rows.find(r => r.ticker === ticker);
  if (!row) return;

  // 1) Оновлюємо історію (лише якщо спред відображається)
  let curPts;
  if (SHOW_SPREAD) {
    curPts = computeSpreadPts(info, row);
    if (Number.isFinite(curPts)) {
      const arr = spreadHistory.get(ticker) || [];
      arr.push(curPts);
      if (arr.length > 100) arr.splice(0, arr.length - 100);
      spreadHistory.set(ticker, arr);
    }
  }

  // 2) Оновлюємо UI для всіх карток із цим тикером
  const cards = $grid.querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
  cards.forEach(card => {
    if (SHOW_BID_ASK) {
      const ba = card.querySelector('.card__bidask');
      if (ba) ba.textContent = formatBidAskText(info, row) || '';
    }
    if (SHOW_SPREAD) {
      const sp = card.querySelector('.card__spread');
      if (sp) sp.textContent = formatSpreadTriple(ticker, row, curPts) || '';
    }
  });
}

function revalidateCardsForTicker(ticker) {
  if (!ticker) return;
  const cards = $grid.querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
  cards.forEach(card => {
    if (typeof card._validate === 'function') {
      try {
        card._validate(false);
      } catch (_) {}
    }
  });
}

// ======= Order placement (shared) =======
async function place(kind, row, v, instrumentType, btnLabel) {
  if (!v.valid) return;

  const key = rowKey(row);
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingByReqId.set(requestId, key);
  retryCounts.set(requestId, 0);
  const isPendingExec = kind === 'BC' || kind === 'SC' || kind === 'BFB' || kind === 'SFB';
  let isLong = null;
  if (kind === 'BC' || kind === 'BFB') isLong = true;
  else if (kind === 'SC' || kind === 'SFB') isLong = false;
  const alias = isPendingExec ? btnLabel : null;
  if (alias) pendingExecLabels.set(key, alias);
  setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = requestId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  let qtyVal, priceVal, slVal, takeVal, tick, extra = {};
  if (v.type === 'crypto') {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);  //do not fallback for crypro to keep fail order if tick size is unknown
  } else if (v.type === 'equities') {
    qtyVal = v.qtyInt;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  } else {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  }

  const baseMeta = {
    requestId, // связь с execution:result
    qty: Number(qtyVal),
    stopPts: Number(slVal),
    takePts: takeVal == null ? null : Number(takeVal),
    ...extra
  };

  let res;
  try {
    if (kind === 'BC' || kind === 'SC' || kind === 'BFB' || kind === 'SFB') {
      const pendPayload = {
        ticker: row.ticker,
        event: row.event,
        price: Number(priceVal),
        side: isLong ? 'long' : 'short',
        strategy: (kind === 'BFB' || kind === 'SFB') ? 'falseBreak' : 'consolidation',
        instrumentType: instrumentType,
        tickSize: tick,
        meta: baseMeta,
      };
      res = await ipcRenderer.invoke('queue-place-pending', pendPayload);
    } else {
      const payload = {
        ticker: row.ticker,
        event: row.event,
        price: Number(priceVal),
        kind,
        instrumentType: instrumentType,
        tickSize: tick,
        meta: baseMeta,
      };
      res = await ipcRenderer.invoke('queue-place-order', payload);
    }
    if (res && typeof res.providerOrderId === 'string' && res.providerOrderId.startsWith('pending:')) {
      const pendId = res.providerOrderId.slice('pending:'.length);
      pendingIdByReqId.set(requestId, pendId);
      if (card) card.dataset.pendingId = pendId;
      toast(`… ${row.ticker}: sent, waiting confirmation`);
    }
    if (!res || res.status === 'rejected') {
      setCardState(key, null);
      toast(`✖ ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
      render();
    } else {
      setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
      render();
    }
  } catch (e) {
    setCardState(key, null);
    toast(`✖ ${row.ticker}: ${e.message || e}`);
    shakeCard(key);
    render();
  }
}

function clearPendingByKey(key) {
  for (const [rid, k] of pendingByReqId.entries()) {
    if (k === key) {
      pendingByReqId.delete(rid);
      pendingIdByReqId.delete(rid);
      retryCounts.delete(rid);
    }
  }
  pendingExecLabels.delete(key);
}

function removeRow(row) {
  const key = rowKey(row);
  const before = state.rows.length;
  state.rows = state.rows.filter(r => r !== row);
  if (state.rows.length === before) {
    state.rows = state.rows.filter(r => !(r.ticker === row.ticker && r.event === row.event && r.time === row.time && r.price === row.price));
  }
  uiState.delete(key);
  cardStates.delete(key);
  clearPendingByKey(key);
  userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
  render();
  forgetInstrument(row.ticker, row.provider);
}

function removeRowByKey(key) {
  const idx = state.rows.findIndex(r => rowKey(r) === key);
  if (idx >= 0) {
    const row = state.rows[idx];
    state.rows.splice(idx, 1);
    uiState.delete(key);
    cardStates.delete(key);
    clearPendingByKey(key);
    userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
    render();
    forgetInstrument(row.ticker, row.provider);
  }
}

// ======= IPC wiring =======
ipcRenderer.invoke('orders:list', 100).then(rows => {
  state.rows = Array.isArray(rows) ? rows : [];
  render();
}).catch(() => {
});

// Заявка поставлена в очередь адаптером (ждём подтверждение из DWX)
ipcRenderer.on('execution:pending', (_evt, rec) => {
  const reqId = rec?.reqId;
  if (!reqId) return;

  let key = pendingByReqId.get(reqId);
  if (!key) key = findKeyByTicker(rec?.order?.symbol || rec?.order?.ticker);
  if (!key) return;

  pendingByReqId.set(reqId, key);
  retryCounts.set(reqId, 0);
  const card = cardByKey(key);
  if (rec.pendingId) {
    pendingIdByReqId.set(reqId, rec.pendingId);
    if (card) card.dataset.pendingId = rec.pendingId;
  } else {
    pendingIdByReqId.delete(reqId);
    if (card) delete card.dataset.pendingId;
  }
  if (card) {
    card.dataset.reqId = reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }
  if (cardStates.get(key) !== 'pending-exec' || rec?.order?.side) {
    setCardState(key, 'pending');
  }
  if (card && rec?.order) {
    const ui = uiState.get(key) || {};
    if (rec.order.qty != null) {
      ui.qty = String(rec.order.qty);
      const $q = card.querySelector('input.qty');
      if ($q) $q.value = ui.qty;
    }
    if (rec.order.price != null) {
      ui.price = String(rec.order.price);
      const $p = card.querySelector('input.pr');
      if ($p) $p.value = ui.price;
    }
    if (rec.order.sl != null) {
      ui.sl = String(rec.order.sl);
      const $s = card.querySelector('input.sl');
      if ($s) $s.value = ui.sl;
    }
    if (rec.order.tp != null) {
      ui.tp = String(rec.order.tp);
      const $t = card.querySelector('input.tp');
      if ($t) $t.value = ui.tp;
    }
    uiState.set(key, ui);
  }
  toast(`… ${rec.order.symbol}: queued`);
});

ipcRenderer.on('execution:retry', (_evt, rec) => {
  const key = pendingByReqId.get(rec.reqId);
  if (!key) return;
  retryCounts.set(rec.reqId, rec.count);
  const card = cardByKey(key);
  if (card) {
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = String(rec.count);
  }
});

ipcRenderer.on('execution:retry-stopped', (_evt, rec) => {
  const key = pendingByReqId.get(rec.reqId);
  if (!key) return;
  pendingByReqId.delete(rec.reqId);
  retryCounts.delete(rec.reqId);
  const card = cardByKey(key);
  if (card) {
    delete card.dataset.reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) {
      rb.textContent = '0';
      rb.style.display = 'none';
    }
  }
  setCardState(key, null);
  render();
});

// Обновлённая логика получения ивента
ipcRenderer.on('orders:new', (_evt, row) => {
  // ищем существующую карточку по ТИКЕРУ
  const idx = state.rows.findIndex(r => r.ticker === row.ticker);

  if (idx === -1) {
    // карточки нет — добавляем новую
    state.rows.unshift(row);
    if (state.rows.length > 500) state.rows.length = 500;
    render();
    return;
  }
  // карточка для тикера уже есть
  const oldRow = state.rows[idx];
  const oldKey = rowKey(oldRow);
  const st = cardStates.get(oldKey);
  if (st === 'profit' || st === 'loss') {
    handleClosedCard({ row, idx, oldRow, oldKey });
    return;
  }

  const touched = isTouched(row.ticker);

  if (touched) {
    // пользователь менял поля: НЕ трогаем данные, только поднимаем карточку вверх
    const existing = state.rows.splice(idx, 1)[0];
    state.rows.unshift(existing);
    render();
    return;
  }

  // пользователь не менял: обновляем данными последнего ивента + переносим наверх
  const newRow = { ...oldRow, ...row };
  const newKey = rowKey(newRow);

  // подменяем строку
  state.rows[idx] = newRow;

  // мигрируем ключи в ui/pending и подтягиваем авто-поля из ивента
  migrateKey(oldKey, newKey, {
    preserveUi: false,
    nextUiPatch: (prevUi) => {
      const patch = {};
      if (row.qty != null) patch.qty = String(row.qty);
      if (row.price != null) patch.price = String(row.price);
      if (row.sl != null) patch.sl = String(row.sl);
      if (row.tp != null) patch.tp = String(row.tp);
      return patch;
    }
  });

  // перемещаем обновлённую карточку на верх
  const updated = state.rows.splice(idx, 1)[0];
  state.rows.unshift(updated);

  if (state.rows.length > 500) state.rows.length = 500;
  render();
});

// Результат исполнения: закрыть или подсветить карточку
ipcRenderer.on('execution:result', (_evt, rec) => {
  const reqId = rec?.order?.meta?.requestId || rec?.reqId;
  if (!reqId) return;
  const key = pendingByReqId.get(reqId);
  if (!key) return;

  pendingByReqId.delete(reqId);
  pendingIdByReqId.delete(reqId);
  retryCounts.delete(reqId);
  const card = cardByKey(key);
  if (card) {
    delete card.dataset.reqId;
    delete card.dataset.pendingId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  const ok = rec.status === 'ok' || rec.status === 'simulated';
  if (ok) {
    const st = cardStates.get(key);
    if (st !== 'executing' && st !== 'profit' && st !== 'loss') {
      setCardState(key, 'placed');
    }
    if (rec.providerOrderId) ticketToKey.set(String(rec.providerOrderId), key);
    toast(`✔ ${rec.order.symbol} ${rec.order.side} ${rec.order.qty} — placed`);
    render();
  } else {
    setCardState(key, null);
    render();
    shakeCard(key);
    if (card) card.title = rec.reason || 'Rejected';
    toast(`✖ ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
  }
});

ipcRenderer.on('position:opened', (_evt, rec) => {
  let key = ticketToKey.get(String(rec.ticket));
  if (!key) {
    const reqId = rec.origOrder?.meta?.requestId;
    if (reqId) {
      key = pendingByReqId.get(reqId);
      if (key) ticketToKey.set(String(rec.ticket), key);
    }
  }
  if (!key) return;
  setCardState(key, 'executing');
  render();
});

ipcRenderer.on('position:closed', (_evt, rec) => {
  const key = ticketToKey.get(String(rec.ticket));
  if (!key) return;
  ticketToKey.delete(String(rec.ticket));
  if (typeof rec.profit === 'number') {
    setCardState(key, rec.profit >= 0 ? 'profit' : 'loss');
    render();
  } else {
    removeRowByKey(key);
  }
});

ipcRenderer.on('order:cancelled', (_evt, rec) => {
  const key = ticketToKey.get(String(rec.ticket));
  if (key) {
    ticketToKey.delete(String(rec.ticket));
    removeRowByKey(key);
  }
});

// ======= UI events =======
$filter.addEventListener('input', () => {
  state.filter = $filter.value || '';
  render();
});
$settingsBtn.addEventListener('click', () => {
  $settingsPanel.style.display = 'flex';
  loadSettingsSections();
});
$settingsClose.addEventListener('click', () => {
  const setNested = (obj, path, value) => {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = parts[i + 1];
      const nextIsIndex = /^\d+$/.test(next);
      if (nextIsIndex) {
        if (!Array.isArray(cur[p])) cur[p] = [];
      } else {
        if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
      }
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      cur[Number(last)] = value;
    } else {
      cur[last] = value;
    }
  };
  for (const [name, form] of settingsForms.entries()) {
    if (form.dataset.dirty) {
      const data = {};
      for (const inp of form.querySelectorAll('input')) {
        const k = inp.dataset.field;
        let val;
        if (inp.type === 'checkbox') val = inp.checked;
        else if (inp.type === 'number') val = Number(inp.value);
        else val = inp.value;
        setNested(data, k, val);
      }
      ipcRenderer.invoke('settings:set', name, data).catch(() => {});
      if (name === 'ui') state.autoscroll = !!data.autoscroll;
    }
  }
  $settingsPanel.style.display = 'none';
  settingsForms.clear();
});
$wrap.addEventListener('wheel', () => {
  state.autoscroll = false;
});
$cmdline.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = $cmdline.value.trim();
    if (cmd) {
      runCommand(cmd)
        .then((res) => {
          if (!res?.ok && res?.error) {
            toast(res.error);
          } else {
            $cmdline.value = '';
          }
        })
        .catch((err) => {
          toast(err.message || String(err));
        });
    }
  }
});

// initial render
render();

// expose internals for tests
if (typeof module !== 'undefined') {
  module.exports.__testing = {
    setCardState,
    rowKey,
    findKeyByTicker,
    cardByKey,
    state,
    pendingByReqId,
    pendingIdByReqId,
    retryCounts,
    cardStates,
    pendingExecLabels
  };
}


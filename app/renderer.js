// renderer.js — crypto & equities cards, stable UI state, safe layout
const {ipcRenderer} = require('electron');
const loadConfig = require('./config/load');
const tradeRules = require('./services/tradeRules');
const {detectInstrumentType} = require("./services/instruments");
const orderCardsCfg = loadConfig('order-cards.json');
const envEquityStop = Number(process.env.DEFAULT_EQUITY_STOP_USD);
const EQUITY_DEFAULT_STOP_USD = Number.isFinite(envEquityStop)
  ? envEquityStop
  : Number(orderCardsCfg?.defaultEquityStopUsd) || 0;

const envInstrRefresh = Number(process.env.INSTRUMENT_REFRESH_MS);
const INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh)
  ? envInstrRefresh
  : Number(orderCardsCfg?.instrumentRefreshMs) || 1000;

// ======= App state =======
const state = {rows: [], filter: '', autoscroll: true};

// Per-card UI state (persist across renders)
// Crypto:    { qty, price, sl, tp, tpTouched }
// Equities:  { qty, price, sl, tp, risk, tpTouched }
const uiState = new Map();

// Per-card execution state (pending/placed/executing/profit/loss)
const cardStates = new Map();
// Order for sorting cards by execution state
const cardStateOrder = {pending: 1, placed: 2, executing: 3, profit: 4, loss: 5};

// --- pending заявки по requestId ---
const pendingByReqId = new Map();
const ticketToKey = new Map(); // ticket -> rowKey
const retryCounts = new Map(); // reqId -> retry count

// --- пользователь вручную менял поля карточки для этого тикера?
const userTouchedByTicker = new Map(); // ticker -> boolean

// котировки по тикерам
const instrumentInfo = new Map(); // ticker -> {price,bid,ask}

// ======= DOM =======
const $wrap = document.getElementById('wrap');
const $grid = document.getElementById('grid');
const $filter = document.getElementById('filter');
const $autoscroll = document.getElementById('autoscroll');

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

function setCardState(key, state) {
  const card = cardByKey(key);
  if (!card) return;
  const status = card.querySelector('.card__status');
  const close = card.querySelector('.card__close');
  const retryBtn = card.querySelector('.retry-btn');
  if (!status) return;

  const inputs = card.querySelectorAll('input');
  const buttons = card.querySelectorAll('button.btn');

  if (state) {
    cardStates.set(key, state);
    status.style.display = 'inline-block';
    status.className = `card__status card__status--${state}`;
    card.classList.toggle('card--pending', state === 'pending');
    if (close) close.style.display = 'none';
    inputs.forEach(inp => {
      inp.disabled = true;
    });
    buttons.forEach(btn => {
      btn.disabled = true;
    });

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
    } else {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
    }

    if (state === 'pending') {
      // restore full card for pending state
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
        retryBtn.style.display = 'inline-block';
        const rid = card.dataset.reqId;
        if (rid && retryCounts.has(rid)) retryBtn.textContent = String(retryCounts.get(rid));
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
    status.style.cursor = '';
    status.title = '';
    status.onclick = null;
    card.classList.remove('card--pending');
    if (close) close.style.display = '';
    inputs.forEach(inp => {
      inp.disabled = false;
    });
    buttons.forEach(btn => {
      btn.disabled = false;
    });

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

function ensureInstrument(ticker) {
  if (!ticker) return;
  if (!state.rows.some(r => r.ticker === ticker)) return; // card removed
  if (instrumentInfo.has(ticker)) return; // already have data
  if (pendingInstruments.has(ticker)) return; // request in-flight
  pendingInstruments.add(ticker);
  ipcRenderer.invoke('instrument:get', ticker).then(info => {
    if (info) {
      pendingInstruments.delete(ticker);
      instrumentInfo.set(ticker, info);
      render();
    } else {
      setTimeout(() => {
        pendingInstruments.delete(ticker);
        ensureInstrument(ticker);
      }, 1000);
    }
  }).catch(() => {
    setTimeout(() => {
      pendingInstruments.delete(ticker);
      ensureInstrument(ticker);
    }, 1000);
  });
}

function forgetInstrument(ticker) {
  if (!ticker) return;
  if (state.rows.some(r => r.ticker === ticker)) return;
  instrumentInfo.delete(ticker);
  pendingInstruments.delete(ticker);
  ipcRenderer.invoke('instrument:forget', ticker).catch(() => {});
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
        // пропускаємо, якщо картки вже немає
        if (!state.rows.some(r => r.ticker === t)) return;
        // не дублюємо запит, якщо вже є активний
        if (pendingInstruments.has(t)) return;

        pendingInstruments.add(t);
        try {
          const info = await ipcRenderer.invoke('instrument:get', t);
          if (info) {
            const prev = instrumentInfo.get(t);
            instrumentInfo.set(t, info);
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
  ensureInstrument(row.ticker);

  const card = el('div', 'card');
  card.setAttribute('data-rowkey', key);

  // head
  const head = el('div', 'row');

  // Левая часть: тикер
  head.appendChild(el('div', null, row.ticker, {style: 'font-weight:600;font-size:13px'}));

  // Правая часть: статус + кнопка удаления
  const right = el('div', null, null, {style: 'display:flex;align-items:center'});
  const $status = el('span', 'card__status');
  $status.style.display = 'none';
  right.appendChild($status);

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
      await place(kind, row, v, instrumentType);
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  btns.appendChild(mk('BL', 'bl', 'BL'));
  btns.appendChild(mk('BSL', 'bsl', 'BSL'));
  btns.appendChild(mk('SL', 'sl', 'SL'));
  btns.appendChild(mk('SSL', 'ssl', 'SSL'));

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

  return card;
}

// ======= Crypto body (Qty, Price, SL, TP; TP auto = SL*3) =======
function createCryptoBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    tpTouched: row.tp != null, // если TP пришёл с хуком — не перезатираем авто-логикой
  };
  let tpTouched = !!saved.tpTouched;

  const line = el('div', 'quad-line');
  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;

  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);

  const persist = () => {
    uiState.set(key, {qty: $qty.value, price: $price.value, sl: $sl.value, tp: $tp.value, tpTouched});
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = _normNum($sl.value);
      $tp.value = (slv && slv > 0) ? String(slv * 3) : '';
      persist();
    }
  };

  const body = {
    type: 'crypto',
    line, $qty, $price, $sl, $tp,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
      validate() {
        const qty = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = _normNum($sl.value);
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

      return {valid, type: 'crypto', qty, pr, sl, tp: _normNum($tp.value)};
    }
  };

  // wiring
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeTP();
    body.validate();
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
  $tp.addEventListener('input', () => {
    markTouched(row.ticker);
    tpTouched = true;
    persist();
  });

  persist();
  return body;
}

// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createFxBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: EQUITY_DEFAULT_STOP_USD ? String(EQUITY_DEFAULT_STOP_USD) : '', // дефолтный риск из конфига
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;

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
      const sl = _normNum($sl.value);
      // Use lot from row if available and positive
      const lot = Number.isFinite(row.lot) && row.lot > 0 ? row.lot : 100000; //standard lot for FX
      const tickSize = Number.isFinite(row.tickSize) && row.tickSize > 0 ? row.tickSize : 0.00001; //default FX tick size

      if (isPos(r) && isSL(sl)) {
        let q = Math.floor((r / tickSize) / sl / lot / 0.01) * 0.01;
        if (!Number.isFinite(q) || q < 0) q = 0;
        $qty.value = String(q);
      }
      persist();
    };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = _normNum($sl.value);
      $tp.value = (slv && slv > 0) ? String(slv * 3) : '';
      persist();
    }
  };

  const body = {
    type: 'fx',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
      validate() {
        const qtyRaw = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = _normNum($sl.value);
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
          qty: qtyRaw, pr, sl, risk, tp: _normNum($tp.value) //todo normalize to min qty
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
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
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
  $tp.addEventListener('input', () => {
    markTouched(row.ticker);
    tpTouched = true;
    persist();
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  return body;
}


// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createEquitiesBody(row, key) {
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: EQUITY_DEFAULT_STOP_USD ? String(EQUITY_DEFAULT_STOP_USD) : '', // дефолтный риск из конфига
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;

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
    const sl = _normNum($sl.value);
    if (isPos(r) && isSL(sl)) {
      let q = Math.floor((r * 100) / sl);
      if (!Number.isFinite(q) || q < 0) q = 0;
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = _normNum($sl.value);
      $tp.value = (slv && slv > 0) ? String(slv * 3) : '';
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
      validate() {
        const qtyRaw = _normNum($qty.value);
        const pr = _normNum($price.value);
        const sl = _normNum($sl.value);
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
        qty: qtyRaw, pr, sl, risk, tp: _normNum($tp.value),
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
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
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
  $tp.addEventListener('input', () => {
    markTouched(row.ticker);
    tpTouched = true;
    persist();
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  return body;
}

// ======= Order placement (shared) =======
async function place(kind, row, v, instrumentType) {
  if (!v.valid) return;

  const key = rowKey(row);
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingByReqId.set(requestId, key);
  retryCounts.set(requestId, 0);
  setCardState(key, 'pending');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = requestId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  let qtyVal, priceVal, slVal, takeVal, extra = {};
  if (v.type === 'crypto') {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
  } else if (v.type === 'equities') {
    qtyVal = v.qtyInt;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    extra.riskUsd = v.risk;
  } else {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    extra.riskUsd = v.risk;
  }

  // legacy payload (main поддерживает оба формата)
  const payload = {
    ticker: row.ticker,
    event: row.event,
    price: Number(priceVal),
    kind,
    instrumentType: instrumentType,
    mintick: (row.tickSize || 0.01), //todo from config
    meta: {
      requestId, // связь с execution:result
      qty: Number(qtyVal),
      stopPts: Number(slVal),
      takePts: takeVal == null ? null : Number(takeVal),
      ...extra
    }
  };

  try {
    const res = await ipcRenderer.invoke('queue-place-order', payload);
    if (res && typeof res.providerOrderId === 'string' && res.providerOrderId.startsWith('pending:')) {
      toast(`… ${row.ticker}: sent, waiting confirmation`);
    }
    if (!res || res.status === 'rejected') {
      setCardState(key, null);
      toast(`✖ ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
      render();
    } else {
      setCardState(key, 'pending');
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
      retryCounts.delete(rid);
    }
  }
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
  forgetInstrument(row.ticker);
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
    forgetInstrument(row.ticker);
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

  // 1) попробуем маппинг, созданный в момент клика
  let key = pendingByReqId.get(reqId);

  // 2) если вдруг страница перезагружалась/карточка обновлялась — найдём по тикеру
  if (!key) key = findKeyByTicker(rec?.order?.symbol || rec?.order?.ticker);

  if (!key) return;

  pendingByReqId.set(reqId, key);
  retryCounts.set(reqId, 0);
  setCardState(key, 'pending');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
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
  const touched = isTouched(row.ticker);

  if (touched) {
    // пользователь менял поля: НЕ трогаем данные, только поднимаем карточку вверх
    const existing = state.rows.splice(idx, 1)[0];
    state.rows.unshift(existing);
    render();
    return;
  }

  // пользователь не менял: обновляем данными последнего ивента + переносим наверх
  const oldRow = state.rows[idx];
  const oldKey = rowKey(oldRow);

  // формируем новую запись на основе старой + новые поля из ивента
  const newRow = {...oldRow, ...row};
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
  retryCounts.delete(reqId);
  const card = cardByKey(key);
  if (card) {
    delete card.dataset.reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  const ok = rec.status === 'ok' || rec.status === 'simulated';
  if (ok) {
    setCardState(key, 'placed');
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
  const key = ticketToKey.get(String(rec.ticket));
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
$autoscroll.addEventListener('change', () => {
  state.autoscroll = $autoscroll.checked;
});
$wrap.addEventListener('wheel', () => {
  state.autoscroll = false;
  $autoscroll.checked = false;
});

// initial render
render();

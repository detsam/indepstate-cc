// renderer.js — crypto & equities cards, stable UI state, safe layout
const { ipcRenderer } = require('electron');

// ======= App state =======
const state = { rows: [], filter: '', autoscroll: true };

// Per-card UI state (persist across renders)
// Crypto:    { qty, price, sl, tp, tpTouched }
// Equities:  { qty, price, sl, tp, risk, tpTouched }
const uiState = new Map();

// --- pending заявки по requestId ---
const pendingByReqId = new Map();

// --- пользователь вручную менял поля карточки для этого тикера?
const userTouchedByTicker = new Map(); // ticker -> boolean

// ======= DOM =======
const $wrap = document.getElementById('wrap');
const $grid = document.getElementById('grid');
const $filter = document.getElementById('filter');
const $autoscroll = document.getElementById('autoscroll');

// ======= Utils =======
function findKeyByTicker(ticker){
  const idx = state.rows.findIndex(r => r.ticker === ticker);
  return idx >= 0 ? rowKey(state.rows[idx]) : null;
}
function rowKey(row){ return `${row.ticker}|${row.event}|${row.time}|${row.price}`; }
function _normNum(val) {
  if (val == null) return null;
  const s = String(val).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function isPos(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
function isSL(n)  { return typeof n === 'number' && isFinite(n) && n >= 6; }
function hhmmss(ts) {
  const d = new Date(ts);
  const pad = (x)=>String(x).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function isUpEvent(ev) { return /(up|long)/i.test(String(ev)); }
// CX: правая часть тикера оканчивается на USDT.P (напр., "HTCUSDT.P")
function isCrypto(t){
  const right = String(t||'').split(':').pop();
  return /USDT\.P$/i.test(right);
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

function cssEsc(s){ try { return CSS.escape(s); } catch { return String(s).replace(/"/g, '\\"'); } }
function cardByKey(key){ return $grid.querySelector(`.card[data-rowkey="${cssEsc(key)}"]`); }
function setCardPending(key, pending=true){
  const card = cardByKey(key);
  if (!card) return;
  card.classList.toggle('card--pending', pending);
  card.querySelectorAll('button.btn').forEach(b=>{
    if (pending) b.disabled = true;
  });
}
function shakeCard(key){
  const card = cardByKey(key);
  if (!card) return;
  card.classList.add('card--shake');
  setTimeout(()=>card.classList.remove('card--shake'), 600);
}
function toast(msg){
  let t = document.getElementById('toast');
  if (!t){
    t = document.createElement('div');
    t.id = 'toast';
    Object.assign(t.style, {
      position:'fixed', right:'12px', bottom:'12px',
      padding:'10px 12px', background:'rgba(0,0,0,.8)', color:'#fff',
      fontSize:'12px', borderRadius:'8px', zIndex:9999, maxWidth:'60ch'
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(()=>{ t.style.opacity = '0'; }, 2500);
}

// --- touched helpers ---
function markTouched(ticker){ if (ticker) userTouchedByTicker.set(ticker, true); }
function isTouched(ticker){ return !!userTouchedByTicker.get(ticker); }

// Миграция ключей (rowKey зависит от полей row)
function migrateKey(oldKey, newKey, { preserveUi = false, nextUiPatch = null } = {}) {
  if (oldKey === newKey) return;

  // uiState
  if (uiState.has(oldKey)) {
    const prev = uiState.get(oldKey);
    const next = preserveUi ? prev : { ...(prev || {}) };
    if (typeof nextUiPatch === 'function') Object.assign(next, nextUiPatch(prev));
    uiState.set(newKey, next);
    uiState.delete(oldKey);
  }

  // pendingByReqId
  for (const [rid, key] of pendingByReqId.entries()) {
    if (key === oldKey) pendingByReqId.set(rid, newKey);
  }
}

// ======= Rendering =======
function render() {
  const f = (state.filter || '').trim().toLowerCase();
  const list = f ? state.rows.filter(r => (r.ticker || '').toLowerCase().startsWith(f)) : state.rows;

  $grid.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    $grid.appendChild(createCard(list[i], i));
  }
  if (state.autoscroll) {
    try { $wrap.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
  }
}

function createCard(row, index) {
  const key = rowKey(row);
  const cx = isCrypto(row.ticker);

  const card = el('div', 'card');
  card.setAttribute('data-rowkey', key);

  // head
  const head = el('div', 'row');

  // Левая часть: тикер
  head.appendChild(el('div', null, row.ticker, { style: 'font-weight:600;font-size:13px' }));

  // Правая часть: кнопка удаления (вместо лейбла event)
  const $close = document.createElement('button');
  $close.type = 'button';
  $close.textContent = '×';
  // компактный внешний вид, не зависящий от .btn
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
    color: isUpEvent(row.event) ? '#2e7d32' : '#c62828', // легкая подсказка направления
    marginLeft: '8px'
  });
  $close.title = 'Удалить карточку';
  $close.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRow(row);
  });
  head.appendChild($close);

  // meta
  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, hhmmss(row.time)));
  meta.appendChild(el('span', null, `#${index + 1}`));

  // body
  const body = cx ? createCryptoBody(row, key) : createEquitiesBody(row, key);

  // buttons
  const btns = el('div', 'btns');
  const mk = (label, cls, kind) => {
    const b = btn(label, cls, async () => {
      const v = body.validate();
      if (!v.valid) return;
      await place(kind, row, v);
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  btns.appendChild(mk('BL',  'bl',  'BL'));
  btns.appendChild(mk('BSL', 'bsl', 'BSL'));
  btns.appendChild(mk('SL',  'sl',  'SL'));
  btns.appendChild(mk('SSL', 'ssl', 'SSL'));

  // assemble
  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(body.line);
  if (body.extraRow) card.appendChild(body.extraRow); // Risk$ line for equities
  card.appendChild(btns);

  // let validator manage buttons state
  body.setButtons(btns);
  body.validate();

  return card;
}

// ======= Crypto body (Qty, Price, SL, TP; TP auto = SL*3) =======
function createCryptoBody(row, key) {
  const saved = uiState.get(key) || {
    qty:   row.qty != null ? String(row.qty)   : '',
    price: row.price != null ? String(row.price) : '',
    sl:    row.sl != null ? String(row.sl)    : '',
    tp:    row.tp != null ? String(row.tp)    : '',
    tpTouched: row.tp != null, // если TP пришёл с хуком — не перезатираем авто-логикой
  };
  let tpTouched = !!saved.tpTouched;

  const line = el('div', 'quad-line');
  const $qty   = inputNumber('Qty',   'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl    = inputNumber('SL',    'sl');
  const $tp    = inputNumber('TP',    'tp');

  // restore
  $qty.value   = saved.qty;
  $price.value = saved.price;
  $sl.value    = saved.sl;
  $tp.value    = saved.tp;

  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);

  const persist = ()=>{
    uiState.set(key, { qty: $qty.value, price: $price.value, sl: $sl.value, tp: $tp.value, tpTouched });
  };
  const recomputeTP = ()=>{
    if (!tpTouched) {
      const slv = _normNum($sl.value);
      $tp.value = (slv && slv > 0) ? String(slv*3) : '';
      persist();
    }
  };

  const body = {
    type: 'crypto',
    line, $qty, $price, $sl, $tp,
    setButtons($btns){ this._btns = $btns; },
    validate(){
      const qty = _normNum($qty.value);
      const pr  = _normNum($price.value);
      const sl  = _normNum($sl.value);
      const valid = isPos(qty) && isPos(pr) && isSL(sl);

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp,bad)=>inp.classList.toggle('input--error', !!bad);
      setErr($qty,  !isPos(qty));
      setErr($price,!isPos(pr));
      setErr($sl,   !isSL(sl));

      const reason = !isPos(qty) ? 'Qty > 0'
                   : !isPos(pr)  ? 'Price > 0'
                   : !isSL(sl)   ? 'SL ≥ 6'
                   : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b=>{
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });

      return { valid, type:'crypto', qty, pr, sl, tp: _normNum($tp.value) };
    }
  };

  // wiring
  $sl.addEventListener('input',  () => { markTouched(row.ticker); recomputeTP(); body.validate(); });
  $qty.addEventListener('input', () => { markTouched(row.ticker); persist(); body.validate(); });
  $price.addEventListener('input',()=> { markTouched(row.ticker); persist(); body.validate(); });
  $tp.addEventListener('input',   () => { markTouched(row.ticker); tpTouched = true; persist(); });

  persist();
  return body;
}

// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createEquitiesBody(row, key) {
  const saved = uiState.get(key) || {
    qty:   row.qty != null ? String(row.qty)   : '',
    price: row.price != null ? String(row.price) : '',
    sl:    row.sl != null ? String(row.sl)    : '',
    tp:    row.tp != null ? String(row.tp)    : '',
    risk:  '', // риск пользователь вводит сам
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty   = inputNumber('Qty',    'qty');
  const $price = inputNumber('Price',  'pr');
  const $sl    = inputNumber('SL',     'sl');
  const $tp    = inputNumber('TP',     'tp');
  const $risk  = inputNumber('Risk $', 'risk');

  // restore
  $qty.value   = saved.qty;
  $price.value = saved.price;
  $sl.value    = saved.sl;
  $tp.value    = saved.tp;
  $risk.value  = saved.risk;

  const persist = ()=>{
    uiState.set(key, { qty:$qty.value, price:$price.value, sl:$sl.value, tp:$tp.value, risk:$risk.value, tpTouched });
  };
  const recomputeQtyFromRisk = ()=>{
    const r  = _normNum($risk.value);
    const sl = _normNum($sl.value);
    if (isPos(r) && isSL(sl)) {
      let q = Math.floor((r * 100) / sl);
      if (!Number.isFinite(q) || q < 0) q = 0;
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = ()=>{
    if (!tpTouched) {
      const slv = _normNum($sl.value);
      $tp.value = (slv && slv > 0) ? String(slv*3) : '';
      persist();
    }
  };

  const body = {
    type:'equities',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns){ this._btns = $btns; },
    validate(){
      const qtyRaw = _normNum($qty.value);
      const pr     = _normNum($price.value);
      const sl     = _normNum($sl.value);
      const risk   = _normNum($risk.value);

      const qtyOk  = Number.isFinite(qtyRaw) && qtyRaw >= 1 && Math.floor(qtyRaw) === qtyRaw;
      const valid  = isPos(risk) && isSL(sl) && isPos(pr) && qtyOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp,bad)=>inp.classList.toggle('input--error', !!bad);
      setErr($risk,  !isPos(risk));
      setErr($sl,    !isSL(sl));
      setErr($price, !isPos(pr));
      setErr($qty,   !qtyOk);

      const reason = !isPos(risk) ? 'Risk $ > 0'
                   : !isSL(sl)    ? 'SL ≥ 6'
                   : !isPos(pr)   ? 'Price > 0'
                   : !qtyOk       ? 'Qty ≥ 1 (int)'
                   : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b=>{
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });

      return { valid, type:'equities',
        qty: qtyRaw, pr, sl, risk, tp: _normNum($tp.value),
        qtyInt: Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0
      };
    }
  };

  // wiring
  $risk.addEventListener('input',  () => { markTouched(row.ticker); recomputeQtyFromRisk(); body.validate(); });
  $sl.addEventListener('input',    () => { markTouched(row.ticker); recomputeQtyFromRisk(); recomputeTP(); body.validate(); });
  $qty.addEventListener('input',   () => { markTouched(row.ticker); persist(); body.validate(); });
  $price.addEventListener('input', () => { markTouched(row.ticker); persist(); body.validate(); });
  $tp.addEventListener('input',    () => { markTouched(row.ticker); tpTouched = true; persist(); });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  persist();
  return body;
}

// ======= Order placement (shared) =======
async function place(kind, row, v) {
  if (!v.valid) return;

  const key = rowKey(row);
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  pendingByReqId.set(requestId, key);
  setCardPending(key, true);

  let qtyVal, priceVal, slVal, takeVal, extra = {};
  if (v.type === 'crypto') {
    qtyVal   = v.qty;
    priceVal = v.pr;
    slVal    = v.sl;
    takeVal  = v.tp ?? null;
  } else {
    qtyVal   = v.qtyInt;
    priceVal = v.pr;
    slVal    = v.sl;
    takeVal  = v.tp ?? null;
    extra.riskUsd = v.risk;
  }

  // legacy payload (main поддерживает оба формата)
  const payload = {
    ticker: row.ticker,
    event:  row.event,
    price:  Number(priceVal),
    kind,
    meta: {
      requestId, // связь с execution:result
      qty: Number(qtyVal),
      stopPts: Number(slVal),
      takePts: takeVal==null ? null : Number(takeVal),
      ...extra
    }
  };

  try{
    const res = await ipcRenderer.invoke('queue-place-order', payload);
    if (res && typeof res.providerOrderId === 'string' && res.providerOrderId.startsWith('pending:')) {
      toast(`… ${row.ticker}: sent, waiting confirmation`);
    }
    if (!res || res.status === 'rejected') {
      setCardPending(key, false);
      toast(`✖ ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
    }
  }catch(e){
    setCardPending(key, false);
    toast(`✖ ${row.ticker}: ${e.message || e}`);
    shakeCard(key);
  }
}

function clearPendingByKey(key){
  for (const [rid, k] of pendingByReqId.entries()){
    if (k === key) pendingByReqId.delete(rid);
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
  clearPendingByKey(key);
  userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
  render();
}

function removeRowByKey(key){
  const idx = state.rows.findIndex(r => rowKey(r) === key);
  if (idx >= 0) {
    const row = state.rows[idx];
    state.rows.splice(idx, 1);
    uiState.delete(key);
    clearPendingByKey(key);
    userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
    render();
  }
}

// ======= IPC wiring =======
ipcRenderer.invoke('orders:list', 100).then(rows => {
  state.rows = Array.isArray(rows) ? rows : [];
  render();
}).catch(()=>{});

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
  setCardPending(key, true);
  toast(`… ${rec.order.symbol}: queued`);
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
  const newRow = { ...oldRow, ...row };
  const newKey = rowKey(newRow);

  // подменяем строку
  state.rows[idx] = newRow;

  // мигрируем ключи в ui/pending и подтягиваем авто-поля из ивента
  migrateKey(oldKey, newKey, {
    preserveUi: false,
    nextUiPatch: (prevUi) => {
      const patch = {};
      if (row.qty != null)   patch.qty   = String(row.qty);
      if (row.price != null) patch.price = String(row.price);
      if (row.sl != null)    patch.sl    = String(row.sl);
      if (row.tp != null)    patch.tp    = String(row.tp);
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

  const ok = rec.status === 'ok' || rec.status === 'simulated';
  if (ok) {
    removeRowByKey(key);
    toast(`✔ ${rec.order.symbol} ${rec.order.side} ${rec.order.qty} — ${rec.status}`);
  } else {
    setCardPending(key, false);
    render();
    shakeCard(key);
    const card = cardByKey(key);
    if (card) card.title = rec.reason || 'Rejected';
    toast(`✖ ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
  }
});

// ======= UI events =======
$filter.addEventListener('input', () => { state.filter = $filter.value || ''; render(); });
$autoscroll.addEventListener('change', () => { state.autoscroll = $autoscroll.checked; });
$wrap.addEventListener('wheel', () => { state.autoscroll = false; $autoscroll.checked = false; });

// initial render
render();

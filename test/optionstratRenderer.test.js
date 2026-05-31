const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping optionstratRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const cancelled = [];
  const estimates = [];
  const payoff = {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false
  };
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get') return { autoscroll: true };
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'execution:cancel-order') {
        cancelled.push(payload);
        return { status: 'ok' };
      }
      if (ch === 'optionstrat:estimate') {
        estimates.push(payload);
        return { status: 'ok', payoff };
      }
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcRenderer };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  await new Promise(resolve => setImmediate(resolve));
  const t = renderer.__testing;
  const row = {
    ticker: 'SPY',
    symbol: 'SPY',
    event: 'optionstrat',
    time: 1,
    price: undefined,
    instrumentType: 'OPT',
    provider: 'optionstrat',
    name: 'BCS 755/756',
    expirationDte: '0DTE',
    legs: [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
    ]
  };

  handlers['orders:new'](null, row);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const key = t.rowKey(row);
  let card = t.cardByKey(key);
  assert.strictEqual(estimates.length, 1);
  assert.strictEqual(estimates[0].ticker, 'SPY');
  assert.deepStrictEqual(estimates[0].legs, row.legs);
  assert(card.textContent.includes('Max Loss $900'));
  assert(card.textContent.includes('Max Profit $100'));
  assert(card.textContent.includes('RR 1:0.1'));
  assert(card.textContent.includes('SPY 0DTE +10C755/-10C756'));
  assert.strictEqual(card.querySelector('button.btn').textContent, 'OPEN');

  t.placedOrderByKey.set(key, { provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY', payoff });
  t.setCardState(key, 'placed');
  card = t.cardByKey(key);
  let closeButton = card.querySelector('button.btn');
  assert.strictEqual(closeButton.textContent, 'CLOSE');
  closeButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(cancelled, [{ provider: 'optionstrat', ticket: 'deal-1', symbol: 'SPY' }]);
  card = t.cardByKey(key);
  assert(card.querySelector('.card__status').classList.contains('card__status--profit'));
  assert.strictEqual(card.querySelector('.btns').style.display, 'none');

  t.setCardState(key, 'profit');
  card = t.cardByKey(key);
  assert.strictEqual(card.querySelector('.btns').style.display, 'none');
  assert(card.textContent.includes('Max Loss $900'));
  console.log('optionstratRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping strategyValues test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, ...args) => {
      if (ch === 'orders:list') return [];
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

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="autoscroll"><input id="cmdline">`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  const t = renderer.__testing;

  const row = { ticker: 'TST', event: 'evt', time: 0, price: 1 };
  handlers['orders:new'](null, row);
  const key = t.rowKey(row);
  t.setCardState(key, 'pending-exec');

  handlers['execution:pending'](null, { reqId: 'r1', pendingId: 'p1', order: { symbol: 'TST', side: 'buy', price: 2.5, sl: 5, tp: 15, qty: 7 } });

  const card = t.cardByKey(key);
  const q = card.querySelector('input.qty');
  const p = card.querySelector('input.pr');
  const s = card.querySelector('input.sl');
  const tpin = card.querySelector('input.tp');

  assert.strictEqual(q.value, '7');
  assert.strictEqual(p.value, '2.5');
  assert.strictEqual(s.value, '5');
  assert.strictEqual(tpin.value, '15');

  console.log('strategyValues test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

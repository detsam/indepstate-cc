const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping buttonStyles test');
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
  const card = t.cardByKey(t.rowKey(row));
  const buttons = card.querySelectorAll('button.btn');
  const bfbBtn = Array.from(buttons).find(b => b.textContent === 'BFB');
  const sfbBtn = Array.from(buttons).find(b => b.textContent === 'SFB');
  assert(bfbBtn.classList.contains('bc'));
  assert(sfbBtn.classList.contains('sc'));
  console.log('buttonStyles test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

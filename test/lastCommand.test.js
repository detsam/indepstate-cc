const assert = require('assert');
const manifest = require('../app/services/tvListener/manifest');
const { createCommandService } = require('../app/services/commandLine');

function run() {
  const api = { commands: [], tvProxy: { addListener(fn) { this.fn = fn; } } };
  manifest.initService(api);
  const samplePayload = {
    sources: {
      foo: {
        state: { type: 'LineToolHorzLine', points: [{ price: 1.5 }] },
        symbol: 'NYSE:AAA'
      }
    }
  };
  api.tvProxy.fn({ event: 'http_request', text: JSON.stringify(samplePayload) });

  let row;
  const cmdService = createCommandService({ commands: api.commands, onAdd: r => { row = r; } });

  let res = cmdService.run('add BBB 100 20');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'BBB');

  res = cmdService.run('last');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'AAA');
  assert.strictEqual(row.price, 1.5);
  assert.strictEqual(row.sl, 6);
  console.log('lastCommand tests passed');
}

try { run(); } catch (err) { console.error(err); process.exit(1); }

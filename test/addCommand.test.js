const assert = require('assert');
const { AddCommand } = require('../app/services/commands/add');

async function run() {
  let row;
  const cmd = new AddCommand({ onAdd: r => { row = r; } });

  // default SL
  let res = cmd.run(['AAA', '100']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 10);

  // raw points
  res = cmd.run(['AAA', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 20);

  // price with decimal dot -> convert relative to entry price (tick 0.01)
  res = cmd.run(['AAA', '100', '99.75']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.sl, 25);

  // ticker capitalization without dot
  res = cmd.run(['bbb', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'BBB');

  // ticker capitalization up to dot
  res = cmd.run(['ccc.def', '100', '20']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'CCC.def');

  console.log('addCommand tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

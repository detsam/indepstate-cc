const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DWXAdapter } = require('../app/services/brokerage-adapter-dwx/comps/dwx');

async function run() {
  const mtPath = path.join(__dirname, 'tmp');
  fs.mkdirSync(mtPath, { recursive: true });
  const adapter = new DWXAdapter({ metatraderDirPath: mtPath });
  let sentComment, sentSl, sentTp;
  adapter.client.open_order = async function(_symbol, _type, _qty, _price, sl, tp, _magic, comment) {
    sentComment = comment;
    sentSl = sl;
    sentTp = tp;
  };
  await adapter.placeOrder({
    symbol: 'EURUSD',
    side: 'buy',
    type: 'limit',
    price: 1.0835,
    sl: 20,
    tp: 40,
    qty: 0.1,
    tickSize: 0.0001,
    comment: 'test-order'
  });
  await new Promise(r => setTimeout(r, 0));
  const slPrice = 1.0835 - 20 * 0.0001;
  const tpPrice = 1.0835 + 40 * 0.0001;
  assert.ok(sentComment.includes('cid:'), 'cid missing');
  assert.ok(sentComment.includes(`sl:${slPrice}`), 'sl missing');
  assert.ok(sentComment.includes(`tp:${tpPrice}`), 'tp missing');
  assert.strictEqual(sentSl, slPrice);
  assert.strictEqual(sentTp, tpPrice);
  console.log('dwx comment test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

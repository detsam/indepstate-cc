const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DWXAdapter } = require('../app/services/brokerage-adapter-dwx/comps/dwx');

async function run() {
  const mtPath = path.join(__dirname, 'tmp');
  fs.mkdirSync(mtPath, { recursive: true });
  const adapter = new DWXAdapter({ metatraderDirPath: mtPath });
  let sentComment, sentSl, sentTp, sentPrice;
  adapter.client.open_order = async function(_symbol, _type, _qty, price, sl, tp, _magic, comment) {
    sentComment = comment;
    sentSl = sl;
    sentTp = tp;
    sentPrice = price;
  };
  const orderPrice = 1.0835;
  await adapter.placeOrder({
    symbol: 'EURUSD',
    side: 'buy',
    type: 'limit',
    price: orderPrice,
    sl: 20,
    tp: 40,
    qty: 0.1,
    tickSize: 0.0001,
    comment: 'test-order'
  });
  await new Promise(r => setTimeout(r, 0));
  const slPrice = orderPrice - 20 * 0.0001;
  const tpPrice = orderPrice + 40 * 0.0001;
  assert.ok(sentComment.includes('cid:'), 'cid missing');
  assert.ok(sentComment.includes(`sl:${slPrice}`), 'sl missing');
  assert.ok(sentComment.includes(`tp:${tpPrice}`), 'tp missing');
  assert.ok(sentComment.includes(`level:${orderPrice}`), 'level missing');
  assert.ok(!sentComment.includes('|'), 'comment contains forbidden pipe');
  assert.strictEqual(sentSl, slPrice);
  assert.strictEqual(sentTp, tpPrice);
  assert.strictEqual(sentPrice, orderPrice);
  console.log('dwx comment test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

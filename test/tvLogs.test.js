const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { processFile } = require('../app/services/tvLogs');

const csv = `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID\n`
+ `BINANCE:TRXUSDT.P,Buy,Market,207118.6406,,,0.34174,Filled,42.4727,50:1,"1,415.61 USD",2025-08-26 04:31:18,2025-08-26 04:31:18,2240088365\n`
+ `BINANCE:TRXUSDT.P,Sell,Market,207118.6406,,,0.34283,Filled,42.6094,50:1,"1,420.13 USD",2025-08-26 05:16:49,2025-08-26 05:16:49,2240149873\n`;

const tmp = path.join(os.tmpdir(), `tvlog-${Date.now()}.csv`);
fs.writeFileSync(tmp, csv);

const deals = processFile(tmp, undefined, 999);

assert.strictEqual(deals.length, 1);
assert.strictEqual(deals[0].symbol.ticker, 'TRXUSDT.P');
assert.strictEqual(deals[0].placingDate, '2025-08-26');

fs.unlinkSync(tmp);

console.log('tvLogs ok');

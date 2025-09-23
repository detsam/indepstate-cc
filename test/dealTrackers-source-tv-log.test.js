const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { processFile } = require('../app/services/dealTrackers-source-tv-log/comps');

const csv = `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID\n`
+ `BINANCE:TRXUSDT.P,Buy,Market,207118.6406,,,0.34174,Filled,42.4727,50:1,"1,415.61 USD",2025-08-26 04:31:18,2025-08-26 04:31:18,2240088365\n`
+ `BINANCE:TRXUSDT.P,Sell,Market,207118.6406,,,0.34283,Filled,42.6094,50:1,"1,420.13 USD",2025-08-26 05:16:49,2025-08-26 05:16:49,2240149873\n`;

const tmp = path.join(os.tmpdir(), `tvlog-${Date.now()}.csv`);
fs.writeFileSync(tmp, csv);

const deals = processFile(tmp, undefined, 999);

assert.strictEqual(deals.length, 1);
assert.strictEqual(deals[0].symbol.ticker, 'TRXUSDT.P');
assert.strictEqual(deals[0].placingDate, '2025-08-26');
assert.strictEqual(deals[0].takePoints, 109);

fs.unlinkSync(tmp);

console.log('dealTrackers-source-tv-log ok');

const csv2 = `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID\n`
  + `SAXO:GBPCAD,Buy,Limit,19841,1.85325,,1.85325,Filled,,,,2025-08-29 05:05:34,2025-08-29 11:13:05,2248789119\n`
  + `SAXO:GBPCAD,Buy,Stop,19841,,1.85767,,Cancelled,,,,2025-08-29 05:05:19,2025-08-29 11:13:05,2248788762\n`
  + `SAXO:GBPCAD,Sell,Market,19841,,,1.85634,Filled,,50:1,535.90 USD,2025-08-29 05:05:19,2025-08-29 05:05:19,2248788761\n`;

const tmp2 = path.join(os.tmpdir(), `tvlog-${Date.now()}-2.csv`);
fs.writeFileSync(tmp2, csv2);

const deals2 = processFile(tmp2, undefined, 999);

assert.strictEqual(deals2.length, 1);
assert.strictEqual(deals2[0].symbol.ticker, 'GBPCAD');
assert.strictEqual(deals2[0].side, 'short');

fs.unlinkSync(tmp2);
console.log('dealTrackers-source-tv-log short with limit exit ok');

const csv3 = `Symbol,Side,Type,Qty,Qty Filled,Limit Price,Stop Price,Fill Price,Status,Time,Reduce Only,Post Only,Close On Trigger,Order ID\n`
  + `DOLOUSDTPERP,Buy,Stop Loss,8928,0,,0.316758,,Cancelled,2025-09-01 09:10:02,true,false,false,DOLOUSDTPERP-519814721-3-OTOCO\n`
  + `DOLOUSDTPERP,Buy,Take Profit,8928,0,0.293558,0.293558,,Cancelled,2025-09-01 09:10:02,true,false,false,DOLOUSDTPERP-519814721-2-OTOCO\n`
  + `DOLOUSDTPERP,Sell,Limit,8928,8928,0.311158,,0.311158,Filled,2025-09-01 09:10:02,false,false,false,DOLOUSDTPERP-519814721-1-OTOCO\n`
  + `DOLOUSDTPERP,Buy,Market,8928,8928,,,0.3020084,Filled,2025-09-01 09:50:11,true,false,false,DOLOUSDTPERP-660021105\n`;

const tmp3 = path.join(os.tmpdir(), `tvlog-${Date.now()}-3.csv`);
fs.writeFileSync(tmp3, csv3);

const deals3 = processFile(tmp3, undefined, 999);

assert.strictEqual(deals3.length, 1);
assert.strictEqual(deals3[0].symbol.ticker, 'DOLOUSDT.P');
assert.strictEqual(deals3[0].placingDate, '2025-09-01');
assert.strictEqual(deals3[0].tp, 17600);
assert.strictEqual(deals3[0].sp, 5599);
assert.strictEqual(deals3[0].takePoints, 9149);
assert.strictEqual(deals3[0].commission, undefined);

fs.unlinkSync(tmp3);
console.log('dealTrackers-source-tv-log new format ok');

const tmp5 = path.join(os.tmpdir(), `tvlog-${Date.now()}-5.csv`);
fs.writeFileSync(tmp5, csv3);
const deals5 = processFile(tmp5, undefined, 999, () => 'CUSTOM:TICK');
assert.strictEqual(deals5[0].symbol.exchange, 'CUSTOM');
assert.strictEqual(deals5[0].symbol.ticker, 'TICK');
fs.unlinkSync(tmp5);
console.log('dealTrackers-source-tv-log custom symbol replacer ok');

const tmp6 = path.join(os.tmpdir(), `tvlog-${Date.now()}-6.csv`);
fs.writeFileSync(tmp6, csv3);
const deals6 = processFile(tmp6, undefined, 999, undefined, { maker: 0.02, taker: 0.05 });
assert.strictEqual(deals6[0].commission, 1.9);
fs.unlinkSync(tmp6);
console.log('dealTrackers-source-tv-log commission from config ok');

const csv4 = `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID\n`
  + `BINANCE:STOP,Buy,Market,1,,,10.0000,Filled,0,20:1,100 USD,2025-01-01 00:00:00,2025-01-01 00:00:00,1\n`
  + `BINANCE:STOP,Sell,Market,1,,,9.81123,Filled,0,20:1,100 USD,2025-01-01 01:00:00,2025-01-01 01:00:00,2\n`;

const tmp4 = path.join(os.tmpdir(), `tvlog-${Date.now()}-4.csv`);
fs.writeFileSync(tmp4, csv4);

const deals4 = processFile(tmp4, undefined, 999);

assert.strictEqual(deals4.length, 1);
assert.strictEqual(deals4[0].stopPoints, 1887);

fs.unlinkSync(tmp4);
console.log('dealTrackers-source-tv-log stop points rounding ok');

// ensure dealTrackers-source-tv-log.start avoids fetching images when trackers skip existing notes
delete require.cache[require.resolve('../app/services/dealTrackers-source-tv-log/comps')];
const chartImagesPath = require.resolve('../app/services/dealTrackers-chartImages/comps');

let composeCount = 0;
require.cache[chartImagesPath] = {
  exports: {
    compose1D: () => { composeCount++; },
    compose5M: () => { composeCount++; }
  }
};

const dealTrackersPath = require.resolve('../app/services/dealTrackers/comps');
let notifyCount = 0;
require.cache[dealTrackersPath] = {
  exports: {
    shouldWritePositionClosed: () => false,
    notifyPositionClosed: () => { notifyCount++; }
  }
};
const tvLogs = require('../app/services/dealTrackers-source-tv-log/comps');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlogs-'));
  const file = path.join(dir, 'log.csv');
  fs.writeFileSync(file, csv);
  const svc = tvLogs.start({ accounts: [{ dir }], pollMs: 20 });
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(composeCount, 0);
    assert.strictEqual(notifyCount, 0);
  } finally {
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('dealTrackers-source-tv-log skipExisting ok');
})();

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlogs-keep-'));
  const file = path.join(dir, 'log.csv');
  fs.writeFileSync(file, csv);
  const svc = tvLogs.start({ accounts: [{ dir, deleteProcessedLogs: false }], pollMs: 20 });
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(fs.existsSync(file), true);
  } finally {
    svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('dealTrackers-source-tv-log keep logs opt-out ok');
})();

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
  await new Promise(r => setTimeout(r, 50));
  svc.stop();
  assert.strictEqual(composeCount, 0);
  assert.strictEqual(notifyCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('dealTrackers-source-tv-log skipExisting ok');
})();

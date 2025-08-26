const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { processFile } = require('../app/services/mt5Logs');

const rows = [
  {
    openTime: '2025.08.26 16:30:47',
    positionId: '236993502',
    symbol: 'KDP',
    side: 'buy',
    volume: '642',
    openPrice: '30.90',
    sl: '30.77',
    tp: '31.11',
    closeTime: '2025.08.26 16:32:09',
    closePrice: '30.77',
    commission: '-0.77',
    swap: '0.00',
    profit: '-83.46'
  },
  {
    openTime: '2025.08.26 16:35:28',
    positionId: '236993719',
    symbol: 'ETSY',
    side: 'buy',
    volume: '360',
    openPrice: '55.235',
    sl: '55.40',
    tp: '56.03',
    closeTime: '2025.08.26 16:53:59',
    closePrice: '56.03',
    commission: '-0.68',
    swap: '0.00',
    profit: '286.20'
  },
  {
    openTime: '2025.08.26 16:37:15',
    positionId: '236993785',
    symbol: 'PACK',
    side: 'sell',
    volume: '750',
    openPrice: '5.73',
    sl: '5.79',
    tp: '5.55',
    closeTime: '2025.08.26 16:37:17',
    closePrice: '5.79',
    commission: '-0.38',
    swap: '0.00',
    profit: '-45.00'
  },
  {
    openTime: '2025.08.26 16:38:18',
    positionId: '236993823',
    symbol: 'PACK',
    side: 'sell',
    volume: '300',
    openPrice: '5.75',
    sl: '5.90',
    tp: '5.30',
    closeTime: '2025.08.26 16:47:21',
    closePrice: '5.49',
    commission: '-0.15',
    swap: '0.00',
    profit: '78.00'
  },
  {
    openTime: '2025.08.26 16:38:37',
    positionId: '236993915',
    symbol: 'SATS',
    side: 'buy',
    volume: '54',
    openPrice: '52.60',
    sl: '53.67',
    tp: '58.68',
    closeTime: '2025.08.26 17:31:50',
    closePrice: '53.83',
    commission: '-0.10',
    swap: '0.00',
    profit: '66.42'
  },
  {
    openTime: '2025.08.26 16:39:45',
    positionId: '236994016',
    symbol: 'RRGB',
    side: 'buy',
    volume: '225',
    openPrice: '7.03',
    sl: '7.05',
    tp: '7.63',
    closeTime: '2025.08.26 17:21:35',
    closePrice: '7.30',
    commission: '-0.13',
    swap: '0.00',
    profit: '60.75'
  },
  {
    openTime: '2025.08.26 16:42:53',
    positionId: '236994115',
    symbol: 'GOOG',
    side: 'sell',
    volume: '90',
    openPrice: '207.90',
    sl: '207.70',
    tp: '206.40',
    closeTime: '2025.08.26 16:47:19',
    closePrice: '207.07',
    commission: '-0.56',
    swap: '0.00',
    profit: '74.70'
  },
  {
    openTime: '2025.08.26 16:52:46',
    positionId: '236994461',
    symbol: 'HOLO',
    side: 'buy',
    volume: '500',
    openPrice: '4.72',
    sl: '4.63',
    tp: '4.99',
    closeTime: '2025.08.26 16:54:49',
    closePrice: '4.63',
    commission: '-0.24',
    swap: '0.00',
    profit: '-45.00'
  },
  {
    openTime: '2025.08.26 16:55:00',
    positionId: '236994510',
    symbol: 'SHLS',
    side: 'sell',
    volume: '750',
    openPrice: '7.09',
    sl: '7.15',
    tp: '6.91',
    closeTime: '2025.08.26 17:19:44',
    closePrice: '6.91',
    commission: '-0.41',
    swap: '0.00',
    profit: '135.00'
  },
  {
    openTime: '2025.08.26 16:56:22',
    positionId: '236994542',
    symbol: 'DOMO',
    side: 'buy',
    volume: '225',
    openPrice: '17.00',
    sl: '16.80',
    tp: '17.60',
    closeTime: '2025.08.26 16:57:15',
    closePrice: '16.80',
    commission: '-0.19',
    swap: '0.00',
    profit: '-45.00'
  },
  {
    openTime: '2025.08.26 16:57:39',
    positionId: '236994568',
    symbol: 'SMTC',
    side: 'buy',
    volume: '90',
    openPrice: '56.76',
    sl: '57.96',
    tp: '59.25',
    closeTime: '2025.08.26 17:14:58',
    closePrice: '58.11',
    commission: '-0.19',
    swap: '0.00',
    profit: '121.50'
  },
  {
    openTime: '2025.08.26 17:24:43',
    positionId: '236995155',
    symbol: 'HUT',
    side: 'sell',
    volume: '250',
    openPrice: '25.18',
    sl: '25.36',
    tp: '24.64',
    closeTime: '2025.08.26 17:24:48',
    closePrice: '25.36',
    commission: '-0.26',
    swap: '0.00',
    profit: '-45.00'
  },
  {
    openTime: '2025.08.26 17:26:29',
    positionId: '236995212',
    symbol: 'U',
    side: 'buy',
    volume: '204',
    openPrice: '40.60',
    sl: '40.76',
    tp: '41.26',
    closeTime: '2025.08.26 17:45:30',
    closePrice: '40.82',
    commission: '-0.31',
    swap: '0.00',
    profit: '44.88'
  },
  {
    openTime: '2025.08.26 17:29:18',
    positionId: '236995278',
    symbol: 'HUT',
    side: 'sell',
    volume: '250',
    openPrice: '25.17',
    sl: '25.35',
    tp: '24.63',
    closeTime: '2025.08.26 17:33:06',
    closePrice: '25.35',
    commission: '-0.25',
    swap: '0.00',
    profit: '-45.00'
  },
  {
    openTime: '2025.08.26 17:37:31',
    positionId: '236995601',
    symbol: 'EOSE',
    side: 'sell',
    volume: '916',
    openPrice: '6.72',
    sl: '6.78',
    tp: '6.54',
    closeTime: '2025.08.26 17:48:20',
    closePrice: '6.78',
    commission: '-0.49',
    swap: '0.00',
    profit: '-54.96'
  },
  {
    openTime: '2025.08.26 17:42:30',
    positionId: '236995676',
    symbol: 'CCL',
    side: 'sell',
    volume: '562',
    openPrice: '31.48',
    sl: '31.54',
    tp: '31.24',
    closeTime: '2025.08.26 17:45:00',
    closePrice: '31.54',
    commission: '-0.69',
    swap: '0.00',
    profit: '-33.72'
  }
];

function buildHtml(rows) {
  const header = `<!DOCTYPE html><html><body><div><table>`;
  const positionsHeader = `<tr align="center"><th colspan="14"><div><b>Trade History Report</b></div></th></tr>` +
    `<tr align="center"><th colspan="14"><div><b>Positions</b></div></th></tr>` +
    `<tr align="center" bgcolor="#E5F0FC"><td><b>Time</b></td><td><b>Position</b></td><td><b>Symbol</b></td><td><b>Type</b></td><td><b>Volume</b></td><td><b>Price</b></td><td><b>S / L</b></td><td><b>T / P</b></td><td><b>Time</b></td><td><b>Price</b></td><td><b>Commission</b></td><td><b>Swap</b></td><td colspan="2"><b>Profit</b></td></tr>`;
  const rowsHtml = rows.map((r, i) =>
    `<tr bgcolor="${i % 2 ? '#F7F7F7' : '#FFFFFF'}" align="right"><td>${r.openTime}</td><td>${r.positionId}</td><td>${r.symbol}</td><td>${r.side}</td><td class="hidden" colspan="8">cid:x</td><td>${r.volume}</td><td>${r.openPrice}</td><td>${r.sl}</td><td>${r.tp}</td><td>${r.closeTime}</td><td>${r.closePrice}</td><td>${r.commission}</td><td>${r.swap}</td><td colspan="2">${r.profit}</td></tr>`
  ).join('');
  const footer = `<tr><td></td></tr><tr align="center"><th colspan="14"><div><b>Orders</b></div></th></tr></table></div></body></html>`;
  return header + positionsHeader + rowsHtml + footer;
}

function buildHtmlPositionsOnly(rows) {
  const header = `<!DOCTYPE html><html><body><div><table>`;
  const positionsHeader = `<tr align="center"><th colspan="14"><div><b>Trade History Report</b></div></th></tr>` +
    `<tr align="center"><th colspan="14"><div><b>Positions</b></div></th></tr>` +
    `<tr align="center" bgcolor="#E5F0FC"><td><b>Time</b></td><td><b>Position</b></td><td><b>Symbol</b></td><td><b>Type</b></td>` +
    `<td><b>Volume</b></td><td><b>Price</b></td><td><b>S / L</b></td><td><b>T / P</b></td><td><b>Time</b></td><td><b>Price</b></td><td><b>Commission</b></td><td><b>Swap</b></td><td colspan="2"><b>Profit</b></td></tr>`;
  const rowsHtml = rows.map((r, i) =>
    `<tr bgcolor="${i % 2 ? '#F7F7F7' : '#FFFFFF'}" align="right"><td>${r.openTime}</td><td>${r.positionId}</td><td>${r.symbol}</td><td>${r.side}</td><td class="hidden" colspan="8">cid:x</td><td>${r.volume}</td><td>${r.openPrice}</td><td>${r.sl}</td><td>${r.tp}</td><td>${r.closeTime}</td><td>${r.closePrice}</td><td>${r.commission}</td><td>${r.swap}</td><td colspan="2">${r.profit}</td></tr>`
  ).join('');
  const footer = `</table></div></body></html>`;
  return header + positionsHeader + rowsHtml + footer;
}

const tmp = path.join(os.tmpdir(), 'mt5-report.html');
fs.writeFileSync(tmp, Buffer.from('\ufeff' + buildHtml(rows), 'utf16le'));

const deals = processFile(tmp, undefined, Infinity);

assert.strictEqual(deals.length, rows.length);
assert.deepStrictEqual(deals[0].symbol, { ticker: 'KDP' });
assert.strictEqual(deals[0].profit, -83.46);
assert.strictEqual(deals[0].placingDate, '2025-08-26');
assert.deepStrictEqual(deals[deals.length - 1].symbol, { ticker: 'CCL' });
assert.strictEqual(deals[deals.length - 1].profit, -33.72);
assert.ok(Math.abs(deals[0].stopPoints - 0.13) < 1e-8);
assert.ok(Math.abs(deals[1].takePoints - 0.795) < 1e-8);

const tmp2 = path.join(os.tmpdir(), 'mt5-report-positions-only.html');
fs.writeFileSync(tmp2, Buffer.from('\ufeff' + buildHtmlPositionsOnly(rows), 'utf16le'));
const deals2 = processFile(tmp2, undefined, Infinity);
assert.strictEqual(deals2.length, rows.length);

console.log('mt5Logs parsing test passed');


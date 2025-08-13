const fs = require('fs');

const { OrderCardsSource } = require('./base');

// Lines in the watched file must be formatted as:
//   TICKER PRICE [SL_POINTS TP_POINTS QTY]
// Only TICKER and PRICE are required. If TP is provided then SL must be
// provided; if QTY is provided then both SL and TP must be present. Values are
// separated by whitespace.
function parseLine(line, nowTs) {
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [ticker, priceStr, slStr = '', tpStr = '', qtyStr = ''] = parts;
  const price = Number(priceStr);
  if (!Number.isFinite(price)) return null;
  const row = { ticker, price, time: nowTs() };
  if (slStr !== '') {
    const sl = parseInt(slStr, 10);
    if (Number.isFinite(sl)) row.sl = sl;
  }
  if (tpStr !== '') {
    const tp = parseInt(tpStr, 10);
    if (Number.isFinite(tp)) row.tp = tp;
  }
  if (qtyStr !== '') {
    const qty = Number(qtyStr);
    if (Number.isFinite(qty)) row.qty = qty;
  }
  return row;
}

class FileOrderCardsSource extends OrderCardsSource {
  constructor(opts = {}) {
    super();
    this.pathEnvVar = opts.pathEnvVar || opts.envVar || opts.env || 'ORDER_CARDS_PATH';
    this.pollMs = opts.pollMs || opts.intervalMs || 1000;
    this.nowTs = opts.nowTs || (() => Date.now());
    this.onRow = typeof opts.onRow === 'function' ? opts.onRow : () => {};
    this.timer = null;
    this.prev = new Map(); // ticker -> json string
  }

  filePath() {
    const p = process.env[this.pathEnvVar];
    return p && String(p).trim();
  }

  poll() {
    const file = this.filePath();
    if (!file) return;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return; // ignore
    }
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const row = parseLine(line, this.nowTs);
      if (!row) continue;
      const sig = JSON.stringify(row);
      const prev = this.prev.get(row.ticker);
      if (prev !== sig) {
        this.prev.set(row.ticker, sig);
        try { this.onRow(row); } catch {}
      }
    }
  }

  async start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getOrdersList(rows = 100) {
    const arr = Array.from(this.prev.values()).map(s => JSON.parse(s));
    return arr.slice(-Math.max(1, rows));
  }
}

module.exports = { FileOrderCardsSource };

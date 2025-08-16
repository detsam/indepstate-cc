const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { ChartImageComposer } = require('./base');

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
}

class TvChartImageComposer extends ChartImageComposer {
  constructor(cfg = {}) {
    super();
    this.apiDomain = cfg.apiDomain;
    this.apiKey = cfg.apiKey;
    this.layoutId = cfg.layoutId;
    this.outputDir = cfg.outputDir || process.cwd();
    const rps = Number(cfg.throttlePerSecond) || 9;
    this._interval = 1000 / rps;
    this._queue = [];
    this._timer = null;
  }

  compose(symbol) {
    if (!this.apiDomain || !this.apiKey || !this.layoutId) {
      throw new Error('TvChartImageComposer misconfigured');
    }
    const safe = sanitizeFileName(symbol);
    const name = `${Date.now()}-${safe}.png`;
    this._queue.push({ symbol, name });
    this._schedule();
    return name;
  }

  _schedule() {
    if (this._timer) return;
    const run = () => {
      if (this._queue.length === 0) {
        this._timer = null;
        return;
      }
      const { symbol, name } = this._queue.shift();
      this._fetchAndSave(symbol, name).catch(e => console.error('TV chart request failed', e));
      this._timer = setTimeout(run, this._interval);
    };
    this._timer = setTimeout(run, 0);
  }

  async _fetchAndSave(symbol, name) {
    const url = `https://${this.apiDomain}/v2/tradingview/layout-chart/${this.layoutId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ symbol })
    });
    if (!res.ok) throw new Error(`TV chart request failed: ${res.status}`);
    const buf = await res.buffer();
    const filePath = path.join(this.outputDir, name);
    await fs.promises.writeFile(filePath, buf);
  }
}

module.exports = { TvChartImageComposer };

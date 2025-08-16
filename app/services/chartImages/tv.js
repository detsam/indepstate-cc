const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { ChartImageComposer } = require('./base');

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
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
    this._chain = Promise.resolve();
    this._last = 0;
  }

  compose(symbol) {
    this._chain = this._chain.then(() => this._throttledCompose(symbol));
    return this._chain;
  }

  async _throttledCompose(symbol) {
    const now = Date.now();
    const wait = Math.max(0, this._interval - (now - this._last));
    if (wait > 0) await sleep(wait);
    this._last = Date.now();
    return this._fetchAndSave(symbol);
  }

  async _fetchAndSave(symbol) {
    if (!this.apiDomain || !this.apiKey || !this.layoutId) {
      throw new Error('TvChartImageComposer misconfigured');
    }
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
    const safe = sanitizeFileName(symbol);
    const name = `${Date.now()}-${safe}.png`;
    const filePath = path.join(this.outputDir, name);
    await fs.promises.writeFile(filePath, buf);
    return name;
  }
}

module.exports = { TvChartImageComposer };

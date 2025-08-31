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
    this.outputDir = cfg.outputDir || process.cwd();
    this.fallbackExchanges = Array.isArray(cfg.fallbackExchanges) ? cfg.fallbackExchanges.filter(Boolean) : [];
    const rps = Number(cfg.throttlePerSecond) || 9;
    this._interval = 1000 / rps;
    this._queue = [];
    this._timer = null;
  }

  compose(symbol, layoutId) {
    if (!this.apiDomain || !this.apiKey || !layoutId) {
      throw new Error('TvChartImageComposer misconfigured');
    }
    const safe = sanitizeFileName(symbol);
    const layoutSafe = sanitizeFileName(layoutId);
    const name = `${Date.now()}-${layoutSafe}-${safe}.png`;
    this._queue.push({ symbol, name, layoutId });
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
      const { symbol, name, layoutId } = this._queue.shift();
      this._fetchAndSave(symbol, name, layoutId).catch(e => console.error('TV chart request failed', e));
      this._timer = setTimeout(run, this._interval);
    };
    this._timer = setTimeout(run, 0);
  }

  async _fetchAndSave(symbol, name, layoutId) {
    const url = `https://${this.apiDomain}/v2/tradingview/layout-chart/${layoutId}`;

    const tryFetch = async s => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ symbol: s })
      });
      if (res.ok) return res.buffer();
      if (res.status === 422) return null; // unknown symbol / exchange
      throw new Error(`TV chart request failed: ${res.status}`);
    };

    let buf = await tryFetch(symbol);
    if (!buf) {
      for (const ex of this.fallbackExchanges) {
        buf = await tryFetch(`${ex}:${symbol}`);
        if (buf) break;
      }
    }

    if (!buf) throw new Error('TV chart request failed: 422');
    const filePath = path.join(this.outputDir, name);
    await fs.promises.writeFile(filePath, buf);
  }
}

module.exports = { TvChartImageComposer };

const net = require('net');
const { ExecutionAdapter } = require('./base');

class DWXExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {Object} cfg
   * @param {string} [cfg.socketPath='/tmp/dwx.socket'] path to DWX Connect Unix socket
   * @param {number} [cfg.timeoutMs=5000]
   */
  constructor({ socketPath = '/tmp/dwx.socket', timeoutMs = 5000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.provider = 'dwx';
  }

  _send(message) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => {
        socket.write(message + '\n');
      });

      let data = '';
      socket.on('data', chunk => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        resolve(data.trim());
      });

      socket.on('error', err => {
        socket.destroy();
        reject(err);
      });

      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        reject(new Error('Socket timeout'));
      });
    });
  }

  async placeOrder(order) {
    try {
      const payload = JSON.stringify(order);
      const res = await this._send(payload);
      let parsed;
      try {
        parsed = JSON.parse(res);
      } catch (e) {
        return {
          status: 'rejected',
          provider: this.provider,
          reason: 'Invalid JSON response from DWX',
          raw: res
        };
      }

      if (parsed.status === 'ok') {
        return {
          status: 'ok',
          provider: this.provider,
          providerOrderId: parsed.orderId ? String(parsed.orderId) : undefined,
          raw: parsed
        };
      }

      return {
        status: 'rejected',
        provider: this.provider,
        reason: parsed.message || 'Unknown error',
        raw: parsed
      };
    } catch (err) {
      return {
        status: 'rejected',
        provider: this.provider,
        reason: err.message || String(err)
      };
    }
  }
}

module.exports = { DWXExecutionAdapter };

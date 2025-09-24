const fs = require('fs');
const path = require('path');
const os = require('os');

const events = require('../events');
const loadConfig = require('../../config/load');

const { USER_ROOT, APP_ROOT } = loadConfig;

function resolveFilePath(file) {
  const fallbackDir = USER_ROOT || APP_ROOT || process.cwd();
  const fallback = path.join(fallbackDir, 'logs', 'execution-log.jsonl');
  if (typeof file !== 'string' || !file.trim()) return fallback;
  let normalized = file.trim();
  if (normalized.startsWith('~')) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(fallbackDir, normalized);
}

function toMs(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 24 * 60 * 60 * 1000);
}

function extractTimestamp(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.sentAt,
    obj.time,
    obj.t,
    obj.timestamp,
    obj.createdAt,
    obj.meta && obj.meta.sentAt,
    obj.meta && obj.meta.time,
    obj.meta && obj.meta.timestamp,
    obj.meta && obj.meta.createdAt,
  ];
  for (const cand of candidates) {
    const num = Number(cand);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

class ExecutionLogService {
  constructor(opts = {}) {
    this.filePath = resolveFilePath(opts.file);
    this.retentionMs = toMs(opts.retentionDays);
    this.listener = (message) => this.handleMessage(message);
  }

  start() {
    this.ensureFile();
    this.rotate();
    events.on('execution:order-message', this.listener);
  }

  stop() {
    events.off('execution:order-message', this.listener);
  }

  ensureFile() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, '');
      }
    } catch (err) {
      console.error('[execution-log] unable to ensure log file:', err.message);
    }
  }

  rotate() {
    if (!this.retentionMs) return;
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      console.error('[execution-log] unable to read log file:', err.message);
      return;
    }
    if (!text) return;

    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return;

    const cutoff = Date.now() - this.retentionMs;
    const kept = [];
    let removed = false;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const ts = extractTimestamp(parsed);
        if (ts == null || ts >= cutoff) {
          kept.push(line);
        } else {
          removed = true;
        }
      } catch (err) {
        // keep unparseable lines to avoid data loss
        kept.push(line);
      }
    }
    if (!removed) return;
    try {
      const body = kept.join('\n');
      fs.writeFileSync(this.filePath, body ? body + '\n' : '');
    } catch (err) {
      console.error('[execution-log] unable to rotate log file:', err.message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(message) + '\n');
    } catch (err) {
      console.error('[execution-log] unable to append entry:', err.message);
    }
  }
}

function createExecutionLogService(opts) {
  return new ExecutionLogService(opts);
}

module.exports = {
  ExecutionLogService,
  createExecutionLogService,
};

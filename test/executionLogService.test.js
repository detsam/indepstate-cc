const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../app/services/events');
const { createExecutionLogService } = require('../app/services/execution-log');

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-log-service-'));
  const logFile = path.join(tmpDir, 'execution-log.jsonl');
  const now = Date.now();
  const stale = { symbol: 'OLD', meta: { sentAt: now - 3 * 24 * 60 * 60 * 1000 } };
  const fresh = { symbol: 'NEW', meta: { sentAt: now - 12 * 60 * 60 * 1000 } };
  fs.writeFileSync(logFile, `${JSON.stringify(stale)}\n${JSON.stringify(fresh)}\n`);

  const svc = createExecutionLogService({ file: logFile, retentionDays: 2 });
  svc.start();

  let lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'expected rotation to remove stale entry');
  const kept = JSON.parse(lines[0]);
  assert.strictEqual(kept.symbol, 'NEW');

  const payload = { symbol: 'APPEND', meta: { sentAt: now } };
  events.emit('execution:order-message', payload);

  lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, 'expected appended entry');
  const appended = JSON.parse(lines[1]);
  assert.strictEqual(appended.symbol, 'APPEND');

  svc.stop();
  console.log('executionLogService tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

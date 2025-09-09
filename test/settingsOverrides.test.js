const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../app/services/settings');
const loadConfig = require('../app/config/load');

async function run() {
  const defaultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'));
  const file = 'sample.json';

  const defaultsPath = path.join(defaultsDir, file);
  fs.writeFileSync(defaultsPath, JSON.stringify({ foo: 1 }, null, 2));
  fs.writeFileSync(path.join(userDir, file), JSON.stringify({ foo: 2, extra: 3 }, null, 2));

  const originalRoots = loadConfig.CONFIG_ROOTS.slice();
  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir);

  settings.register('sample', defaultsPath);
  const { config } = settings.readConfig('sample');
  assert.deepStrictEqual(config, { foo: 2 });

  loadConfig.CONFIG_ROOTS.length = 0;
  originalRoots.forEach(r => loadConfig.CONFIG_ROOTS.push(r));

  console.log('settings override tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

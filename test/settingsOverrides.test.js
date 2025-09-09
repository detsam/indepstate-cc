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
  let { config } = settings.readConfig('sample');
  assert.deepStrictEqual(config, { foo: 2 });

  // allow arbitrary provider keys when descriptor opts in
  const defaultsDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults2-'));
  const userDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'user2-'));
  const file2 = 'exec.json';
  const defaultsPath2 = path.join(defaultsDir2, file2);
  fs.writeFileSync(defaultsPath2, JSON.stringify({ providers: { base: { a: 1 } } }, null, 2));
  fs.writeFileSync(path.join(defaultsDir2, 'exec-settings-descriptor.json'), JSON.stringify({ properties: {}, options: { providers: { __allowUnknown: true } } }, null, 2));
  fs.writeFileSync(path.join(userDir2, file2), JSON.stringify({ providers: { base: { a: 2 }, extra: { b: 3 } } }, null, 2));

  loadConfig.CONFIG_ROOTS.length = 0;
  loadConfig.CONFIG_ROOTS.push(userDir2);

  settings.register('exec', defaultsPath2, path.join(defaultsDir2, 'exec-settings-descriptor.json'));
  ({ config } = settings.readConfig('exec'));
  assert.deepStrictEqual(config, { providers: { base: { a: 2 }, extra: { b: 3 } } });

  loadConfig.CONFIG_ROOTS.length = 0;
  originalRoots.forEach(r => loadConfig.CONFIG_ROOTS.push(r));

  console.log('settings override tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

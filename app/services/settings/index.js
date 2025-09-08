const fs = require('fs');
const path = require('path');
const loadConfig = require('../../config/load');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function listConfigs() {
  const files = fs.readdirSync(CONFIG_DIR);
  return files
    .filter(f => f.endsWith('.json') && !f.endsWith('-settings-descriptor.json'))
    .map(f => path.basename(f, '.json'));
}

function readConfig(name) {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const cfg = loadConfig(file);
  let descriptor = {};
  try {
    const descPath = path.join(CONFIG_DIR, `${path.basename(file, '.json')}-settings-descriptor.json`);
    descriptor = JSON.parse(fs.readFileSync(descPath, 'utf8'));
  } catch {
    descriptor = {};
  }
  return { config: cfg, descriptor };
}

function writeConfig(name, data) {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const overridePath = path.join(loadConfig.USER_ROOT, 'config', file);
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(data, null, 2));
  return true;
}

module.exports = { listConfigs, readConfig, writeConfig };

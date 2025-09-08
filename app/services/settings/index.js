const fs = require('fs');
const path = require('path');
const loadConfig = require('../../config/load');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function listConfigs() {
  const files = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('-settings-descriptor.json'))
    .map(f => path.basename(f, '.json'));
  const meta = files.map(name => {
    let props = {};
    try {
      const descPath = path.join(CONFIG_DIR, `${name}-settings-descriptor.json`);
      const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
      props = desc.properties || {};
    } catch {}
    return { key: name, name: props.name || name, group: props.group };
  });
  const priority = ['ui', 'services', 'auto-updater'];
  const noGroup = meta.filter(m => !m.group);
  const ordered = [];
  priority.forEach(p => {
    const idx = noGroup.findIndex(m => m.key === p);
    if (idx !== -1) ordered.push(noGroup.splice(idx, 1)[0]);
  });
  noGroup.sort((a, b) => a.name.localeCompare(b.name));
  const grouped = meta.filter(m => m.group).reduce((acc, m) => {
    (acc[m.group] = acc[m.group] || []).push(m);
    return acc;
  }, {});
  Object.keys(grouped).forEach(g => grouped[g].sort((a, b) => a.name.localeCompare(b.name)));
  const groups = Object.keys(grouped).sort();
  return ordered.concat(noGroup, ...groups.flatMap(g => grouped[g]));
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

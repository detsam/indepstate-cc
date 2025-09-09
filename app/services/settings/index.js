const fs = require('fs');
const path = require('path');
const loadConfig = require('../../config/load');

const registry = new Map(); // key -> { defaultsPath, descriptorPath }

function register(key, defaultsPath, descriptorPath) {
  registry.set(key, { defaultsPath, descriptorPath });
}

function loadWithOverrides(info) {
  return loadConfig(info.defaultsPath);
}

function listConfigs() {
  const meta = [];
  for (const [key, info] of registry.entries()) {
    let props = {};
    if (info.descriptorPath) {
      try {
        const desc = JSON.parse(fs.readFileSync(info.descriptorPath, 'utf8'));
        props = desc.properties || {};
      } catch {}
    }
    meta.push({ key, name: props.name || key, group: props.group });
  }
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
  const info = registry.get(name);
  if (!info) return {};
  const cfg = loadWithOverrides(info);
  let descriptor = {};
  if (info.descriptorPath) {
    try {
      descriptor = JSON.parse(fs.readFileSync(info.descriptorPath, 'utf8'));
    } catch {}
  }
  return { config: cfg, descriptor };
}

function writeConfig(name, data) {
  const info = registry.get(name);
  if (!info) return false;
  const fileName = path.basename(info.defaultsPath);
  const overridePath = path.join(loadConfig.USER_ROOT, 'config', fileName);
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(data, null, 2));
  return true;
}

module.exports = { register, listConfigs, readConfig, writeConfig };

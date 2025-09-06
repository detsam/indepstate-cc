const fs = require('fs');
const path = require('path');
const electron = require('electron');

const app = electron?.app;
const APP_ROOT = app?.isPackaged ? path.dirname(app.getAppPath()) : process.cwd();

const CONFIG_ROOTS = [];
if (app?.getPath) {
  CONFIG_ROOTS.push(path.join(APP_ROOT, 'config'));
  CONFIG_ROOTS.push(path.join(app.getPath('userData'), 'config'));
} else {
  CONFIG_ROOTS.push(path.join(APP_ROOT, 'config'));
}
const CONFIG_ROOT = CONFIG_ROOTS[CONFIG_ROOTS.length - 1];

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      const tgtVal = target[key];
      if (!tgtVal || typeof tgtVal !== 'object' || Array.isArray(tgtVal)) {
        target[key] = {};
      }
      deepMerge(target[key], srcVal);
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}

function load(name) {
  const defaultsPath = path.join(__dirname, name);
  let defaults = {};
  try {
    defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  } catch (e) {
    console.error(`[config] cannot read default ${name}:`, e.message);
  }

  for (const root of CONFIG_ROOTS) {
    const overridePath = path.join(root, name);
    if (fs.existsSync(overridePath)) {
      try {
        const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
        deepMerge(defaults, override);
      } catch (e) {
        console.error(`[config] cannot read override ${name}:`, e.message);
      }
    }
  }

  return defaults;
}

module.exports = Object.assign(load, { APP_ROOT, CONFIG_ROOT, CONFIG_ROOTS });

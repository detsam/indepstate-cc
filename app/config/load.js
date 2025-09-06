const fs = require('fs');
const path = require('path');
const electron = require('electron');

const app = electron?.app;
const APP_ROOT = app?.isPackaged ? path.dirname(app.getAppPath()) : process.cwd();
const CONFIG_ROOT = app?.getPath ? path.join(app.getPath('userData'), 'config') : path.join(APP_ROOT, 'config');

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

  const overridePath = path.join(CONFIG_ROOT, name);
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      return deepMerge(defaults, override);
    } catch (e) {
      console.error(`[config] cannot read override ${name}:`, e.message);
    }
  }

  return defaults;
}

module.exports = Object.assign(load, { APP_ROOT, CONFIG_ROOT });

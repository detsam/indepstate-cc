const fs = require('fs');
const path = require('path');
const electron = require('electron');

const app = electron?.app;
const APP_ROOT = app?.isPackaged ? path.dirname(app.getAppPath()) : process.cwd();

const APP_NAME = app?.getName ? app.getName() : 'ISCC';
let USER_ROOT;
if (app?.getPath) {
  if (process.platform === 'win32') {
    USER_ROOT = path.join(app.getPath('home'), 'AppData', 'Local', APP_NAME);
  } else {
    USER_ROOT = app.getPath('userData');
  }
} else {
  USER_ROOT = APP_ROOT;
}

const LOG_FILE = path.join(USER_ROOT, 'logs', 'app.txt');
function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    console.error('[log] cannot write to log file:', e.message);
  }
}

const CONFIG_ROOTS = [];
CONFIG_ROOTS.push(path.join(APP_ROOT, 'config'));
if (USER_ROOT !== APP_ROOT) {
  CONFIG_ROOTS.push(path.join(USER_ROOT, 'config'));
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
  log(`[config] load defaults ${defaultsPath}`);
  let defaults = {};
  try {
    defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  } catch (e) {
    console.error(`[config] cannot read default ${name}:`, e.message);
    log(`[config] cannot read default ${defaultsPath}: ${e.message}`);
  }

  for (const root of CONFIG_ROOTS) {
    const overridePath = path.join(root, name);
    if (fs.existsSync(overridePath)) {
      log(`[config] apply override ${overridePath}`);
      try {
        const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
        // deepMerge mutates its target but also returns it; assign back so callers
        // receive the fully merged object even if implementation changes
        defaults = deepMerge(defaults, override);
      } catch (e) {
        console.error(`[config] cannot read override ${name}:`, e.message);
        log(`[config] cannot read override ${overridePath}: ${e.message}`);
      }
    } else {
      log(`[config] no override found ${overridePath}`);
    }
  }

  return defaults;
}

module.exports = Object.assign(load, { APP_ROOT, CONFIG_ROOT, CONFIG_ROOTS });

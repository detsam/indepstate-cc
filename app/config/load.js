const fs = require('fs');
const path = require('path');
const electron = require('electron');

const app = electron?.app;

// Resolve the directory containing the application. In a packaged build prefer
// the folder with the executable so that a sibling `config` directory can be
// used for overrides. When running from source fall back to the current working
// directory.
const APP_ROOT = app?.isPackaged
  ? path.dirname(app.getPath ? app.getPath('exe') : process.execPath)
  : process.cwd();

const APP_NAME = app?.getName ? app.getName() : 'ISCC';
let USER_ROOT;
if (process.platform === 'win32') {
  // On Windows prefer the `%LOCALAPPDATA%` location to keep overrides out of
  // the roaming profile. Fall back to `home\\AppData\\Local` if the env var is
  // missing (e.g. during tests).
  const base = process.env.LOCALAPPDATA ||
    (app?.getPath ? path.join(app.getPath('home'), 'AppData', 'Local')
                   : path.join(require('os').homedir(), 'AppData', 'Local'));
  USER_ROOT = path.join(base, APP_NAME);
} else if (app?.getPath) {
  USER_ROOT = app.getPath('userData');
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
  if (Array.isArray(source)) return source.slice();
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (Array.isArray(srcVal)) {
      target[key] = srcVal.slice();
    } else if (srcVal && typeof srcVal === 'object') {
      const tgtVal = target[key];
      if (!tgtVal || typeof tgtVal !== 'object' || Array.isArray(tgtVal)) {
        target[key] = {};
      }
      target[key] = deepMerge(target[key], srcVal);
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
        log(`[config] merged result ${JSON.stringify(defaults)}`);
      } catch (e) {
        console.error(`[config] cannot read override ${name}:`, e.message);
        log(`[config] cannot read override ${overridePath}: ${e.message}`);
      }
    } else {
      log(`[config] no override found ${overridePath}`);
    }
  }

  log(`[config] final ${JSON.stringify(defaults)}`);
  return defaults;
}

module.exports = Object.assign(load, { APP_ROOT, CONFIG_ROOT, CONFIG_ROOTS });

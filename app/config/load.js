const fs = require('fs');
const path = require('path');

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

  const overridePath = path.resolve(process.cwd(), 'config', name);
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

module.exports = load;

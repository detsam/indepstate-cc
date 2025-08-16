// services/adapterRegistry.js
// Creates and caches adapter instances by provider name and injects config
// from config/execution.json (or via initExecutionConfig).

const loadConfig = require('../config/load');

let executionConfig = null; // set via initExecutionConfig() or lazy‑loaded from disk
const instances = new Map(); // name -> adapter instance

function deepClone(obj){ return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

function loadExecutionConfigFromDisk() {
  try {
    return loadConfig('execution.json');
  } catch (e) {
    console.error('[adapterRegistry] cannot read execution.json:', e.message);
    return { providers:{}, byInstrumentType:{}, default:'simulated' };
  }
}

function initExecutionConfig(cfg){
  executionConfig = deepClone(cfg || {});
  // config changed — rebuild adapters on next getAdapter()
  instances.clear();
}

function getExecutionConfig(){
  if (!executionConfig) executionConfig = loadExecutionConfigFromDisk();
  return executionConfig;
}

// Support secrets like "$ENV:NAME" or "${ENV:NAME}"
function resolveEnvRef(str){
  if (typeof str !== 'string') return str;
  const m = str.match(/^\s*(?:\$\{?ENV:([A-Z0-9_]+)\}?)\s*$/i);
  if (!m) return str;
  const v = process.env[m[1]];
  return v == null ? '' : v;
}
function resolveSecrets(obj){
  if (!obj || typeof obj !== 'object') return resolveEnvRef(obj);
  if (Array.isArray(obj)) return obj.map(resolveSecrets);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = resolveSecrets(obj[k]);
  return out;
}

function buildAdapter(name, cfg){
  const n = String(name || '').toLowerCase();
  switch (n) {
    case 'j2t': {
      const { J2TExecutionAdapter } = require('../adapters/j2t');
      const inst = new J2TExecutionAdapter(cfg || {});
      inst.provider = 'j2t';
      return inst;
    }
    case 'dwx': {
      const { DWXAdapter } = require('../adapters/dwx/dwx');
      const inst = new DWXAdapter(cfg || {});
      inst.provider = 'dwx';
      return inst;
    }
    case 'simulated':
    default: {
      const { SimulatedExecutionAdapter } = require('../adapters/simulated');
      const inst = new SimulatedExecutionAdapter(cfg || {});
      inst.provider = 'simulated';
      return inst;
    }
  }
}

function getAdapter(name){
  const n = String(name || '').toLowerCase();
  if (instances.has(n)) return instances.get(n);

  const cfg = getExecutionConfig();
  const provCfg = resolveSecrets((cfg.providers && cfg.providers[n]) || {});
  const inst = buildAdapter(n, provCfg);
  instances.set(n, inst);
  return inst;
}

function getProviderConfig(name){
  const cfg = getExecutionConfig();
  return (cfg.providers && cfg.providers[name]) || {};
}

module.exports = { getAdapter, initExecutionConfig, getProviderConfig };

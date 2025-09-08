// services/brokerage/adapterRegistry.js
// Creates and caches adapter instances by provider name and injects config
// from services/brokerage/config/execution.json (or via initExecutionConfig).

const loadConfig = require('../../config/load');
const brokerageAdapters = require('./brokerageAdapters');

let executionConfig = null; // set via initExecutionConfig() or lazy‑loaded from disk
const instances = new Map(); // name -> adapter instance

function deepClone(obj){ return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

function loadExecutionConfigFromDisk() {
  try {
    return loadConfig('../services/brokerage/config/execution.json');
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

function buildAdapter(providerName, cfg){
  const { adapter: adapterName, ...adapterCfg } = cfg || {};
  if (!adapterName) {
    throw new Error(`[adapterRegistry] provider "${providerName}" must specify an adapter`);
  }
  const n = String(adapterName).toLowerCase();
  const key = brokerageAdapters[n] ? n : n.split(/[:\-]/)[0];
  const factory = brokerageAdapters[key];
  if (typeof factory !== 'function') {
    throw new Error(`[adapterRegistry] unknown adapter "${adapterName}" for provider "${providerName}"`);
  }
  const inst = factory(adapterCfg, providerName, adapterName);
  inst.provider = providerName;
  return inst;
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

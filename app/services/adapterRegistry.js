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

function buildAdapter(providerName, cfg){
  const { adapter: adapterName, ...adapterCfg } = cfg || {};
  if (!adapterName) {
    throw new Error(`[adapterRegistry] provider "${providerName}" must specify an adapter`);
  }
  const n = String(adapterName).toLowerCase();

  // CCXT сімейство: дозволяємо імена 'ccxt', 'ccxt:binance', 'ccxt-binance-futures' тощо
  if (n === 'ccxt' || n.startsWith('ccxt:') || n.startsWith('ccxt-')) {
    const { CCXTExecutionAdapter } = require('../adapters/ccxt');
    const inst = new CCXTExecutionAdapter(adapterCfg);
    // зберігаємо оригінальну назву провайдера (корисно для логів/подій)
    inst.provider = providerName;
    return inst;
  }

  switch (n) {
    case 'j2t': {
      const { J2TExecutionAdapter } = require('../adapters/j2t');
      const inst = new J2TExecutionAdapter(adapterCfg);
      inst.provider = providerName;
      return inst;
    }
    case 'dwx': {
      const { DWXAdapter } = require('../adapters/dwx/dwx');
      const events = require('./events');
      const userHandler = adapterCfg.event_handler || {};
      adapterCfg.event_handler = {
        ...userHandler,
        on_bar_data(symbol, tf, time, open, high, low, close, vol) {
          try {
            events.emit('bar', { provider: providerName, symbol, tf, time, open, high, low, close, vol });
          } catch {}
          userHandler.on_bar_data?.(symbol, tf, time, open, high, low, close, vol);
        }
      };
      const inst = new DWXAdapter(adapterCfg);
      inst.provider = providerName;
      return inst;
    }
    case 'simulated': {
      const { SimulatedExecutionAdapter } = require('../adapters/simulated');
      const inst = new SimulatedExecutionAdapter(adapterCfg);
      inst.provider = providerName;
      return inst;
    }
    default:
      throw new Error(`[adapterRegistry] unknown adapter "${adapterName}" for provider "${providerName}"`);
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

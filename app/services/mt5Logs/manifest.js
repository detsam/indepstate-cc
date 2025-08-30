const mt5Logs = require('./comps');
const loadConfig = require('../../config/load');

/**
 * @param {import('../serviceContext').ServiceContext} context
 */
function initService(context = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('mt5-logs.json');
  } catch {
    cfg = {};
  }
  if (cfg.enabled === false) return;

  const getAdapter = context.providers?.getAdapter;
  const getProviderConfig = context.providers?.getProviderConfig;

  const names = new Set();
  if (cfg.dwxProvider) names.add(cfg.dwxProvider);
  if (Array.isArray(cfg.accounts)) {
    for (const acc of cfg.accounts) {
      if (acc.dwxProvider) names.add(acc.dwxProvider);
    }
  }
  const dwxClients = {};
  const dwxConfigs = {};
  for (const name of names) {
    const adapter = typeof getAdapter === 'function' ? getAdapter(name) : undefined;
    if (adapter?.client) dwxClients[name] = adapter.client;
    const providerCfg = typeof getProviderConfig === 'function' ? getProviderConfig(name) : undefined;
    if (providerCfg) dwxConfigs[name] = providerCfg;
  }
  mt5Logs.start({ ...cfg, dwx: dwxConfigs }, { dwxClients });
}

module.exports = { initService };

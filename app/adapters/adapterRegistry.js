const { SimulatedAdapter } = require('../adapters/simulated');
// сюда позже добавим реальные адаптеры

let singletons = {};

function getAdapter(name, opts = {}) {
  if (singletons[name]) return singletons[name];
  switch (name) {
    case 'simulated':
      singletons[name] = new SimulatedAdapter(opts);
      break;
    // case 'alpaca': singletons[name] = new AlpacaAdapter(opts); break;
    // case 'ib':     singletons[name] = new IbAdapter(opts); break;
    // case 'binance':singletons[name] = new BinanceAdapter(opts); break;
    default:
      throw new Error(`Unknown adapter: ${name}`);
  }
  return singletons[name];
}

module.exports = { getAdapter };

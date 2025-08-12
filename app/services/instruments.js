function detectInstrumentType(symbol) {
  return /\.?USDT\.P$/.test(symbol) ? 'CX' : 'EQ';
}
module.exports = { detectInstrumentType };

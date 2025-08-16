function detectInstrumentType(symbol) {
  return /\.?USDT\.P$/.test(symbol.toUpperCase()) ? 'CX' :
  /\.?(?:USD|EUR|GBP|CHF|MXN)$/.test(symbol.toUpperCase()) ? 'FX' :  'EQ';
}



module.exports = { detectInstrumentType };

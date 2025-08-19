function detectInstrumentType(symbol) {
  return /\.?USDT\.P$/.test(symbol.toUpperCase()) ? 'CX' :
  /\.?(?:USD|EUR|GBP|CHF|MXN|JPY|AUD)$/.test(symbol.toUpperCase()) ? 'FX' :  'EQ';
}



module.exports = { detectInstrumentType };

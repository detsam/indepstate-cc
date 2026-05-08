function detectInstrumentType(symbol) {
  return /\.?USD[TC]\.P$/.test(symbol.toUpperCase()) ? 'CX' :
  /\.?(?:USD|EUR|GBP|CHF|MXN|JPY|AUD|CAD|NZD|PLN|SGD|TRY)(?:\.C)?$/.test(symbol.toUpperCase()) ? 'FX' :  'EQ';
}



module.exports = { detectInstrumentType };

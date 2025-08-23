// app/services/points/index.js
// Конверсия: priceΔ -> points. Приоритет: tickSize из конфига → цифровой fallback.

const loadConfig = require('../../config/load');
let cfg = {};
try {
  cfg = loadConfig('tick-sizes.json');
} catch (_) {
  cfg = {};
}

function wildcardToRegExp(pat) {
  return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}

function findTickSizeFromConfig(symbol) {
  if (!symbol) return null;
  const bySymbol = cfg?.bySymbol || {};
  if (Object.prototype.hasOwnProperty.call(bySymbol, symbol)) {
    const v = Number(bySymbol[symbol]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  const patterns = cfg?.patterns || [];
  for (const p of patterns) {
    const re = wildcardToRegExp(p.match);
    if (re.test(symbol)) {
      const v = Number(p.tickSize);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
  }
  const def = Number(cfg?.defaultTickSize);
  return Number.isFinite(def) && def > 0 ? def : null;
}

// ---------- Цифровой fallback ----------
function expandExpToDecimal(str) {
  // Разворачиваем 1e-5, -2.3E+4 и т.п. в обычную десятичную строку
  const m = String(str).trim().match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!m) return String(str);
  const sign = m[1] || '';
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exp = parseInt(m[4], 10) || 0;

  let digits = intPart + fracPart; // без точки
  if (exp >= 0) {
    digits += '0'.repeat(exp);
    return (sign === '-' ? '-' : '') + digits;
  } else {
    const shift = -exp;
    const zerosToPrefix = Math.max(0, shift - intPart.length);
    return (sign === '-' ? '-' : '') + '0.' + '0'.repeat(zerosToPrefix) + digits;
  }
}

function digitsFallbackPoints(deltaToken) {
  if (deltaToken == null) return undefined;
  let s = String(deltaToken).trim();
  if (!s) return undefined;

  // Убираем разделители, разворачиваем экспоненту
  s = s.replace(/,/g, '');
  if (/e/i.test(s)) s = expandExpToDecimal(s);

  // Оставляем знак и цифры/точку, далее убираем точку
  const neg = s.startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  s = s.replace('.', ''); // точка одна — удаляем

  // Отбрасываем ведущие нули
  s = s.replace(/^0+/, '');
  if (!s) return 0;

  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.abs(n) * (neg ? 1 : 1); // знак для дельты не нужен, но оставим симметрию
}

// ---------- Публичные функции ----------
function toPoints(hookTick, symbol, deltaPrice, priceHint, deltaTokenForFallback) {
  const dp = Number(deltaPrice);
  // 0) Пытаемся через tick пришедший с запросом
  if (Number.isFinite(hookTick) && hookTick > 0 && Number.isFinite(dp)) {
    return Math.round(dp / hookTick);
  }

  // 1) Пытаемся через tickSize
  const tick = findTickSizeFromConfig(symbol);
  if (Number.isFinite(tick) && tick > 0 && Number.isFinite(dp)) {
    return Math.round(dp / tick);
  }

  // 2) Цифровой fallback по сырому токену (строке)
  const byDigits = digitsFallbackPoints(deltaTokenForFallback ?? deltaPrice);
  if (Number.isFinite(byDigits)) return byDigits;

  // Если вообще ничего не получилось — undefined
  return undefined;
}

module.exports = { toPoints, digitsFallbackPoints, findTickSizeFromConfig };

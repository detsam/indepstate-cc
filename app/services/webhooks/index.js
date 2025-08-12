// Реестр парсеров вебхуков
const parsers = [
  require('./parsers/atr'),
  require('./parsers/json'),
  require('./parsers/plain'),
];

function parseWebhook(raw, nowTs) {
  for (const p of parsers) {
    try {
      if (p.test(raw)) {
        const res = p.parse(raw, nowTs);
        if (res && res.row) return { name: p.name, row: res.row };
      }
    } catch (e) {
      // не валим весь поток — пробуем следующий парсер
    }
  }
  return null;
}

module.exports = { parseWebhook };

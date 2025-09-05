// поднимает mitmdump тихо и транслирует только stdout аддона
'use strict';
const { spawn } = require('child_process');

const PORT = process.env.PORT || '8888';

// ТИХИЕ флаги для mitmdump:
const args = [
  '-s', 'tv-wslog.py',          // твой аддон
  '-p', PORT,                   // порт прокси
  '-q',                         // quiet-режим (минимум логов)
  '--set', 'console_eventlog_verbosity=error', // только ошибки
  '--set', 'console_flowlist_verbosity=error', // скрыть список флоу
  '--set', 'flow_detail=0',     // не распечатывать детали флоу
  // '--set', 'websocket=true',  // обычно и так true; оставь на всякий
];

// Стартуем прокси
const mitm = spawn('mitmdump', args, {
  stdio: ['ignore', 'pipe', 'ignore'],
});

console.log(`[mitmdump] started on 127.0.0.1:${PORT}`);

// Пайпуем stdout построчно (у тебя там JSON из tv-wslog.py)
mitm.stdout.setEncoding('utf8');
let buf = '';
mitm.stdout.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    // Можно просто вывести как есть:
    console.log(line);
    // Или распарсить и красиво:
    // try { const rec = JSON.parse(line); /* ... */ } catch {}
  }
});

mitm.on('exit', (code, sig) => {
  console.error(`[mitmdump] exited: code=${code} sig=${sig || ''}`);
  process.exit(code || 0);
});

process.on('SIGINT', () => { mitm.kill('SIGINT'); });
process.on('SIGTERM', () => { mitm.kill('SIGTERM'); });

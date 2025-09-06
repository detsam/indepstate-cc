const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { APP_ROOT, USER_ROOT } = require('../../config/load');

function start(opts = {}) {
  const proxyPort = opts.proxyPort || 8888;
  const webhookPort = opts.webhookPort || 0;
  const webhookUrl = opts.webhookUrl || `http://localhost:${webhookPort}/webhook`;

  const roots = [];
  if (USER_ROOT && USER_ROOT !== APP_ROOT) roots.push(USER_ROOT);
  roots.push(APP_ROOT);
  let script;
  for (const root of roots) {
    const candidate = path.join(root, 'extensions', 'mitmproxy', 'tv-wslog.py');
    if (fs.existsSync(candidate)) { script = candidate; break; }
  }
  if (!script) {
    console.error('[tv-proxy] tv-wslog.py not found');
    return { stop() {} };
  }
  const args = [
    '-s', script,
    '-p', String(proxyPort),
    '-q',
    '--set', 'console_eventlog_verbosity=error',
    '--set', 'console_flowlist_verbosity=error',
    '--set', 'flow_detail=0',
  ];
  const proc = spawn('mitmdump', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  console.log(`[tv-proxy] mitmdump started on 127.0.0.1:${proxyPort}`);

  proc.stdout.setEncoding('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.event === 'message' && typeof rec.text === 'string' && rec.text.includes('@ATR')) {
            fetch(webhookUrl, {
            method: 'POST',
            body: rec.text,
            headers: { 'content-type': 'text/plain' }
          }).catch(() => {});
        }
      } catch {}
    }
  });

  proc.on('exit', (code, sig) => {
    console.error(`[tv-proxy] mitmdump exited: code=${code} sig=${sig || ''}`);
  });

  return {
    stop() {
      try { proc.kill('SIGTERM'); } catch {}
    }
  };
}

module.exports = { start };

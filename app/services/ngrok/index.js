const ngrok = require('@ngrok/ngrok');

async function start({ authToken, domain, port }) {
  const opts = { addr: port };
  if (authToken) opts.authtoken = authToken;
  if (domain) opts.domain = domain;
  const listener = await ngrok.forward(opts);
  console.log(`[ngrok] forwarding ${listener.url()} -> http://localhost:${port}`);
  return listener;
}

module.exports = { start };

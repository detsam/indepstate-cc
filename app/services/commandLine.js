// services/commandLine.js
// Parses and executes text commands using registered command objects
// Commands may expose multiple names/aliases

const { AddCommand } = require('./commands/add');

function createCommandService(opts = {}) {
  const { commands } = opts;
  const list = Array.isArray(commands) && commands.length
    ? commands
    : [new AddCommand({ onAdd: opts.onAdd })];

  function run(str) {
    if (!str) return { ok: false, error: 'Empty command' };
    const [cmd, ...args] = str.trim().split(/\s+/);
    const key = (cmd || '').toLowerCase();
    const handler = list.find(c => {
      const names = Array.isArray(c.names) && c.names.length ? c.names : [c.name];
      return names.some(n => String(n).toLowerCase() === key);
    });
    if (!handler) {
      return { ok: false, error: `Unknown command: ${cmd}` };
    }
    try {
      return handler.run(args);
    } catch (e) {
      return { ok: false, error: e.message || 'Command error' };
    }
  }

  return { run };
}

module.exports = { createCommandService };

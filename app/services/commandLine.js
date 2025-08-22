// services/commandLine.js
// Parses and executes text commands using registered command objects

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
    const handler = list.find(c => c.name === key);
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

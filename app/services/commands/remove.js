const { Command } = require('./base');

class RemoveCommand extends Command {
  constructor(opts = {}) {
    super(['rm']);
    this.onRemove = opts.onRemove;
  }

  run(args) {
    if (!Array.isArray(args) || args.length === 0) {
      return { ok: false, error: 'Usage: rm criterion' };
    }
    const [rawCriterion] = args;
    const str = typeof rawCriterion === 'string' ? rawCriterion.trim() : '';
    if (!str) {
      return { ok: false, error: 'Invalid criterion' };
    }
    const sepIdx = str.indexOf(':');
    if (sepIdx <= 0) {
      return { ok: false, error: 'Invalid criterion' };
    }
    const key = str.slice(0, sepIdx).trim();
    const value = str.slice(sepIdx + 1).trim();
    if (!key || !value) {
      return { ok: false, error: 'Invalid criterion' };
    }

    if (!this.onRemove || typeof this.onRemove !== 'function') {
      return { ok: false, error: 'Remove handler not available' };
    }

    if (key === 'producingLineId') {
      const res = this.onRemove({ producingLineId: value });
      if (res && typeof res.then === 'function') {
        return res.then((out) => (out && typeof out === 'object' ? out : { ok: true })).catch((err) => ({
          ok: false,
          error: err?.message || 'Remove handler error'
        }));
      }
      if (res && typeof res === 'object') return res;
      return { ok: true };
    }

    return { ok: false, error: `Unknown criterion: ${key}` };
  }
}

module.exports = { RemoveCommand };

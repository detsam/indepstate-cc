class Command {
  constructor(names) {
    const arr = Array.isArray(names) ? names : [names];
    this.names = arr.filter(Boolean).map(n => String(n).toLowerCase());
    this.name = this.names[0];
  }

  run(_args) {
    throw new Error('Not implemented');
  }
}

module.exports = { Command };

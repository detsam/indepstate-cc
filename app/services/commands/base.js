class Command {
  constructor(name) {
    this.name = name;
  }
  run(_args) {
    throw new Error('Not implemented');
  }
}

module.exports = { Command };

const { EventEmitter } = require('events');

const bus = new EventEmitter();

module.exports = {
  /** Subscribe to event */
  on: (...args) => bus.on(...args),
  /** Unsubscribe */
  off: (...args) => bus.off(...args),
  /** Emit event */
  emit: (...args) => bus.emit(...args),
  events: bus,
};

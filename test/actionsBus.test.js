const assert = require('assert');
const { createActionsBus } = require('../app/services/actions-bus');

function run() {
  const executed = [];
  const bus = createActionsBus();

  bus.configure([
    { event: 'foo', action: 'commandLine:test {symbol}', name: 'Foo action' },
    { event: 'foo', action: 'other:always-run' },
    { event: 'foo', action: 'no-prefix-run' }
  ]);

  let named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Foo action', label: 'Foo action', enabled: true }]);

  bus.emit('foo', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, []);

  const commandLineRunner = (cmd) => {
    executed.push(`cli:${cmd}`);
    return { ok: true };
  };

  bus.registerCommandRunner('commandLine', commandLineRunner);
  bus.setCommandRunner(commandLineRunner);

  bus.registerCommandRunner('other', (cmd) => {
    executed.push(`other:${cmd}`);
    return { ok: true };
  });

  assert.deepStrictEqual(executed, ['cli:test AAA', 'cli:no-prefix-run', 'other:always-run']);

  bus.emit('foo', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run'
  ]);

  bus.setActionEnabled('Foo action', false);
  assert.strictEqual(bus.getActionState('Foo action'), false);
  bus.emit('foo', { symbol: 'BBB' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:no-prefix-run'
  ]);

  bus.configure([
    { event: 'bar', action: 'commandLine:second {price}', name: 'Second' }
  ]);

  executed.length = 0;
  bus.emit('bar', { price: 1.23 });
  assert.deepStrictEqual(executed, ['cli:second 1.23']);

  named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Second', label: 'Second', enabled: true }]);
  assert.strictEqual(bus.getActionState('Foo action'), undefined);

  console.log('actionsBus tests passed');
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}

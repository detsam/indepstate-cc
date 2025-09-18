const assert = require('assert');
const { createActionsBus } = require('../app/services/actions-bus');

function run() {
  const executed = [];
  const bus = createActionsBus();

  bus.configure([
    {
      name: 'Foo action',
      label: 'Foo toggle',
      bindings: [
        { event: 'foo', action: 'commandLine:test {symbol}' },
        { event: 'bar', action: 'commandLine:bar {symbol}' }
      ]
    },
    { event: 'foo', action: 'other:always-run' },
    { event: 'foo', action: 'no-prefix-run' }
  ]);

  let named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Foo action', label: 'Foo toggle', enabled: true }]);

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
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

  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:no-prefix-run',
    'other:always-run'
  ]);

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA'
  ]);

  bus.setActionEnabled('Foo action', false);
  assert.strictEqual(bus.getActionState('Foo action'), false);
  bus.emit('foo', { symbol: 'BBB' });
  bus.emit('bar', { symbol: 'BBB' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA',
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

const assert = require('assert');
const {
  createGetDealsHistoryHandler,
  normalizeDealsHistoryInput
} = require('../app/services/mcp');

async function run() {
  const fakeDeals = [
    { ticket: '1', symbol: 'EURUSD', dealTime: '2026-06-10T12:00:00.000Z' }
  ];
  let received;
  const handler = createGetDealsHistoryHandler({
    brokerage: {
      getExecutionConfig: () => ({ default: 'dwx' }),
      getAdapter(provider) {
        assert.strictEqual(provider, 'dwx');
        return {
          async getDealsHistory(args) {
            received = args;
            return fakeDeals;
          }
        };
      }
    }
  });

  const result = await handler({
    from: '2026-06-10T00:00:00.000Z',
    to: '2026-06-11T00:00:00.000Z',
    symbol: 'EURUSD',
    magic: 42,
    timeoutMs: 1234
  });
  assert.strictEqual(result.provider, 'dwx');
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.deals, fakeDeals);
  assert.strictEqual(received.filters.symbol, 'EURUSD');
  assert.strictEqual(received.filters.magic, 42);
  assert.strictEqual(received.timeoutMs, 1234);

  const normalized = normalizeDealsHistoryInput(
    { provider: 'SIMULATED', from: '2026-06-10T00:00:00Z' },
    { getExecutionConfig: () => ({ default: 'dwx' }) }
  );
  assert.strictEqual(normalized.provider, 'simulated');

  const unsupported = createGetDealsHistoryHandler({
    brokerage: {
      getExecutionConfig: () => ({ default: 'simulated' }),
      getAdapter() { return {}; }
    }
  });
  await assert.rejects(
    () => unsupported({ from: '2026-06-10T00:00:00Z' }),
    /does not support deals history/
  );

  console.log('mcp deals history tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const dealTrackers = require('../app/services/dealTrackers/comps');
const { ObsidianDealTracker } = require('../app/services/dealTrackers/comps/obsidian');

async function run() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const journal = path.join(vault, 'journal');
  fs.mkdirSync(journal, { recursive: true });
  const templateDir = path.join(vault, 'z. Staff', 'Templates');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'Template. Deal.md'), '- Date::\n');

  const info = { symbol: { ticker: 'ABC' }, placingDate: '2025-08-26' };
  const opts = { skipExisting: [{ field: 'Ticker', prop: 'symbol.ticker' }] };

  // ObsidianDealTracker.shouldWrite without existing note
  const tracker = new ObsidianDealTracker({ vaultPath: vault, journalPath: journal });
  assert.strictEqual(tracker.shouldWrite(info, opts), true);

  // Create existing note that satisfies criteria
  const notePath = path.join(journal, '2025-08-26. ABC.md');
  fs.writeFileSync(notePath, '---\nTicker: ABC\n---\n');
  assert.strictEqual(tracker.shouldWrite(info, opts), false);

  // dealTrackers.shouldWritePositionClosed with same tracker
  dealTrackers.init({ trackers: [{ type: 'obsidian', vaultPath: vault, journalPath: journal }] });
  let res = dealTrackers.shouldWritePositionClosed(info, opts);
  assert.strictEqual(res, false);

  // Remove note to allow writing again
  fs.unlinkSync(notePath);
  res = dealTrackers.shouldWritePositionClosed(info, opts);
  assert.strictEqual(res, true);

  // Create note via notifyPositionClosed
  dealTrackers.notifyPositionClosed({ ...info, status: 'take' }, opts);
  assert.strictEqual(fs.existsSync(notePath), true);

  console.log('dealTrackers tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });

// The console data service: /api/state snapshot and the SSE event stream.
// docs/spec/ui-server.md; the fixture tree is shared with h1's server and h2's console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPTS_LIMIT, VERSION, snapshot, watch } from '../src/ui/data.js';
import { writeBrain } from './fixtures/registry/helpers.js';
import { tempDir, withEnv } from './fixtures/registry/helpers.js';
import { installUiDataFixture } from './fixtures/ui-data/install.js';
import { appendReceipt } from '../src/registry/receipts.js';
import { writeInboxEntry } from '../src/registry/inbox.js';
import { writeHold } from '../src/policy/held.js';
import { writeClaims } from '../src/policy/claims.js';
import { mergeConfig, writeConfig } from '../src/policy/config.js';

const RECEIPT = '1767225601000';
const TEAM_ENTRY_T = 1767225610000;

function fixtureEnv(over = {}) {
  const home = tempDir('sbb-ui-');
  const sbbDir = join(home, '.sbb');
  installUiDataFixture(sbbDir);
  const restore = withEnv({
    SBB_HOME_OVERRIDE: home,
    SBB_DIR: sbbDir,
    TMUX_PANE: undefined,
    ...over,
  });
  return { home, sbbDir, restore };
}

function collector() {
  const events = [];
  return {
    events,
    onEvent: (kind, object) => events.push({ kind, object }),
    /** @param {string} kind */
    async waitFor(kind, ms = 4000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = events.find((e) => e.kind === kind);
        if (hit) return hit.object;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no "${kind}" event within ${ms}ms; saw [${events.map((e) => e.kind).join(', ')}]`);
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('snapshot: the /api/state object built from the fixture, read-only and partial-write tolerant', async () => {
  const { sbbDir, restore } = fixtureEnv();
  try {
    const state = await snapshot();
    assert.deepEqual(Object.keys(state).sort(), [
      'accounts', 'brains', 'claims', 'held', 'plans', 'policy', 'quota', 'receipts', 'teams', 'tps',
      'tree', 'version',
    ]);

    assert.equal(state.version, VERSION);
    assert.match(state.version, /^\d+\.\d+\.\d+$/);
    assert.equal(state.brains.length, 3, 'three brain records');

    // tree: two roots, the sub nested under its main, children sorted by name
    assert.deepEqual(state.tree.map((n) => n.name), ['lead', 'lead-b']);
    assert.deepEqual(state.tree[0].children.map((n) => n.name), ['fe-a']);
    assert.deepEqual(state.tree[1].children, []);

    assert.ok(Array.isArray(state.accounts));
    assert.ok(Array.isArray(state.quota), 'quota is unknown without Usage Guard, never invented');
    assert.equal(state.policy.teams.subsDirect, true);
    assert.equal(state.held.length, 1);
    assert.equal(state.held[0].msgId, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee');
    assert.deepEqual(state.plans.map((p) => p.planId), ['TST-20260101-0001']);
    assert.deepEqual(state.claims.map((c) => `${c.brain}:${c.resource}`), ['TST-0002:branch:m3/h3-teams-data']);
    assert.equal(state.tps, null, 'src/metrics/tps.js does not exist yet, so tps is null, never guessed');

    // receipts: the newest 500 log lines, newest first; the half-written last line is skipped
    assert.deepEqual(state.receipts.map((r) => r.msgId), [
      'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    ]);
    assert.equal(state.receipts[0].status, 'delivered');
    assert.equal(state.receipts[0].replyTo, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');

    // teams: one channel per main, with members; the malformed trailing log line is skipped
    assert.deepEqual(state.teams.map((t) => t.name), ['#lead', '#lead-b']);
    const lead = state.teams[0];
    assert.equal(lead.id, 'team:TST-0001');
    assert.equal(lead.mainId, 'TST-0001');
    assert.equal(lead.count, 2, 'the main plus its one sub');
    assert.deepEqual(lead.members.map((m) => m.id), ['TST-0001', 'TST-0002']);
    assert.deepEqual(state.teams[1].members.map((m) => m.id), ['TST-0003'], 'a lone main is its own team');

    // The fixture's last receipts line and last team-log line are half written; both
    // readers must return the complete entries only.
    const receipts = readFileSync(join(sbbDir, 'log', 'receipts.jsonl'), 'utf8');
    assert.ok(receipts.trimEnd().endsWith('cccccccc-'), 'fixture really ends mid-line');
    const again = await snapshot();
    assert.deepEqual(again, state, 'snapshot is deterministic and read-only');
  } finally {
    restore();
  }
});

test('snapshot: receipts are capped at the newest 500, newest first', async () => {
  const { restore } = fixtureEnv();
  try {
    const lines = Array.from({ length: 620 }, (_, i) => ({
      t: 1767225600000 + i,
      msgId: `cap-${String(i).padStart(4, '0')}`,
      status: 'delivered',
    }));
    const state = await snapshot({ readReceipts: () => lines });
    assert.equal(state.receipts.length, RECEIPTS_LIMIT);
    assert.equal(state.receipts[0].msgId, 'cap-0619', 'newest first');
    assert.equal(state.receipts.at(-1).msgId, 'cap-0120', 'the oldest 120 fall off');
  } finally {
    restore();
  }
});

test('watch: every typed event carries the full updated object', async () => {
  const { sbbDir, restore } = fixtureEnv();
  const { events, onEvent, waitFor } = collector();
  // A short re-snapshot window: an fs event written before the OS watcher is armed is
  // picked up by the re-snapshot's own flush, which is the documented fallback.
  const watcher = watch(onEvent, { debounceMs: 10, resnapshotMs: 250 });
  try {
    await sleep(100);
    appendReceipt({
      msgId: 'aaaa1111-0000-4000-8000-000000000001', status: 'delivered', via: 'uds',
      from: 'lead', fromId: 'TST-0001', to: 'fe-a', toId: 'TST-0002', text: 'new one',
    });
    const receipt = await waitFor('receipt');
    assert.equal(receipt.msgId, 'aaaa1111-0000-4000-8000-000000000001');
    assert.equal(receipt.status, 'delivered');

    writeInboxEntry({ owner: 'lead', entry: { msgId: 'aaaa2222-0000-4000-8000-000000000002', from: 'be-a', text: 'mirror' } });
    const message = await waitFor('message');
    assert.equal(message.msgId, 'aaaa2222-0000-4000-8000-000000000002');
    assert.equal(message.from, 'be-a');

    writeBrain({ id: 'TST-0009', name: 'new-sub', role: 'sub', parent: 'TST-0001', account: 'a' });
    const brain = await waitFor('brain');
    assert.equal(brain.id, 'TST-0009');
    assert.equal(brain.parent, 'TST-0001', 'the event carries the whole record, not a diff');

    writeHold({ msgId: 'aaaa3333-0000-4000-8000-000000000003', message: { text: 'peer ping' } });
    const held = await waitFor('held');
    assert.equal(held.msgId, 'aaaa3333-0000-4000-8000-000000000003');
    assert.equal(held.text, 'peer ping');

    writeFileSync(join(sbbDir, 'plans', 'TST-20260102-0002.json'), `${JSON.stringify({ planId: 'TST-20260102-0002', proposedAt: 2 })}\n`);
    const plan = await waitFor('plan');
    assert.equal(plan.planId, 'TST-20260102-0002');

    writeClaims({ id: 'TST-0002', claims: [{ resource: 'port:4789', at: 3 }] });
    const claim = await waitFor('claim');
    assert.equal(claim.resource, 'port:4789');
    assert.equal(claim.brain, 'TST-0002');

    writeConfig(mergeConfig({ peers: 'off' }));
    const policy = await waitFor('policy');
    assert.equal(policy.peers, 'off');
    assert.equal(policy.teams.subsDirect, true);

    assert.ok(events.length >= 6, `saw ${events.map((e) => e.kind).join(',')}`);
  } finally {
    watcher.close();
    restore();
  }
});

test('watch: a half-written line is not an event until its newline arrives', async () => {
  const { sbbDir, restore } = fixtureEnv();
  const { events, onEvent, waitFor } = collector();
  const watcher = watch(onEvent, { debounceMs: 10 });
  const log = join(sbbDir, 'log', 'receipts.jsonl');
  try {
    appendFileSync(log, '{"msgId":"half-written');
    await sleep(300);
    assert.equal(events.filter((e) => e.kind === 'receipt').length, 0, 'no event for an incomplete line');

    appendFileSync(log, '-end","status":"delivered"}\n');
    const receipt = await waitFor('receipt');
    assert.equal(receipt.msgId, 'half-written-end', 'the line is delivered once, whole');
  } finally {
    watcher.close();
    restore();
  }
});

test('watch: the 30 s re-snapshot is what emits quota and tps', async () => {
  const { restore } = fixtureEnv();
  let calls = 0;
  const { onEvent, waitFor } = collector();
  const watcher = watch(onEvent, {
    debounceMs: 5,
    resnapshotMs: 40,
    readQuota: async () => {
      calls += 1;
      return calls === 1 ? [] : [{ account: 'a', provider: 'claude', window: 'weekly', remaining: 42 }];
    },
  });
  try {
    const quota = await waitFor('quota');
    assert.equal(quota[0].remaining, 42);
    assert.ok(calls >= 2, 'the re-snapshot re-reads, it does not cache forever');
  } finally {
    watcher.close();
    restore();
  }
});

test('watch: close stops the events and the timers', async () => {
  const { sbbDir, restore } = fixtureEnv();
  const { events, onEvent, waitFor } = collector();
  // resnapshotMs is the documented fallback for a change that lands before the macOS
  // FSEvents stream is hot. With the 30 s default this test races the watcher's arming:
  // run 12 of the M3 acceptance hit exactly that and timed out at 4 s.
  const watcher = watch(onEvent, { debounceMs: 5, resnapshotMs: 200 });
  try {
    appendReceipt({ msgId: 'aaaa4444-0000-4000-8000-000000000004', status: 'delivered', via: 'uds' });
    // Wait for the event itself instead of a fixed sleep: under a loaded parallel test
    // run 150 ms is not a guarantee that the OS watcher has fired yet.
    await waitFor('receipt');
    const before = events.length;
    watcher.close();
    appendReceipt({ msgId: 'aaaa5555-0000-4000-8000-000000000005', status: 'delivered', via: 'uds' });
    await sleep(150);
    assert.equal(events.length, before, 'nothing is emitted after close()');
    assert.ok(events.length > 0, 'and events did flow before it');
  } finally {
    restore();
  }
});

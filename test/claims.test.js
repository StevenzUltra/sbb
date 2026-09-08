// Claims: resource parsing, conflict rules, the CLI path (record + conflict exit 3 +
// notification) and the `sbb ls --claims` marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run as claimRun } from '../src/cli/claim.js';
import { run as lsRun } from '../src/cli/ls.js';
import {
  ClaimError,
  addClaim,
  conflicts,
  conflictedBrainIds,
  detectConflicts,
  listAllClaims,
  normalizeResource,
  parseResource,
  readClaims,
  releaseClaim,
  releaseClaims,
} from '../src/policy/claims.js';
import { listBrains } from '../src/registry/brains.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

function sbbEnv(home, extra = {}) {
  return { SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb'), TMUX_PANE: undefined, ...extra };
}

/** @param {{brainId: string, brain: string, parent?: string|null, role?: string}} over */
function callerRow(over) {
  return {
    brain: over.brain, brainId: over.brainId, role: over.role ?? 'sub', parent: over.parent ?? null,
    account: 'a', cli: 'claude', model: null, status: 'idle', name: over.brain, cwd: '/tmp/proj',
    paneId: '%73', coord: '24:3.7', pid: 4321, source: 'pane', where: '24:3.7',
  };
}

test('claim resources: parse, normalize and conflict rules', () => {
  assert.deepEqual(parseResource('branch:feat/x'), { kind: 'branch', value: 'feat/x' });
  assert.deepEqual(parseResource(' PORT: 3000 '), { kind: 'port', value: '3000' });
  assert.throws(() => parseResource('branch'), ClaimError);
  assert.throws(() => parseResource('repo:main'), /unknown resource kind/);
  assert.throws(() => parseResource('path:'), /empty value/);

  assert.equal(normalizeResource('port:03000'), 'port:3000');
  assert.equal(normalizeResource('path:/a/b/'), 'path:/a/b');

  assert.equal(conflicts('branch:feat/x', 'branch:feat/x'), true);
  assert.equal(conflicts('branch:feat/x', 'branch:feat/y'), false);
  assert.equal(conflicts('branch:feat/x', 'port:feat/x'), false, 'different kinds never conflict');
  assert.equal(conflicts('port:3000', 'port:3000'), true);
  assert.equal(conflicts('port:3000', 'port:3001'), false);
  assert.equal(conflicts('path:/a/b', 'path:/a/b/c'), true, 'containment');
  assert.equal(conflicts('path:/a/b/c', 'path:/a/b'), true, 'containment either way');
  assert.equal(conflicts('path:/a/bc', 'path:/a/b'), false, 'prefix must fall on a separator');
  assert.equal(conflicts('worktree:/w/one', 'worktree:/w/one/two'), true);
  assert.equal(conflicts('device:UDID-1', 'device:UDID-1'), true);
});

test('claim store: add is idempotent, release and release-all drop the file', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null });
    const first = addClaim('TST-0001', 'branch:feat/x', { note: 'working on it', now: 1000 });
    assert.equal(first.added, true);
    assert.deepEqual(first.claim, { resource: 'branch:feat/x', at: 1000, note: 'working on it' });
    const again = addClaim('TST-0001', 'branch:feat/x');
    assert.equal(again.added, false);
    assert.equal(readClaims('TST-0001').claims.length, 1);

    addClaim('TST-0001', 'port:3000');
    assert.equal(readClaims('TST-0001').claims.length, 2);
    assert.equal(releaseClaim('TST-0001', 'port:3000').released, true);
    assert.equal(readClaims('TST-0001').claims.length, 1);
    assert.equal(releaseClaims('TST-0001').released, 1);
    assert.deepEqual(readClaims('TST-0001').claims, []);
    assert.equal(listAllClaims().length, 0);
  } finally {
    restore();
  }
});

test('detectConflicts and conflictedBrainIds span live brains', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null });
    writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null });
    writeBrain({ id: 'TST-0003', name: 'sub-a', role: 'sub', parent: 'TST-0001' });
    addClaim('TST-0001', 'path:/Users/dev/proj');
    addClaim('TST-0003', 'path:/Users/dev/proj/apps/fe');
    addClaim('TST-0003', 'branch:feat/y');
    addClaim('TST-0002', 'branch:feat/y');

    const hit = detectConflicts('TST-0003', { brains: listBrains() });
    assert.deepEqual(hit.map((h) => [h.brain, h.name, h.resource]).sort(), [
      ['TST-0001', 'lead-a', 'path:/Users/dev/proj/apps/fe'],
      ['TST-0002', 'lead-b', 'branch:feat/y'],
    ]);
    assert.deepEqual([...conflictedBrainIds()].sort(), ['TST-0001', 'TST-0002', 'TST-0003']);
    assert.deepEqual(detectConflicts('TST-0002', { brains: listBrains() }), [
      { brain: 'TST-0003', name: 'sub-a', resource: 'branch:feat/y' },
    ]);
  } finally {
    restore();
  }
});

test('claim add with a conflict records the claim, exits 3 and notifies each side main', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null });
    writeBrain({ id: 'TST-0003', name: 'sub-a', role: 'sub', parent: 'TST-0001' });
    writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null });
    writeBrain({ id: 'TST-0005', name: 'sub-b', role: 'sub', parent: 'TST-0002' });
    addClaim('TST-0005', 'branch:feat/z');

    const frames = [];
    const deps = {
      paneId: '%73',
      rows: [callerRow({ brainId: 'TST-0003', brain: 'sub-a', parent: 'TST-0001' })],
      sbbDir: join(home, '.sbb'),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
    };
    const { lines, result } = await captureLog(() => claimRun(['add', 'branch:feat/z'], deps));
    assert.equal(result, 3);
    assert.ok(lines.includes('conflict with sub-b#TST-0005 (branch:feat/z)'), `lines: ${lines.join(' | ')}`);
    assert.deepEqual(readClaims('TST-0003').claims.map((c) => c.resource), ['branch:feat/z'], 'the claim is kept');

    assert.equal(frames.length, 2, 'each side main, not the subs');
    assert.deepEqual(frames.map((f) => f.target.brainId).sort(), ['TST-0001', 'TST-0002']);
    assert.match(frames[0].message.text, /claim conflict: sub-a#TST-0003 holds branch:feat\/z/);
    assert.match(frames[0].message.text, /sub-b#TST-0005/);

    const clean = await captureLog(() => claimRun(['add', 'port:8080'], { ...deps, send: async () => { throw new Error('must not notify'); } }));
    assert.equal(clean.result, 0);
    assert.ok(clean.lines.includes('claimed     port:8080  by sub-a#TST-0003'));

    const released = await captureLog(() => claimRun(['release', '--all'], deps));
    assert.equal(released.result, 0);
    assert.deepEqual(readClaims('TST-0003').claims, []);
  } finally {
    restore();
  }
});

test('claim add between two mains notifies both mains', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null });
    writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null });
    addClaim('TST-0002', 'device:UDID-1');

    const frames = [];
    const deps = {
      paneId: '%73',
      rows: [callerRow({ brainId: 'TST-0001', brain: 'lead-a', role: 'main' })],
      sbbDir: join(home, '.sbb'),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
    };
    const { result } = await captureLog(() => claimRun(['add', 'device:UDID-1'], deps));
    assert.equal(result, 3);
    assert.deepEqual(frames.map((f) => f.target.brainId), ['TST-0002'], 'the other main only');
  } finally {
    restore();
  }
});

test('claim add outside a registered brain pane is a usage error', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const { result } = await captureLog(() => claimRun(['add', 'branch:x'], { paneId: undefined, rows: [], sbbDir: join(home, '.sbb') }));
    assert.equal(result, 2);
  } finally {
    restore();
  }
});

test('claim ls and sbb ls --claims mark conflicted brains', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null });
    writeBrain({ id: 'TST-0003', name: 'sub-a', role: 'sub', parent: 'TST-0001' });
    addClaim('TST-0001', 'branch:feat/x');
    addClaim('TST-0003', 'branch:feat/x');
    const sbbDir = join(home, '.sbb');

    const listed = await captureLog(() => claimRun(['ls'], { sbbDir }));
    assert.equal(listed.result, 0);
    const listedText = listed.lines.join('\n');
    assert.match(listedText, /^!TST-0001\s+branch:feat\/x/m, listedText);
    assert.match(listedText, /^!TST-0003\s+branch:feat\/x/m, listedText);

    const rows = [
      { brain: 'lead-a', brainId: 'TST-0001', role: 'main', parent: null, account: 'a', cli: 'claude', model: null, status: 'idle', name: 'lead-a', cwd: '/tmp', paneId: '%30', coord: '24:3.4', where: '24:3.4' },
      { brain: 'sub-a', brainId: 'TST-0003', role: 'sub', parent: 'TST-0001', account: 'a', cli: 'claude', model: null, status: 'idle', name: 'sub-a', cwd: '/tmp', paneId: '%73', coord: '24:3.7', where: '24:3.7' },
    ];
    const plain = await captureLog(() => lsRun([], { sbbDir, roster: async () => rows }));
    assert.ok(!plain.lines.join('\n').includes('!TST-'), 'no marker without --claims');
    const marked = await captureLog(() => lsRun(['--claims'], { sbbDir, roster: async () => rows }));
    const markedText = marked.lines.join('\n');
    assert.match(markedText, /!TST-0001/, markedText);
    assert.match(markedText, /!TST-0003/, markedText);
  } finally {
    restore();
  }
});

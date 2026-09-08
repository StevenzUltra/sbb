// kill.js: subtree planning, graceful exit, retirement, claims and notification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimsPath,
  gracefulExit,
  killBrains,
  killPlan,
  releaseClaims,
  reparentChild,
} from '../src/lifecycle/kill.js';
import { createFakeTmux, screen, tmuxCommands, typedLiterals } from './fixtures/lifecycle/fake-tmux.js';
import { listBrains } from '../src/registry/brains.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

/** The live brains on disk (SBB_DIR must already be set). */
function listAll() {
  return listBrains();
}

const BRAINS = [
  { id: 'SMS-0007', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude' },
  { id: 'SMS-0012', name: 'ios', role: 'sub', parent: 'SMS-0007', account: 'a', cli: 'claude' },
  { id: 'SMS-0013', name: 'ops', role: 'sub', parent: 'SMS-0012', account: 'a', cli: 'codex' },
  { id: 'SMS-0014', name: 'api', role: 'sub', parent: 'SMS-0007', account: 'a', cli: 'claude' },
];

test('killPlan: the whole subtree, children before their parent', () => {
  const plan = killPlan('ios', { brains: BRAINS, getBrainFn: () => BRAINS[1] });
  assert.deepEqual(plan.victims.map((b) => b.id), ['SMS-0013', 'SMS-0012']);
  assert.deepEqual(plan.keep, []);
});

test('killPlan: --keep-children leaves the direct children out of the kill list', () => {
  const plan = killPlan('ios', { keepChildren: true, brains: BRAINS, getBrainFn: () => BRAINS[1] });
  assert.deepEqual(plan.victims.map((b) => b.id), ['SMS-0012']);
  assert.deepEqual(plan.keep.map((b) => b.id), ['SMS-0013']);
});

test('killPlan: an unknown ref is undefined, never a guess', () => {
  assert.equal(killPlan('nope', { brains: BRAINS, getBrainFn: () => undefined }), undefined);
});

test('reparentChild: a sub child moves to the killed brain parent', () => {
  const saved = [];
  reparentChild(BRAINS[2], BRAINS[1], { saveBrainFn: (record) => saved.push(record) });
  assert.equal(saved[0].parent, 'SMS-0007');
  assert.equal(saved[0].role, 'sub');
});

test('reparentChild: a main brain with no parent makes its children main', () => {
  const saved = [];
  reparentChild(BRAINS[1], BRAINS[0], { saveBrainFn: (record) => saved.push(record) });
  assert.deepEqual({ parent: saved[0].parent, role: saved[0].role }, { parent: null, role: 'main' });
});

test('gracefulExit: an idle claude pane gets /exit and the pane disappears', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('claude-idle')], exitAfterEnter: true });
  const result = await gracefulExit(BRAINS[1], { tmuxApi, sleep: async () => {}, waitMs: 5, pollMs: 1 });
  assert.deepEqual(typedLiterals(tmuxApi), ['/exit']);
  assert.equal(result.typed, true);
  assert.equal(result.killed, false);
  assert.match(result.detail, /exited after \/exit/);
  assert.ok(!tmuxCommands(tmuxApi).some((c) => c[0] === 'kill-pane'));
});

test('gracefulExit: a busy pane is never typed into, it is killed', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('codex-busy')] });
  const result = await gracefulExit(BRAINS[2], { tmuxApi, sleep: async () => {} });
  assert.deepEqual(typedLiterals(tmuxApi), []);
  assert.ok(tmuxCommands(tmuxApi).some((c) => c[0] === 'kill-pane'));
  assert.equal(result.killed, true);
  assert.match(result.detail, /not idle/);
});

test('gracefulExit: --force skips the typed exit even on an idle pane', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('claude-idle')] });
  const result = await gracefulExit(BRAINS[1], { tmuxApi, force: true, sleep: async () => {} });
  assert.deepEqual(typedLiterals(tmuxApi), []);
  assert.ok(tmuxCommands(tmuxApi).some((c) => c[0] === 'kill-pane'));
  assert.equal(result.detail, 'forced kill-pane');
});

test('gracefulExit: an idle pane that does not exit is killed after the wait', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('claude-idle')] });
  const result = await gracefulExit(BRAINS[1], { tmuxApi, sleep: async () => {}, waitMs: 5, pollMs: 1 });
  assert.deepEqual(typedLiterals(tmuxApi), ['/exit']);
  assert.equal(result.killed, true);
  assert.match(result.detail, /alive 5ms after \/exit; kill-pane/);
});

test('gracefulExit: a pane that swallows the first Enter is exited by the retry', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('codex-idle')], exitAfterEnters: 2 });
  const result = await gracefulExit(BRAINS[2], {
    tmuxApi,
    sleep: async () => {},
    waitMs: 30,
    pollMs: 1,
    enterRetryMs: 0,
  });
  assert.deepEqual(typedLiterals(tmuxApi), ['/quit']);
  assert.equal(result.typed, true);
  assert.equal(result.killed, false);
  assert.match(result.detail, /exited after \/quit \(second Enter\)/);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'send-key').length, 2);
});

test('gracefulExit: a gone pane is reported, not typed into', async () => {
  const tmuxApi = createFakeTmux({ panes: [] });
  const result = await gracefulExit(BRAINS[1], { tmuxApi, sleep: async () => {} });
  assert.deepEqual({ paneId: result.paneId, typed: result.typed, killed: result.killed }, { paneId: null, typed: false, killed: false });
  assert.equal(result.detail, 'pane already gone');
});

test('gracefulExit: a cli without an exit command is killed directly', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('claude-idle')] });
  const result = await gracefulExit({ ...BRAINS[1], cli: 'other' }, { tmuxApi, sleep: async () => {} });
  assert.deepEqual(typedLiterals(tmuxApi), []);
  assert.match(result.detail, /no exit command for cli other/);
});

test('killBrains: retires the record, releases claims and notifies the parent', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const parent = writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', paneId: '%29' });
    const child = writeBrain({ id: 'SMS-0012', name: 'ios', role: 'sub', parent: parent.id, paneId: '%30' });
    const claims = claimsPath(child.id);
    mkdirSync(join(dir, 'claims'), { recursive: true });
    writeFileSync(claims, '{"id":"SMS-0012","claims":[]}\n');

    const delivered = [];
    // The notification must go out through the normal delivery path, i.e. with an inbox,
    // so the envelope carries fromSock (2026-09-09: without it the transport reported
    // `content not wrapped: no receivable fromSock`).
    let inboxClosed = false;
    const inbox = { sockPath: '/tmp/cc-socks/999.sock', close: async () => { inboxClosed = true; } };
    const plan = killPlan('ios', { brains: [parent, child], getBrainFn: () => child });
    const outcome = await killBrains(plan, {
      tmuxApi: createFakeTmux({ screens: [screen('claude-idle')], exitAfterEnter: true }),
      sleep: async () => {},
      waitMs: 5,
      pollMs: 1,
      resolve: async () => ({ address: 'lead', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' }),
      openInbox: async () => inbox,
      deliver: async (input) => {
        delivered.push(input);
        return { receipt: { status: 'delivered', via: 'uds', msgId: 'm2', elapsedMs: 1 } };
      },
    });

    assert.equal(existsSync(join(dir, 'brains', 'SMS-0012.json')), false, 'live record moved away');
    const retired = JSON.parse(readFileSync(join(dir, 'brains', '_retired', 'SMS-0012.json'), 'utf8'));
    assert.ok(retired.retiredAt > 0);
    assert.equal(outcome.results[0].claims, 'released');
    assert.equal(existsSync(claims), false);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].body, '已下线');
    assert.equal(delivered[0].identity.id, 'SMS-0012');
    assert.equal(delivered[0].inbox, inbox, 'deliver gets the inbox, so fromSock is set');
    assert.equal(inboxClosed, true, 'the inbox does not outlive the kill');
    assert.equal(outcome.notification.status, 'delivered');
  } finally {
    restore();
  }
});

test('killBrains: an unresolvable parent is reported and opens no inbox', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const parent = writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', paneId: '%29' });
    const child = writeBrain({ id: 'SMS-0012', name: 'ios', role: 'sub', parent: parent.id, paneId: '%30' });
    let opened = 0;
    const plan = killPlan('ios', { brains: [parent, child], getBrainFn: () => child });
    const outcome = await killBrains(plan, {
      tmuxApi: createFakeTmux({ screens: [screen('claude-idle')], exitAfterEnter: true }),
      sleep: async () => {},
      waitMs: 5,
      pollMs: 1,
      resolve: async () => { throw new Error('unknown account "zz"'); },
      openInbox: async () => { opened += 1; return undefined; },
      deliver: async () => { throw new Error('must not be called'); },
    });
    assert.equal(opened, 0);
    assert.equal(outcome.notification.status, 'blocked');
    assert.equal(outcome.notification.reason, 'target_not_found');
    assert.match(outcome.notification.detail, /unknown account "zz"/);
  } finally {
    restore();
  }
});

test('killBrains: --keep-children re-parents the survivors to the killed parent', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const lead = writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', paneId: '%29' });
    const ios = writeBrain({ id: 'SMS-0012', name: 'ios', role: 'sub', parent: lead.id, paneId: '%30' });
    writeBrain({ id: 'SMS-0013', name: 'ops', role: 'sub', parent: ios.id, paneId: '%31', cli: 'codex' });

    const plan = killPlan('ios', { keepChildren: true, brains: [lead, ios, ...[]], getBrainFn: () => ios });
    // killPlan needs the full registry to find the child.
    const full = killPlan('ios', { keepChildren: true, brains: listAll(dir), getBrainFn: () => ios });
    assert.deepEqual(full.keep.map((b) => b.id), ['SMS-0013']);

    const outcome = await killBrains(full, {
      tmuxApi: createFakeTmux({ screens: [screen('claude-idle')], exitAfterEnter: true }),
      sleep: async () => {},
      waitMs: 5,
      pollMs: 1,
      resolve: async () => ({ address: 'lead', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' }),
      deliver: async () => ({ receipt: { status: 'queued', via: 'uds', elapsedMs: 1 } }),
    });
    assert.deepEqual(outcome.reparented, [{ id: 'SMS-0013', name: 'ops', parent: 'SMS-0007', role: 'sub' }]);
    const ops = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0013.json'), 'utf8'));
    assert.equal(ops.parent, 'SMS-0007');
    assert.equal(plan.keep.length, 0, 'the narrow plan really was narrow');
  } finally {
    restore();
  }
});

test('releaseClaims: a brain without a claims file reports none', () => {
  const dir = tempDir();
  assert.equal(releaseClaims('SMS-9999', { dir }), 'none');
});

// Policy: config file, the who-may-talk-to-whom table, quota floors, and the delivery gate
// (blocked / moderated / held / approve) exercised through the real CLI entry points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run as tellRun } from '../src/cli/tell.js';
import { run as approveRun } from '../src/cli/approve.js';
import { run as heldRun } from '../src/cli/held.js';
import { run as policyRun } from '../src/cli/policy.js';
import { deliver } from '../src/cli/util.js';
import { DEFAULT_QUOTA, mergeConfig, readConfig, writeConfig } from '../src/policy/config.js';
import { check, teamOf } from '../src/policy/rules.js';
import { checkMainReserve, checkQuotaFloor, weeklyRemaining } from '../src/policy/quota.js';
import { listHeld } from '../src/policy/held.js';
import { killBrains, killPlan } from '../src/lifecycle/kill.js';
import { getBrain, removeBrain, saveBrain } from '../src/registry/brains.js';
import { readReceiptEntries } from '../src/registry/receipts.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const SENDER_ROW = {
  brain: 'lead-a', brainId: 'TST-0001', role: 'main', parent: null, account: 'a', cli: 'claude',
  model: null, status: 'idle', name: 'lead-a', cwd: '/tmp/proj', paneId: '%73', coord: '24:3.7',
  pid: 4321, source: 'pane', where: '24:3.7',
};

const TARGET_B = {
  address: 'lead-b', brain: 'lead-b', brainId: 'TST-0002', account: 'b', cli: 'claude',
  paneId: '%30', coord: '24:3.4', claude: { sock: '/tmp/cc-socks/4242.sock' }, codex: undefined,
};

const TARGET_A = {
  address: 'lead-a', brain: 'lead-a', brainId: 'TST-0001', account: 'a', cli: 'claude',
  paneId: '%73', coord: '24:3.7', claude: { sock: '/tmp/cc-socks/4321.sock' }, codex: undefined,
};

function sbbEnv(home, extra = {}) {
  return {
    SBB_HOME_OVERRIDE: home,
    SBB_DIR: join(home, '.sbb'),
    TMUX_PANE: undefined,
    SBB_FROM_MODE: undefined,
    SBB_FORCE: undefined,
    ...extra,
  };
}

function fakeInbox(sockPath = '/tmp/cc-socks/9999.sock') {
  return { sockPath, closes: 0, on() {}, off() {}, async close() { this.closes += 1; } };
}

/** Two main brains on different accounts, no relationship. */
function twoMains() {
  writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'a' });
  writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null, account: 'b' });
}

/** deps that keep the tell path entirely in memory. */
function tellDeps(home, over = {}) {
  return {
    paneId: '%73',
    rows: [SENDER_ROW],
    resolve: async (address) => (address === 'lead-a' ? TARGET_A : TARGET_B),
    send: async () => ({ status: 'delivered', via: 'uds', msgId: 'deadbeef', elapsedMs: 1 }),
    startInbox: async () => fakeInbox(),
    closeInboxes: async () => {},
    sbbDir: join(home, '.sbb'),
    ...over,
  };
}

test('policy config: defaults, merge drops invalid values, write is atomic 0600', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const base = readConfig();
    assert.match(base.machineTag, /^[A-Z0-9]+$/);
    assert.equal(base.peers, 'on');
    assert.deepEqual(base.brains, {});
    assert.deepEqual(base.allow, []);
    assert.deepEqual(base.quota, { ...DEFAULT_QUOTA });
    assert.deepEqual(base.teams, { subsDirect: true });

    const merged = mergeConfig({
      machineTag: '  X1 ',
      peers: 'bogus',
      brains: { 'tst-0001': { peers: 'off', autonomous: 'yes' }, bad: 3 },
      teams: { subsDirect: false },
      allow: [['a', 'b'], ['c'], ['d', 5], ['', 'e']],
      quota: { floorWeekly: 150, mainReserve: 5 },
    });
    assert.equal(merged.machineTag, 'X1');
    assert.equal(merged.peers, 'on');
    assert.deepEqual(merged.brains, { 'TST-0001': { peers: 'off' } });
    assert.deepEqual(merged.teams, { subsDirect: false });
    assert.deepEqual(merged.allow, [['a', 'b']]);
    assert.deepEqual(mergeConfig({ teams: { subsDirect: 'no' } }).teams, { subsDirect: true }, 'only a literal false switches it off');
    assert.deepEqual(merged.quota, { floorWeekly: DEFAULT_QUOTA.floorWeekly, mainReserve: 5 });

    writeConfig(merged);
    assert.equal(statSync(join(home, '.sbb', 'config.json')).mode & 0o777, 0o600);
    assert.deepEqual(readConfig(), merged);
  } finally {
    restore();
  }
});

test('policy rules: every row of the table, allow, autonomous and peers:off', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const mainA = writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'a' });
    const mainB = writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null, account: 'b' });
    const subA = writeBrain({ id: 'TST-0003', name: 'sub-a', role: 'sub', parent: 'TST-0001', account: 'a' });
    const subA2 = writeBrain({ id: 'TST-0004', name: 'sub-a2', role: 'sub', parent: 'TST-0001', account: 'b' });
    const subB = writeBrain({ id: 'TST-0005', name: 'sub-b', role: 'sub', parent: 'TST-0002', account: 'b' });
    const grand = writeBrain({ id: 'TST-0006', name: 'grand-a', role: 'sub', parent: 'TST-0003', account: 'a' });
    const cfg = (over) => mergeConfig(over ?? {});
    const v = (sender, target, config) => check(sender, target, config, { getBrain });

    assert.deepEqual(v(null, mainA, cfg()), { ok: true }, 'user -> any brain');
    assert.deepEqual(v(subA, null, cfg()), { ok: true }, 'unregistered target');
    assert.deepEqual(v(mainA, mainA, cfg({ peers: 'off' })), { ok: true }, 'self');

    assert.deepEqual(v(mainA, subA, cfg({ peers: 'off' })), { ok: true }, 'parent -> direct child');
    assert.deepEqual(v(subA, mainA, cfg({ brains: { 'TST-0001': { peers: 'off' } } })), { ok: true }, 'child -> parent');
    assert.deepEqual(v(subA, grand, cfg({ peers: 'off' })), { ok: true }, 'child -> grandchild');

    assert.deepEqual(v(mainA, mainB, cfg()), { ok: true }, 'main <-> main, peers on');
    assert.deepEqual(v(mainA, mainB, cfg({ peers: 'off' })), { ok: false, reason: 'policy', detail: 'peers_off' });
    assert.deepEqual(v(mainA, mainB, cfg({ peers: 'moderated' })), { ok: false, moderated: true, reason: 'policy', detail: 'peers_moderated' });
    assert.deepEqual(v(mainA, mainB, cfg({ brains: { 'TST-0002': { peers: 'off' } } })), { ok: false, reason: 'policy', detail: 'peers_off' }, 'per-brain peers off');
    // M3 talk table (docs/spec/teams.md): same-team sub <-> sub is on by default.
    assert.equal(teamOf('TST-0001', getBrain), 'TST-0001', 'a main is its own team');
    assert.equal(teamOf('TST-0003', getBrain), 'TST-0001', 'a sub belongs to its root main');
    assert.equal(teamOf('TST-0006', getBrain), 'TST-0001', 'a grandchild belongs to the same team');
    assert.equal(teamOf('TST-0005', getBrain), 'TST-0002', 'another team');
    assert.equal(teamOf('TST-9999', getBrain), null, 'unknown brain, no team');
    assert.deepEqual(v(subA, subA2, cfg()), { ok: true }, 'same-team sub <-> sub, subsDirect on by default');
    assert.deepEqual(v(subA2, subA, cfg()), { ok: true }, 'same-team sub <-> sub, either direction');
    assert.deepEqual(v(grand, subA2, cfg()), { ok: true }, 'a grandchild is in the same team');
    assert.deepEqual(v(subA, subA2, cfg({ teams: { subsDirect: false } })), { ok: false, reason: 'policy', detail: 'same_team_via_parent' }, 'subsDirect false restores via-parent');
    assert.deepEqual(v(subA, subA2, cfg({ teams: { subsDirect: false }, brains: { 'TST-0001': { autonomous: true } } })), { ok: true }, 'autonomous root main');
    assert.deepEqual(v(subA, subB, cfg()), { ok: false, reason: 'policy', detail: 'cross_team' }, 'different teams');
    assert.deepEqual(v(grand, subB, cfg()), { ok: false, reason: 'policy', detail: 'cross_team' }, 'nested sub vs other team');
    assert.deepEqual(v(subA, mainB, cfg()), { ok: false, reason: 'policy', detail: 'cross_team' }, 'sub -> another team main');
    assert.deepEqual(v(mainB, subA, cfg()), { ok: false, reason: 'policy', detail: 'cross_team' }, 'another team main -> sub');
    assert.deepEqual(v(subA, mainA, cfg()), { ok: true }, 'sub -> its own main, the escalation path');
    assert.deepEqual(v(mainA, grand, cfg()), { ok: true }, 'main -> a grandchild in its own team');
    assert.deepEqual(v(subA, mainB, cfg({ allow: [['sub-a', 'lead-b']] })), { ok: true }, 'allow beats cross-team');

    const allow = cfg({ allow: [['sub-a', 'sub-b']] });
    assert.deepEqual(v(subA, subB, allow), { ok: true }, 'allow by name');
    assert.deepEqual(v(subB, subA, allow), { ok: true }, 'allow either order');
    assert.deepEqual(v(mainA, mainB, cfg({ peers: 'off', allow: [['TST-0001', 'TST-0002']] })), { ok: true }, 'allow by id beats peers off');
    assert.deepEqual(v(subA, subA2, cfg({ allow: [['sub-a2', 'sub-a']] })), { ok: true }, 'allow beats same-team rule');
  } finally {
    restore();
  }
});

test('quota floors: floorWeekly, mainReserve, unknown readings never block', () => {
  const rows = [
    { account: 'a', window: 'weekly', remaining: 4 },
    { account: 'b', window: 'weekly', remaining: 42 },
    { account: 'c', window: 'weekly', remaining: null },
  ];
  const config = mergeConfig({ quota: { floorWeekly: 10, mainReserve: 20 } });
  assert.equal(weeklyRemaining(rows, 'a'), 4);
  assert.equal(weeklyRemaining(rows, 'zz'), null);
  assert.deepEqual(checkQuotaFloor({ account: 'a', config, rows }), {
    ok: false, reason: 'quota', detail: 'account a weekly remaining 4% < floor 10%',
  });
  assert.deepEqual(checkQuotaFloor({ account: 'b', config, rows }), { ok: true, remaining: 42 });
  assert.deepEqual(checkQuotaFloor({ account: 'c', config, rows }), { ok: true, remaining: null });
  assert.deepEqual(checkQuotaFloor({ account: 'zz', config, rows }), { ok: true, remaining: null });

  const brains = [{ id: 'TST-0001', name: 'lead-a', role: 'main', account: 'b' }];
  const reserve = mergeConfig({ quota: { floorWeekly: 10, mainReserve: 50 } });
  assert.deepEqual(checkMainReserve({ account: 'b', config: reserve, rows, brains }), {
    ok: false, reason: 'quota', detail: 'account b weekly remaining 42% < mainReserve 50% (hosts main brain lead-a#TST-0001)',
  });
  assert.deepEqual(checkMainReserve({ account: 'a', config: reserve, rows, brains }), { ok: true }, 'no main on a');
});

test('tell is blocked by policy: canonical line, exit 4, receipt logged, nothing sent', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'off' }));
    let sent = 0;
    const deps = tellDeps(home, { send: async () => { sent += 1; return { status: 'delivered', via: 'uds', msgId: 'x', elapsedMs: 1 }; } });
    const { lines, result } = await captureLog(() => tellRun(['lead-b', 'hello'], deps));
    assert.equal(result, 4);
    assert.equal(sent, 0, 'a blocked message is never handed to a transport');
    const line = lines.find((l) => l.startsWith('blocked'));
    assert.match(line, /^blocked\s+msg=[0-9a-f]{8}\s+via=policy\s+reason=policy\s+detail=peers_off; 请向上级或用户上报$/);

    const entry = readReceiptEntries().at(-1);
    assert.equal(entry.status, 'blocked');
    assert.equal(entry.via, 'policy');
    assert.equal(entry.reason, 'policy');
    assert.equal(entry.detail, 'peers_off');
    assert.equal(entry.from, 'lead-a');
    assert.equal(entry.fromId, 'TST-0001');
    assert.equal(entry.to, 'lead-b');
    assert.match(entry.textPreview, /hello/);
  } finally {
    restore();
  }
});

test('moderated peers: message is held, listed, then approved through the normal path', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    let sent = 0;
    const { lines, result } = await captureLog(() => tellRun(['lead-b', 'hello there'], tellDeps(home, {
      send: async () => { sent += 1; return { status: 'delivered', via: 'uds', msgId: 'x', elapsedMs: 1 }; },
    })));
    assert.equal(result, 4);
    assert.equal(sent, 0);
    const line = lines.find((l) => l.startsWith('blocked'));
    const match = /^blocked\s+msg=([0-9a-f]{8})\s+via=policy\s+reason=moderated\s+detail=held for user approval: sbb approve ([0-9a-f]{8}); 请向上级或用户上报$/.exec(line);
    assert.ok(match, `unexpected line: ${line}`);

    const holds = listHeld({ sbbDir });
    assert.equal(holds.length, 1);
    assert.equal(holds[0].msgId.slice(0, 8), match[1]);
    assert.match(holds[0].message.text, /\[主脑\] hello there/);
    assert.equal(holds[0].sender.name, 'lead-a');
    assert.equal(holds[0].target.brainId, 'TST-0002');
    assert.equal(holds[0].reason, 'peers_moderated');

    const listed = await captureLog(() => heldRun([], { sbbDir }));
    assert.equal(listed.result, 0);
    assert.ok(listed.lines.some((l) => l.includes(match[1])), 'sbb held lists the message');

    const frames = [];
    const approveDeps = {
      paneId: null,
      rows: [],
      resolve: async (address) => (address === 'lead-a' ? TARGET_A : TARGET_B),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 3 };
      },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };
    const approved = await captureLog(() => approveRun([match[1]], approveDeps));
    assert.equal(approved.result, 0);
    assert.equal(frames.length, 2, 'the replay plus the sender notice');
    assert.equal(frames[0].message.msgId, holds[0].msgId, 'the held message is replayed verbatim');
    assert.match(frames[0].message.text, /hello there/);
    assert.equal(frames[0].target.brainId, 'TST-0002');
    assert.match(frames[1].message.text, /approved and sent/);
    assert.equal(frames[1].target.brainId, 'TST-0001', 'the notice goes back to the sender');
    assert.equal(listHeld({ sbbDir }).length, 0, 'the hold is deleted after delivery');

    const entry = readReceiptEntries().find((e) => e.held === 'released');
    assert.equal(entry.status, 'delivered');
    assert.equal(entry.approvedBy, 'user');
    assert.equal(entry.to, 'lead-b');
  } finally {
    restore();
  }
});

test('sbb approve --deny deletes the hold and tells the sender', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'nope'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    const frames = [];
    const deps = {
      paneId: null,
      rows: [],
      resolve: async (address) => (address === 'lead-a' ? TARGET_A : TARGET_B),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };
    const denied = await captureLog(() => approveRun(['--deny', '--reason', 'not now', id8], deps));
    assert.equal(denied.result, 0);
    assert.equal(listHeld({ sbbDir }).length, 0);
    assert.equal(frames.length, 1);
    assert.match(frames[0].message.text, /was denied by the user: not now/);
    assert.equal(frames[0].target.brainId, 'TST-0001');
  } finally {
    restore();
  }
});

test('quota floor gates tell, --force and a reply bypass it, unknown never blocks', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    const low = [{ account: 'b', window: 'weekly', remaining: 4 }];
    let sent = 0;
    const send = async (target, message) => {
      sent += 1;
      return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
    };

    const blocked = await captureLog(() => tellRun(['lead-b', 'hi'], tellDeps(home, { readQuota: async () => low, send })));
    assert.equal(blocked.result, 4);
    assert.equal(sent, 0);
    const line = blocked.lines.find((l) => l.startsWith('blocked'));
    assert.match(line, /reason=quota\s+detail=account b weekly remaining 4% < floor 10%; 请向上级或用户上报$/);
    const entry = readReceiptEntries().at(-1);
    assert.equal(entry.reason, 'quota');
    assert.equal(entry.via, 'policy');

    const unknown = await captureLog(() => tellRun(['lead-b', 'hi'], tellDeps(home, {
      readQuota: async () => [{ account: 'b', window: 'weekly', remaining: null }],
      send,
    })));
    assert.equal(unknown.result, 0);
    assert.equal(sent, 1, 'an unknown reading never blocks');

    const restoreForce = withEnv({ SBB_FORCE: '1' });
    const forced = await captureLog(() => tellRun(['lead-b', 'hi'], tellDeps(home, { readQuota: async () => low, send })));
    restoreForce();
    assert.equal(forced.result, 0);
    assert.equal(sent, 2);

    const config = readConfig();
    const reply = await deliver({
      target: TARGET_B,
      body: 'answer',
      replyTo: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      identity: { sender: 'lead-a', id: 'TST-0001', account: 'a', cli: 'claude', coord: '24:3.7', role: '主脑', brain: 'lead-a' },
      send: async (t, m) => ({ status: 'delivered', via: 'uds', msgId: m.msgId, elapsedMs: 1 }),
      deps: { readQuota: async () => low, readConfig: () => config },
    });
    assert.equal(reply.receipt.status, 'delivered', 'a reply is not new outbound work');
  } finally {
    restore();
  }
});

test('sbb policy set/allow/deny/quota edit the config file', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'a' });
    writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null, account: 'b' });

    assert.equal((await captureLog(() => policyRun(['set', 'lead-a', '--peers', 'off', '--autonomous', 'on']))).result, 0);
    assert.equal((await captureLog(() => policyRun(['set', 'TST-0002', '--peers', 'off']))).result, 0);
    assert.equal((await captureLog(() => policyRun(['allow', 'lead-a', 'lead-b']))).result, 0);
    assert.equal((await captureLog(() => policyRun(['quota', '--floor-weekly', '15', '--main-reserve', '30']))).result, 0);
    let config = readConfig();
    assert.deepEqual(config.brains['TST-0001'], { peers: 'off', autonomous: true });
    assert.deepEqual(config.brains['TST-0002'], { peers: 'off' });
    assert.deepEqual(config.allow, [['TST-0001', 'TST-0002']]);
    assert.deepEqual(config.quota, { floorWeekly: 15, mainReserve: 30 });

    assert.equal((await captureLog(() => policyRun(['set', 'lead-a', '--autonomous', 'off']))).result, 0);
    assert.equal((await captureLog(() => policyRun(['deny', 'lead-a', 'lead-b']))).result, 0);
    config = readConfig();
    assert.deepEqual(config.brains['TST-0001'], { peers: 'off' });
    assert.deepEqual(config.allow, []);

    const bad = await captureLog(() => policyRun(['set', 'lead-a', '--peers', 'maybe']));
    assert.equal(bad.result, 2);
    assert.ok(!existsSync(join(home, '.sbb', 'config.json.tmp')));
  } finally {
    restore();
  }
});

test('policy spawn-args writes, shows and removes per-CLI default flags', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    // A value that starts with `-` is the whole point: strict parseArgs would read it as
    // another option, so the subcommand takes its tail verbatim.
    assert.equal((await captureLog(() => policyRun(['spawn-args', 'claude', '--permission-mode bypassPermissions']))).result, 0);
    // Split over argv (as an unquoted shell word) joins back into one string.
    assert.equal((await captureLog(() => policyRun(['spawn-args', 'codex', '--sandbox', 'workspace-write']))).result, 0);
    assert.deepEqual(readConfig().spawn.cliArgs, {
      claude: '--permission-mode bypassPermissions',
      codex: '--sandbox workspace-write',
    });

    const shown = await captureLog(() => policyRun(['show']));
    assert.match(shown.lines.join('\n'), /^spawn\s+claude=--permission-mode bypassPermissions, codex=--sandbox workspace-write$/m);
    const json = await captureLog(() => policyRun(['show', '--json']));
    assert.equal(json.lines.join('').includes('"cliArgs"'), true);

    assert.equal((await captureLog(() => policyRun(['spawn-args', 'claude', '']))).result, 0);
    assert.deepEqual(readConfig().spawn.cliArgs, { codex: '--sandbox workspace-write' });
    const cleared = await captureLog(() => policyRun(['spawn-args', 'codex', '   ']));
    assert.equal(cleared.result, 0);
    assert.deepEqual(readConfig().spawn.cliArgs, {}, 'blank removes the entry');

    assert.equal((await captureLog(() => policyRun(['spawn-args', 'nope', '--x']))).result, 2);
    assert.equal((await captureLog(() => policyRun(['spawn-args']))).result, 2);
  } finally {
    restore();
  }
});

test('mergeConfig drops blank or non-string spawn.cliArgs', () => {
  assert.deepEqual(mergeConfig({ spawn: { cliArgs: { claude: '  --a b  ', codex: '', agy: 7 } } }).spawn.cliArgs, { claude: '--a b' });
  assert.deepEqual(mergeConfig({}).spawn.cliArgs, {});
});

test('retiring a brain expires its holds and sbb held hides them until --all', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    let sent = 0;
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello there'], tellDeps(home, {
      send: async () => { sent += 1; return { status: 'delivered', via: 'uds', msgId: 'x', elapsedMs: 1 }; },
    })));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];
    assert.equal(listHeld({ sbbDir })[0].expiredAt, undefined, 'pending while the target lives');

    const outcome = await killBrains(killPlan('TST-0002'), {
      force: true,
      tmuxApi: { resolvePaneId: async () => '%30', tmux: async () => {} },
      sleep: async () => {},
    });
    assert.equal(outcome.results[0].expiredHolds, 1);
    assert.equal(outcome.notification, undefined, 'a main brain has no parent to notify');

    const [hold] = listHeld({ sbbDir });
    assert.ok(hold.expiredAt > 0);
    assert.match(hold.expiredReason, /brain TST-0002 retired/);
    assert.equal(sent, 0, 'expiry notifies nobody');

    const hidden = await captureLog(() => heldRun([], { sbbDir }));
    assert.equal(hidden.result, 0);
    assert.ok(!hidden.lines.some((l) => l.includes(id8)), 'a dead-ended hold is hidden by default');
    assert.match(hidden.lines.join('\n'), /sbb held --all shows expired ones/);

    const shown = await captureLog(() => heldRun(['--all'], { sbbDir }));
    assert.ok(shown.lines.some((l) => l.includes(id8)), '--all shows the expired hold');
    assert.match(shown.lines.join('\n'), /expired/);
  } finally {
    restore();
  }
});

test('sbb held hides a hold whose target record has no pane, without expiring it', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello there'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    // The record stays, its pane is gone: the shape a stale record takes.
    saveBrain({ ...getBrain('TST-0002'), paneId: null });

    const hidden = await captureLog(() => heldRun([], { sbbDir }));
    assert.ok(!hidden.lines.some((l) => l.includes(id8)), 'no pane means no delivery path');
    const shown = await captureLog(() => heldRun(['--all'], { sbbDir }));
    assert.ok(shown.lines.some((l) => l.includes(id8)));
    assert.equal(listHeld({ sbbDir })[0].expiredAt, undefined, 'hidden is not expired');
  } finally {
    restore();
  }
});

test('sbb approve resolves the hold brainId and refuses a same-named replacement', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello there'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    // The recorded target is retired and a replacement takes its name with a new id.
    removeBrain('TST-0002');
    writeBrain({ id: 'TST-0009', uuid: 'uuid-lead-b-2', name: 'lead-b', role: 'main', parent: null, account: 'b', paneId: '%31', coord: '24:3.5' });

    const asked = [];
    const frames = [];
    const deps = {
      paneId: null,
      rows: [],
      resolve: async (address) => {
        asked.push(address);
        if (address === 'lead-b') return { ...TARGET_B, brainId: 'TST-0009', paneId: '%31' };
        throw Object.assign(new Error(`unknown brain id "${address}"`), { reason: 'target_not_found' });
      },
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };
    const blocked = await captureLog(() => approveRun([id8], deps));
    assert.equal(blocked.result, 4);
    assert.deepEqual(asked, ['TST-0002'], 'the recorded brainId is resolved, never the name');
    assert.equal(frames.length, 0, 'nothing is delivered to the replacement brain');
    assert.match(blocked.lines.join('\n'), /blocked\s+msg=[0-9a-f]{8}\s+via=approve\s+reason=target_not_found/);
    assert.equal(listHeld({ sbbDir }).length, 1, 'the hold is kept for the user to deny');
  } finally {
    restore();
  }
});

test('sbb approve refuses a resolver that hands back a different brain', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello there'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    const frames = [];
    const refused = await captureLog(() => approveRun([id8], {
      paneId: null,
      rows: [],
      // A resolver that answers a brainId request with somebody else must never be sent to.
      resolve: async () => ({ ...TARGET_B, brainId: 'TST-0009' }),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    }));
    assert.equal(refused.result, 4);
    assert.match(refused.lines.join('\n'), /hold targets brain TST-0002, resolved TST-0009/);
    assert.equal(frames.length, 0);
  } finally {
    restore();
  }
});

test('sbb approve refuses a brain whose pane carries @sbb_brain, and logs the attempt', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'self serve'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    let sent = 0;
    const deps = {
      // A fake pane with no roster row: only its @sbb_brain tag names the brain, which is how
      // a spawned brain's pane still looks after its record was retired.
      paneId: '%98',
      rows: [],
      paneOption: async (paneId, name) => (paneId === '%98' && name === 'sbb_brain' ? 'TST-0002' : null),
      resolve: async () => { throw new Error('a refused approve must not resolve anything'); },
      send: async () => { sent += 1; return { status: 'delivered', via: 'uds', msgId: 'x', elapsedMs: 1 }; },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };
    const refused = await captureLog(() => approveRun([id8], deps));
    assert.equal(refused.result, 4);
    assert.match(
      refused.lines.join('\n'),
      /blocked\s+msg=[0-9a-f]{8}\s+via=approve\s+reason=policy\s+detail=holds are approved by the user only/,
    );
    assert.equal(sent, 0, 'nothing is delivered');
    assert.equal(listHeld({ sbbDir }).length, 1, 'the hold is kept');
    const entry = readReceiptEntries().find((e) => e.held === 'refused');
    assert.ok(entry, 'the attempt is logged');
    assert.equal(entry.fromId, 'TST-0002');
    assert.equal(entry.reason, 'policy');
    assert.equal(entry.detail, 'holds are approved by the user only');
    assert.equal(entry.toId, 'TST-0002');

    const denied = await captureLog(() => approveRun(['--deny', id8], deps));
    assert.equal(denied.result, 4, 'a brain may not deny a hold either');
    assert.equal(listHeld({ sbbDir }).length, 1, 'deny did not delete the hold');
  } finally {
    restore();
  }
});

test('sbb approve refuses a brain resolved from its pane record or its session socket', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];
    const base = {
      rows: [],
      paneOption: async () => null,
      resolve: async () => { throw new Error('a refused approve must not resolve anything'); },
      send: async () => { throw new Error('a refused approve must not send anything'); },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };

    const byPane = await captureLog(() => approveRun([id8], { ...base, paneId: '%73', rows: [SENDER_ROW] }));
    assert.equal(byPane.result, 4, 'the pane record names a brain');
    assert.match(byPane.lines.join('\n'), /reason=policy\s+detail=holds are approved by the user only/);

    // Same brain again, this time with no roster row and no pane tag: only the sender session
    // socket (CLAUDE_CODE_MESSAGING_SOCKET) names it.
    writeBrain({ id: 'TST-0003', name: 'lead-a-claude', role: 'sub', parent: 'TST-0001', account: 'a', paneId: '%77', pid: 4321 });
    const bySock = await captureLog(() => approveRun([id8], {
      ...base,
      paneId: null,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/4321.sock' },
    }));
    assert.equal(bySock.result, 4, 'the session socket names a brain');
    const entries = readReceiptEntries().filter((e) => e.held === 'refused');
    assert.deepEqual(entries.map((e) => e.fromId).sort(), ['TST-0001', 'TST-0003']);
    assert.equal(listHeld({ sbbDir }).length, 1, 'both attempts left the hold in place');
  } finally {
    restore();
  }
});

test('sbb approve records the real approver instead of a fixed user', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    twoMains();
    writeConfig(mergeConfig({ peers: 'moderated' }));
    const sbbDir = join(home, '.sbb');
    const { lines } = await captureLog(() => tellRun(['lead-b', 'hello'], tellDeps(home)));
    const id8 = /msg=([0-9a-f]{8})/.exec(lines.find((l) => l.startsWith('blocked')))[1];

    const frames = [];
    const deps = {
      // An unregistered Claude pane: not a brain, so the decision stands and the notice must
      // name it rather than claim the user made it.
      paneId: '%81',
      rows: [{ ...SENDER_ROW, brain: null, brainId: null, paneId: '%81', role: 'peer' }],
      paneOption: async () => null,
      resolve: async (address) => (address === 'lead-a' ? TARGET_A : TARGET_B),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
      startInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
      sbbDir,
    };
    const approved = await captureLog(() => approveRun([id8], deps));
    assert.equal(approved.result, 0);
    assert.equal(frames.length, 2);
    assert.match(frames[1].message.text, /approved and sent by Claude/);
    const entry = readReceiptEntries().find((e) => e.held === 'released');
    assert.equal(entry.approvedBy, 'Claude');
    assert.equal(listHeld({ sbbDir }).length, 0);
  } finally {
    restore();
  }
});

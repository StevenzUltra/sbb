// sbb move: planning, atomic re-parenting, idle waiting, handoff and notifications.
// docs/spec/move.md. Registry reads and writes go to a temp SBB_DIR; tmux and the
// delivery path are injected, so no test touches a real pane or socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as lsRun } from '../src/cli/ls.js';
import { run as moveRun } from '../src/cli/move.js';
import { getBrain, saveBrain } from '../src/registry/brains.js';
import {
  DEFAULT_WAIT_MS,
  POLL_MS,
  applyMove,
  firstFailure,
  handoffPath,
  handoffQuestion,
  notify,
  planMove,
  requestHandoff,
  subtreeOf,
  waitIdle,
} from '../src/move/move.js';
import { captureLog, tempDir, withEnv } from './fixtures/registry/helpers.js';

const SCREENS = JSON.parse(readFileSync(new URL('./fixtures/move/screens.json', import.meta.url), 'utf8'));
const MSG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const noSleep = async () => {};
const okReceipt = (status = 'delivered', reason) => ({ status, via: 'uds', msgId: MSG_ID, elapsedMs: 7, reason });

/** Run `fn` with SBB state in a fresh temp dir. */
async function inSbb(fn) {
  const home = tempDir('sbb-move-');
  const restore = withEnv({ SBB_DIR: join(home, '.sbb'), SBB_HOME_OVERRIDE: home, TMUX_PANE: undefined });
  try {
    return await fn(home);
  } finally {
    restore();
  }
}

/** lead (main) -> ios (sub) -> ui (sub), plus ops (main) and web (codex sub of lead). */
function seed() {
  saveBrain({ id: 'TST-0001', uuid: 'u-1', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude', cwd: '/x', paneId: '%30', coord: '24:3.1', pid: 9001, createdAt: 1, origin: 'adopted' });
  saveBrain({ id: 'TST-0002', uuid: 'u-2', name: 'ops', role: 'main', parent: null, account: 'a', cli: 'claude', cwd: '/x', paneId: '%31', coord: '24:3.2', pid: 9002, createdAt: 2, origin: 'adopted' });
  saveBrain({ id: 'TST-0003', uuid: 'u-3', name: 'ios', role: 'sub', parent: 'TST-0001', account: 'a', cli: 'claude', cwd: '/x', paneId: '%32', coord: '24:3.3', pid: 9003, createdAt: 3, origin: 'adopted' });
  saveBrain({ id: 'TST-0004', uuid: 'u-4', name: 'ui', role: 'sub', parent: 'TST-0003', account: 'a', cli: 'claude', cwd: '/x', paneId: '%33', coord: '24:3.4', pid: 9004, createdAt: 4, origin: 'adopted' });
  saveBrain({ id: 'TST-0005', uuid: 'u-5', name: 'web', role: 'sub', parent: 'TST-0001', account: 'a', cli: 'codex', cwd: '/x', paneId: '%34', coord: '24:3.5', createdAt: 5, origin: 'adopted' });
}

/** @param {Record<string, any>} over */
function row(over = {}) {
  return {
    brain: null, brainId: null, role: null, parent: null, account: 'a', cli: 'claude', model: null,
    status: 'idle', name: null, cwd: '/x', paneId: '%30', coord: '24:3.1', pid: 9001,
    threadId: null, hasRollout: null, threadUncertain: false, sock: null, keyFile: null,
    source: 'pane', claude: undefined, codex: undefined,
    ...over,
    where: over.where ?? over.coord ?? '24:3.1',
  };
}

const LIVE = [
  row({ brain: 'lead', brainId: 'TST-0001', role: 'main' }),
  row({ brain: 'ops', brainId: 'TST-0002', role: 'main', paneId: '%31', coord: '24:3.2', pid: 9002 }),
  row({ brain: 'ios', brainId: 'TST-0003', role: 'sub', parent: 'TST-0001', paneId: '%32', coord: '24:3.3', pid: 9003 }),
  row({ brain: 'ui', brainId: 'TST-0004', role: 'sub', parent: 'TST-0003', paneId: '%33', coord: '24:3.4', pid: 9004 }),
  row({ brain: 'web', brainId: 'TST-0005', role: 'sub', parent: 'TST-0001', cli: 'codex', paneId: '%34', coord: '24:3.5', pid: 9005, status: '?' }),
];

/** The user, outside tmux: notify must label it 用户. */
const USER = { sender: 'user', account: null, cli: null, coord: null, role: '用户', brain: null };

/** Capture console.error the way captureLog captures console.log. */
async function captureErr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { lines, result: await fn() };
  } finally {
    console.error = original;
  }
}

/** A fake tmux whose pane walks a list of screens, repeating the last one. */
function fakeTmux(screens) {
  const calls = { captures: 0 };
  let i = 0;
  return {
    calls,
    api: {
      async capturePane() {
        calls.captures += 1;
        const screen = screens[Math.min(i, screens.length - 1)];
        i += 1;
        return screen;
      },
    },
  };
}

/** A status reader walking a list of values, repeating the last one. */
function statusReader(list) {
  const calls = { reads: 0 };
  let i = 0;
  return {
    calls,
    read: async () => {
      calls.reads += 1;
      const value = list[Math.min(i, list.length - 1)];
      i += 1;
      return value;
    },
  };
}

/** Deps for the CLI that never touch tmux, sockets or the real delivery path. */
function cliDeps(over = {}) {
  const notified = [];
  return {
    notified,
    deps: {
      rows: LIVE,
      callerIdentity: async () => ({ ...USER }),
      notify: async (plan, handoff) => {
        notified.push({ plan, handoff });
        return [];
      },
      ...over,
    },
  };
}

// ---------------------------------------------------------------- planMove

test('planMove: a sub brain moves under a new main parent with its subtree', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'ops', { rows: LIVE });
    assert.equal(plan.brain.id, 'TST-0003');
    assert.deepEqual(plan.from, { parent: 'TST-0001', parentName: 'lead', role: 'sub' });
    assert.equal(plan.to.parent, 'TST-0002');
    assert.equal(plan.to.parentName, 'ops');
    assert.equal(plan.roleAfter, 'sub');
    assert.deepEqual(plan.subtree.map((b) => b.id), ['TST-0004']);
    assert.equal(firstFailure(plan), undefined);
  });
});

test('planMove --to root makes the brain a main brain', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'root', { rows: LIVE });
    assert.equal(plan.to.parent, null);
    assert.equal(plan.roleAfter, 'main');
    assert.equal(plan.to.ref, 'root');
    assert.equal(firstFailure(plan), undefined);
  });
});

test('planMove refuses a cycle: the new parent is a descendant', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('lead', 'ui', { rows: LIVE });
    const failure = firstFailure(plan);
    assert.equal(failure.name, 'no_cycle');
    assert.equal(failure.reason, 'policy');
    assert.equal(failure.detail, 'would create a cycle');
  });
});

test('planMove refuses a brain as its own parent', async () => {
  await inSbb(async () => {
    seed();
    assert.equal(firstFailure(planMove('lead', 'lead', { rows: LIVE })).name, 'no_cycle');
  });
});

test('planMove reports nothing to do when the brain is already there', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'lead', { rows: LIVE });
    const failure = firstFailure(plan);
    assert.equal(failure.name, 'not_already_there');
    assert.equal(failure.reason, 'nothing_to_do');
    assert.match(failure.detail, /already under lead#TST-0001/);
  });
});

test('planMove reports nothing to do for a main brain already at root', async () => {
  await inSbb(async () => {
    seed();
    const failure = firstFailure(planMove('ops', 'root', { rows: LIVE }));
    assert.equal(failure.reason, 'nothing_to_do');
    assert.match(failure.detail, /already a main brain/);
  });
});

test('planMove throws ResolveError for an unknown brain or an unknown parent', async () => {
  await inSbb(async () => {
    seed();
    assert.throws(() => planMove('ghost', 'ops', { rows: LIVE }), (err) => err.name === 'ResolveError' && err.reason === 'target_not_found');
    assert.throws(() => planMove('ios', 'ghost', { rows: LIVE }), (err) => err.name === 'ResolveError' && err.reason === 'target_not_found');
  });
});

test('planMove blocks a parent with no live pane when rows are given', async () => {
  await inSbb(async () => {
    seed();
    const rows = LIVE.filter((r) => r.brainId !== 'TST-0005');
    const plan = planMove('ios', 'web', { rows });
    const failure = firstFailure(plan);
    assert.equal(failure.name, 'target_live');
    assert.equal(failure.reason, 'target_not_found');
    assert.match(failure.detail, /web#TST-0005 has no live pane/);
    assert.equal(firstFailure(planMove('ios', 'web', { rows: LIVE })), undefined);
  });
});

test('planMove without rows skips the liveness check', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'web');
    assert.equal(plan.checks.find((c) => c.name === 'target_live').ok, true);
  });
});

test('subtreeOf: breadth first, each brain once, even with a malformed parent cycle', async () => {
  await inSbb(async () => {
    seed();
    assert.deepEqual(subtreeOf('TST-0001', Object.values({}).length ? [] : [getBrain('TST-0001'), getBrain('TST-0002'), getBrain('TST-0003'), getBrain('TST-0004'), getBrain('TST-0005')]).map((b) => b.id), ['TST-0003', 'TST-0005', 'TST-0004']);
    const looped = [
      { id: 'TST-0001', name: 'a', parent: 'TST-0002' },
      { id: 'TST-0002', name: 'b', parent: 'TST-0001' },
    ];
    assert.deepEqual(subtreeOf('TST-0001', looped).map((b) => b.id), ['TST-0002']);
  });
});

// ---------------------------------------------------------------- applyMove

test('applyMove: re-parents atomically, sets the role, clears pendingMove, keeps children', async () => {
  await inSbb(async () => {
    seed();
    saveBrain({ ...getBrain('ios'), pendingMove: { to: 'ops', requestedAt: 1, handoff: null } });
    const plan = planMove('ios', 'ops', { rows: LIVE });
    const moved = applyMove(plan);
    assert.equal(moved.parent, 'TST-0002');
    assert.equal(moved.role, 'sub');
    assert.equal(moved.pendingMove, undefined);
    const stored = getBrain('TST-0003');
    assert.equal(stored.parent, 'TST-0002');
    assert.equal(stored.pendingMove, undefined);
    assert.equal(getBrain('ui').parent, 'TST-0003', 'children keep their parent and move with it');
  });
});

test('applyMove to root drops the parent and makes the brain main', async () => {
  await inSbb(async () => {
    seed();
    const moved = applyMove(planMove('ios', 'root', { rows: LIVE }));
    assert.equal(moved.parent, null);
    assert.equal(moved.role, 'main');
    assert.equal(getBrain('ios').role, 'main');
  });
});

// ---------------------------------------------------------------- waitIdle

test('waitIdle: Claude idles via the registry, marker written then cleared', async () => {
  await inSbb(async () => {
    seed();
    const writes = [];
    const status = statusReader(['busy', 'idle']);
    const outcome = await waitIdle(getBrain('ios'), {
      pendingMove: { to: 'ops', requestedAt: 1, handoff: null },
      readStatus: status.read,
      saveBrain: (brain) => { writes.push(JSON.parse(JSON.stringify(brain))); return brain; },
      sleep: noSleep,
      timeoutMs: 60_000,
    });
    assert.equal(outcome.status, 'idle');
    assert.equal(outcome.polls, 2);
    assert.equal(writes[0].pendingMove.to, 'ops');
    assert.equal(writes[writes.length - 1].pendingMove, undefined);
    assert.equal(status.calls.reads, 2);
  });
});

test('waitIdle: a timeout leaves pendingMove in place', async () => {
  await inSbb(async () => {
    seed();
    const writes = [];
    const outcome = await waitIdle(getBrain('ios'), {
      pendingMove: { to: 'ops', requestedAt: 1, handoff: null },
      readStatus: async () => 'busy',
      saveBrain: (brain) => { writes.push(JSON.parse(JSON.stringify(brain))); return brain; },
      sleep: noSleep,
      timeoutMs: 0,
    });
    assert.equal(outcome.status, 'timeout');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].pendingMove.to, 'ops');
  });
});

test('waitIdle: a non-Claude brain is judged from its pane fingerprint', async () => {
  await inSbb(async () => {
    seed();
    const tmux = fakeTmux([SCREENS.codex.busy, SCREENS.codex.idle]);
    const outcome = await waitIdle(getBrain('web'), {
      tmuxApi: tmux.api,
      saveBrain: (brain) => brain,
      sleep: noSleep,
      timeoutMs: 60_000,
    });
    assert.equal(outcome.status, 'idle');
    assert.equal(tmux.calls.captures, 2);
  });
});

test('waitIdle: an unreadable pane is never idle', async () => {
  await inSbb(async () => {
    seed();
    const api = { async capturePane() { throw new Error('pane gone'); } };
    const outcome = await waitIdle(getBrain('web'), { tmuxApi: api, saveBrain: (b) => b, sleep: noSleep, timeoutMs: 0 });
    assert.equal(outcome.status, 'timeout');
  });
});

test('waitIdle: a Claude brain without a pid falls back to the screen', async () => {
  await inSbb(async () => {
    seed();
    const brain = { ...getBrain('ios'), pid: undefined };
    const tmux = fakeTmux([SCREENS.agy.idle]);
    const outcome = await waitIdle({ ...brain, cli: 'agy' }, { tmuxApi: tmux.api, saveBrain: (b) => b, sleep: noSleep, timeoutMs: 1000 });
    assert.equal(outcome.status, 'idle');
    assert.equal(tmux.calls.captures, 1);
  });
});

test('waitIdle: the default poll interval is 5 s', async () => {
  await inSbb(async () => {
    seed();
    assert.equal(POLL_MS, 5000);
    assert.equal(DEFAULT_WAIT_MS, 30 * 60 * 1000);
    const slept = [];
    const status = statusReader(['busy', 'idle']);
    await waitIdle(getBrain('ios'), {
      readStatus: status.read,
      saveBrain: (b) => b,
      sleep: async (ms) => { slept.push(ms); },
      timeoutMs: 60_000,
    });
    assert.deepEqual(slept, [5000]);
  });
});

// ---------------------------------------------------------------- handoff

test('handoffPath uses the spec format and honours SBB_DIR', async () => {
  await inSbb((home) => {
    const path = handoffPath('TST-0003', new Date(2026, 8, 9, 14, 5, 7));
    assert.equal(path, join(home, '.sbb', 'handoff', 'TST-0003-20260909-140507.md'));
  });
});

test('requestHandoff spawns `sbb ask` with the spec question and the same env', async () => {
  await inSbb(async () => {
    seed();
    const calls = [];
    const run = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: 'done', stderr: '', timedOut: false };
    };
    const result = await requestHandoff(getBrain('ios'), { run, env: { SBB_DIR: '/tmp/x' } });
    assert.equal(result.ok, true);
    assert.match(result.path, /TST-0003-\d{8}-\d{6}\.md$/);
    assert.equal(calls[0].cmd, process.execPath);
    assert.deepEqual(calls[0].args.slice(1), ['ask', 'ios', handoffQuestion(result.path), '--wait', '10m']);
    assert.ok(calls[0].args[0].endsWith('bin/sbb.js'));
    assert.deepEqual(calls[0].opts.env, { SBB_DIR: '/tmp/x' });
  });
});

test('requestHandoff: a timeout is not an error, it is an empty summary', async () => {
  await inSbb(async () => {
    seed();
    const run = async () => ({ code: 5, stdout: 'timeout', stderr: '', timedOut: false });
    const result = await requestHandoff(getBrain('ios'), { run });
    assert.equal(result.ok, false);
    assert.equal(result.wrote, false);
    assert.equal(result.code, 5);
    assert.match(result.path, /handoff\/TST-0003-/);
  });
});

test('requestHandoff: a summary on disk counts even when the ask exits 5', async () => {
  // Measured 2026-09-09: a real Claude brain writes the file and answers in its own pane,
  // never replying through sbb, so the ask times out with a complete summary on disk.
  await inSbb(async () => {
    seed();
    const run = async () => ({ code: 5, stdout: '', stderr: '', timedOut: false });
    const result = await requestHandoff(getBrain('ios'), { run, fileHasContent: () => true });
    assert.equal(result.ok, false);
    assert.equal(result.wrote, true);
  });
});

test('requestHandoff: an empty file is not a summary', async () => {
  await inSbb(async () => {
    seed();
    const run = async () => ({ code: 5, stdout: '', stderr: '', timedOut: false });
    const result = await requestHandoff(getBrain('ios'), { run, fileHasContent: () => false });
    assert.equal(result.wrote, false);
  });
});

// ---------------------------------------------------------------- notify

/** @param {{ resolve?: Function, deliver?: Function }} [over] */
function notifyHarness(over = {}) {
  const sent = [];
  return {
    sent,
    opts: {
      identity: { ...USER },
      openInbox: async () => undefined,
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.1' }),
      deliver: async ({ target, body, identity }) => {
        sent.push({ to: target.address, body, role: identity.role });
        return { receipt: okReceipt() };
      },
      print: () => {},
      ...over,
    },
  };
}

test('notify: three messages in spec order, the caller speaks as 用户', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'ops', { rows: LIVE });
    const harness = notifyHarness();
    const out = await notify(plan, '/x/handoff.md', harness.opts);
    assert.deepEqual(harness.sent.map((m) => m.to), ['TST-0001', 'TST-0002', 'TST-0003']);
    assert.equal(harness.sent[0].body, 'ios#TST-0003 已划归 ops#TST-0002 名下');
    assert.equal(harness.sent[1].body, 'ios#TST-0003 已加入你的名下，原上级 lead#TST-0001，交接摘要 /x/handoff.md');
    assert.equal(harness.sent[2].body, '你的上级现在是 ops#TST-0002，回执与上报改发给它');
    assert.deepEqual(harness.sent.map((m) => m.role), ['用户', '用户', '用户']);
    assert.deepEqual(out.map((r) => r.status), ['delivered', 'delivered', 'delivered']);
  });
});

test('notify: moving to root skips the new-parent message and names 用户', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'root', { rows: LIVE });
    const harness = notifyHarness();
    await notify(plan, null, harness.opts);
    assert.deepEqual(harness.sent.map((m) => m.to), ['TST-0001', 'TST-0003']);
    assert.equal(harness.sent[0].body, 'ios#TST-0003 已划归 用户 名下');
    assert.equal(harness.sent[1].body, '你的上级现在是 用户，回执与上报改发给它');
  });
});

test('notify: a main brain with no old parent only tells the new parent and the brain', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ops', 'lead', { rows: LIVE });
    const harness = notifyHarness();
    await notify(plan, null, harness.opts);
    assert.deepEqual(harness.sent.map((m) => m.to), ['TST-0001', 'TST-0002']);
    assert.equal(harness.sent[0].body, 'ops#TST-0002 已加入你的名下，原上级 用户，交接摘要 无');
  });
});

test('notify: a blocked notification is reported and never stops the rest', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'ops', { rows: LIVE });
    const harness = notifyHarness({
      resolve: async (address) => {
        if (address === 'TST-0001') throw Object.assign(new Error('pane gone'), { reason: 'target_not_found' });
        return { address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.1' };
      },
    });
    const out = await notify(plan, null, harness.opts);
    assert.equal(out[0].status, 'blocked');
    assert.equal(out[0].reason, 'target_not_found');
    assert.deepEqual(harness.sent.map((m) => m.to), ['TST-0002', 'TST-0003']);
    assert.equal(out.length, 3);
  });
});

test('notify: a registered caller keeps its own role', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'ops', { rows: LIVE });
    const harness = notifyHarness({ identity: { sender: 'lead', id: 'TST-0001', brain: 'lead', role: '主脑', account: 'a', cli: 'claude', coord: '24:3.1' } });
    await notify(plan, null, harness.opts);
    assert.deepEqual(harness.sent.map((m) => m.role), ['主脑', '主脑', '主脑']);
  });
});

test('notify: a blocked receipt is printed but does not roll the move back', async () => {
  await inSbb(async () => {
    seed();
    const plan = planMove('ios', 'ops', { rows: LIVE });
    const lines = [];
    const harness = notifyHarness({
      deliver: async () => ({ receipt: okReceipt('blocked', 'policy') }),
      print: (line) => lines.push(line),
    });
    const out = await notify(plan, null, harness.opts);
    assert.deepEqual(out.map((r) => r.status), ['blocked', 'blocked', 'blocked']);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => line.includes('blocked')));
  });
});

// ---------------------------------------------------------------- sbb move CLI

test('sbb move --now: re-parents, notifies and prints the moved line', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps();
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops', '--now'], deps));
    assert.equal(out.result, 0);
    assert.equal(out.lines.at(-1), 'moved TST-0003 ios -> ops#TST-0002');
    assert.equal(getBrain('ios').parent, 'TST-0002');
    assert.equal(getBrain('ui').parent, 'TST-0003');
    assert.equal(notified.length, 1);
    assert.equal(notified[0].handoff, null);
    assert.equal(notified[0].plan.subtree.length, 1);
  });
});

test('sbb move --to root: the brain becomes main', async () => {
  await inSbb(async () => {
    seed();
    const out = await captureLog(() => moveRun(['ios', '--to', 'root', '--now'], cliDeps().deps));
    assert.equal(out.result, 0);
    assert.equal(out.lines.at(-1), 'moved TST-0003 ios -> root');
    assert.equal(getBrain('ios').role, 'main');
  });
});

test('sbb move: a cycle is blocked with exit 4 and changes nothing', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps();
    const out = await captureErr(() => moveRun(['lead', '--to', 'ui', '--now'], deps));
    assert.equal(out.result, 4);
    assert.match(out.lines.join('\n'), /blocked: policy: would create a cycle/);
    assert.equal(getBrain('lead').parent, null);
    assert.equal(notified.length, 0);
  });
});

test('sbb move: already there is exit 0 and no write', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps();
    const out = await captureLog(() => moveRun(['ios', '--to', 'lead', '--now'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /nothing to do:/);
    assert.equal(notified.length, 0);
  });
});

test('sbb move: an unknown brain or parent is blocked with exit 4', async () => {
  await inSbb(async () => {
    seed();
    assert.equal((await captureErr(() => moveRun(['ghost', '--to', 'ops', '--now'], cliDeps().deps))).result, 4);
    assert.equal((await captureErr(() => moveRun(['ios', '--to', 'ghost', '--now'], cliDeps().deps))).result, 4);
  });
});

test('sbb move --after-idle: waits, then moves', async () => {
  await inSbb(async () => {
    seed();
    let seen;
    const { deps, notified } = cliDeps({
      waitIdle: async (brain, opts) => {
        seen = { brain, opts };
        return { status: 'idle', polls: 3, elapsedMs: 1200 };
      },
    });
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.opts.pendingMove.to, 'ops');
    assert.equal(seen.opts.pendingMove.handoff, null);
    assert.equal(typeof seen.opts.pendingMove.requestedAt, 'number');
    assert.equal(seen.opts.timeoutMs, DEFAULT_WAIT_MS);
    assert.equal(getBrain('ios').parent, 'TST-0002');
    assert.equal(notified.length, 1);
  });
});

test('sbb move --after-idle: a timeout exits 5, keeps pendingMove and says how to finish', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps({ readStatus: async () => 'busy', sleep: noSleep });
    const out = await captureErr(() => moveRun(['ios', '--to', 'ops', '--after-idle', '--wait', '1'], deps));
    assert.equal(out.result, 5);
    assert.match(out.lines.join('\n'), /sbb move ios --to ops --now/);
    assert.equal(getBrain('ios').pendingMove.to, 'ops');
    assert.equal(getBrain('ios').parent, 'TST-0001', 'not moved yet');
    assert.equal(notified.length, 0);
  });
});

test('sbb move --after-idle then --now clears the marker and moves', async () => {
  await inSbb(async () => {
    seed();
    const first = cliDeps({ readStatus: async () => 'busy', sleep: noSleep });
    assert.equal((await captureErr(() => moveRun(['ios', '--to', 'ops', '--wait', '1'], first.deps))).result, 5);
    assert.ok(getBrain('ios').pendingMove);
    const second = cliDeps();
    assert.equal((await captureLog(() => moveRun(['ios', '--to', 'ops', '--now'], second.deps))).result, 0);
    assert.equal(getBrain('ios').pendingMove, undefined);
    assert.equal(getBrain('ios').parent, 'TST-0002');
  });
});

test('sbb move --handoff: the summary path reaches the notifications', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps({ handoff: async () => ({ ok: true, path: '/tmp/summary.md', code: 0 }) });
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops', '--now', '--handoff'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /handoff   \/tmp\/summary\.md/);
    assert.equal(notified[0].handoff, '/tmp/summary.md');
  });
});

test('sbb move --handoff: a timeout continues with an empty summary', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps({ handoff: async () => ({ ok: false, path: '/tmp/x.md', code: 5 }) });
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops', '--now', '--handoff'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /no reply \(exit 5\)/);
    assert.equal(notified[0].handoff, null);
  });
});

test('sbb move --handoff: a written summary is used when the ask saw no reply', async () => {
  await inSbb(async () => {
    seed();
    const { deps, notified } = cliDeps({ handoff: async () => ({ ok: false, wrote: true, path: '/tmp/written.md', code: 5 }) });
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops', '--now', '--handoff'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /handoff   \/tmp\/written\.md \(written;/);
    assert.equal(notified[0].handoff, '/tmp/written.md');
  });
});

test('sbb move --json: the plan, the subtree and the receipts', async () => {
  await inSbb(async () => {
    seed();
    const out = await captureLog(() => moveRun(['ios', '--to', 'ops', '--now', '--json'], cliDeps().deps));
    assert.equal(out.result, 0);
    const payload = JSON.parse(out.lines.join('\n'));
    assert.equal(payload.brain.id, 'TST-0003');
    assert.equal(payload.brain.parent, 'TST-0002');
    assert.equal(payload.to.parentName, 'ops');
    assert.deepEqual(payload.subtree.map((b) => b.id), ['TST-0004']);
    assert.deepEqual(payload.notifications, []);
  });
});

test('sbb move: --now and --after-idle together, a missing --to or a bad count are usage errors', async () => {
  await inSbb(async () => {
    seed();
    assert.equal((await captureErr(() => moveRun(['ios', '--now', '--after-idle'], cliDeps().deps))).result, 2);
    assert.equal((await captureErr(() => moveRun(['ios'], cliDeps().deps))).result, 2);
    assert.equal((await captureErr(() => moveRun(['ios', 'ui', '--to', 'ops'], cliDeps().deps))).result, 2);
    assert.equal((await captureErr(() => moveRun(['ios', '--to', 'ops', '--wait', 'soon'], cliDeps().deps))).result, 2);
  });
});

test('sbb move --help prints the usage without touching the registry', async () => {
  const out = await captureLog(() => moveRun(['--help'], {}));
  assert.equal(out.result, 0);
  assert.match(out.lines.join('\n'), /^usage: sbb move/);
});

// ---------------------------------------------------------------- ls hint

test('sbb ls: a pending move shows "-> <target>" in the STATUS column', async () => {
  await inSbb(async () => {
    seed();
    saveBrain({ ...getBrain('ios'), pendingMove: { to: 'ops', requestedAt: 1, handoff: null } });
    const out = await captureLog(() => lsRun([], { roster: async () => LIVE }));
    assert.equal(out.result, 0);
    const table = out.lines.join('\n').split('\n');
    assert.match(table.find((l) => l.includes('TST-0003')), /idle -> ops/);
    assert.doesNotMatch(table.find((l) => l.includes('TST-0001')), /->/);
  });
});

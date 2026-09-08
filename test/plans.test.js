// Plans: validation, proposer/approver rules, and the approve path (quota-checked, one
// `sbb spawn` per node, results recorded and the proposer notified).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as planRun } from '../src/cli/plan.js';
import { mergeConfig } from '../src/policy/config.js';
import {
  PlanError,
  approvePlan,
  createPlan,
  getPlan,
  listPlans,
  mayApprove,
  normalizePlan,
  parseSpawnOutput,
  rejectPlan,
  resultPath,
  spawnArgs,
} from '../src/policy/plans.js';
import { listInbox } from '../src/registry/inbox.js';
import { getBrain } from '../src/registry/brains.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

/** The plan fixture lives under test/fixtures/policy/, not the registry fixture dir. */
function planFixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/policy/plan.json', import.meta.url), 'utf8'));
}

const ACCOUNTS = [{ name: 'a' }, { name: 'b' }];

function sbbEnv(home, extra = {}) {
  return { SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb'), TMUX_PANE: undefined, ...extra };
}

function callerRow(over) {
  return {
    brain: over.brain, brainId: over.brainId, role: over.role ?? 'main', parent: over.parent ?? null,
    account: 'a', cli: 'claude', model: null, status: 'idle', name: over.brain, cwd: '/tmp/proj',
    paneId: '%73', coord: '24:3.7', pid: 4321, source: 'pane', where: '24:3.7',
  };
}

/** lead-a (main) -> sub-a -> grand-a, plus another team lead-b -> sub-b. */
function team() {
  writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'a' });
  writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null, account: 'b' });
  writeBrain({ id: 'TST-0003', name: 'sub-a', role: 'sub', parent: 'TST-0001', account: 'a' });
  writeBrain({ id: 'TST-0004', name: 'grand-a', role: 'sub', parent: 'TST-0003', account: 'b' });
  writeBrain({ id: 'TST-0005', name: 'sub-b', role: 'sub', parent: 'TST-0002', account: 'b' });
}

test('normalizePlan rejects unknown parents, bad names, duplicates and unknown accounts', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const base = planFixture();
    assert.throws(() => normalizePlan({ ...base, parent: 'nobody' }, { getBrain, accounts: ACCOUNTS }), /unknown parent/);
    assert.throws(() => normalizePlan({ ...base, brains: [] }, { getBrain, accounts: ACCOUNTS }), /non-empty array/);
    assert.throws(() => normalizePlan({ ...base, brains: [{ ...base.brains[0], name: 'Bad Name' }] }, { getBrain, accounts: ACCOUNTS }), /invalid brain name/);
    assert.throws(() => normalizePlan({ ...base, brains: [{ ...base.brains[0], name: 'sub-a' }] }, { getBrain, accounts: ACCOUNTS }), /already in use/);
    assert.throws(
      () => normalizePlan({ ...base, brains: [base.brains[0], { ...base.brains[1], name: base.brains[0].name }] }, { getBrain, accounts: ACCOUNTS }),
      /duplicate brain name/,
    );
    assert.throws(() => normalizePlan({ ...base, brains: [{ ...base.brains[0], account: 'zz' }] }, { getBrain, accounts: ACCOUNTS }), /unknown account/);

    const plan = normalizePlan(base, { getBrain, accounts: ACCOUNTS });
    assert.equal(plan.parent, 'TST-0001');
    assert.deepEqual(plan.brains.map((b) => [b.name, b.role, b.account, b.cli]), [
      ['fe-a', 'sub', 'a', 'claude'],
      ['fe-b', 'sub', 'b', 'codex'],
    ]);
  } finally {
    restore();
  }
});

test('proposer must be the parent or an ancestor; approver rules follow autonomous', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const input = planFixture();
    const leadA = getBrain('TST-0001');
    const subA = getBrain('TST-0003');
    const grandA = getBrain('TST-0004');
    const subB = getBrain('TST-0005');

    const plan = createPlan(input, { proposer: leadA, getBrain, accounts: ACCOUNTS });
    assert.equal(plan.status, 'pending');
    assert.equal(plan.proposedBy, 'TST-0001');
    assert.equal(listPlans().length, 1);
    // the spec: proposer must be the parent or its ancestor, never a descendant
    assert.throws(
      () => createPlan({ ...input, brains: [{ ...input.brains[0], name: 'fe-c' }] }, { proposer: subA, getBrain, accounts: ACCOUNTS }),
      /may not propose/,
    );
    assert.throws(
      () => createPlan({ ...input, brains: [{ ...input.brains[0], name: 'fe-d' }] }, { proposer: subB, getBrain, accounts: ACCOUNTS }),
      /may not propose/,
    );
    // an ancestor may propose for a sub parent
    const nested = createPlan({ ...input, parent: 'TST-0003', brains: [{ ...input.brains[0], name: 'fe-e' }] }, { proposer: leadA, getBrain, accounts: ACCOUNTS });
    assert.equal(nested.parent, 'TST-0003');
    assert.equal(nested.proposedBy, 'TST-0001');

    const config = mergeConfig({});
    assert.equal(mayApprove(plan, null, { getBrain, config }), true, 'the user approves');
    assert.equal(mayApprove(plan, leadA, { getBrain, config }), false, 'the parent needs autonomous');
    assert.equal(mayApprove(plan, leadA, { getBrain, config: mergeConfig({ brains: { 'TST-0001': { autonomous: true } } }) }), true);
    assert.equal(mayApprove(plan, subB, { getBrain, config }), false, 'another team');
    assert.equal(mayApprove(plan, grandA, { getBrain, config }), false, 'a child is not an ancestor');
    assert.equal(mayApprove(plan, getBrain('TST-0002'), { getBrain, config }), false);
  } finally {
    restore();
  }
});

test('approvePlan spawns in order, quota-checks per node, records results', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const input = planFixture();
    const plan = createPlan(input, { proposer: null, getBrain, accounts: ACCOUNTS });
    const calls = [];
    const spawn = async (node) => {
      calls.push(node.name);
      if (node.name === 'fe-b') return { code: 1, stdout: '', stderr: 'tmux: no server' };
      return { code: 0, stdout: `spawned TST-0009 ${node.name} 24:3.9\n`, stderr: '' };
    };
    const { plan: done, result } = await approvePlan(plan, {
      approver: null,
      config: mergeConfig({}),
      rows: [{ account: 'a', window: 'weekly', remaining: 90 }, { account: 'b', window: 'weekly', remaining: 90 }],
      brains: [],
      spawn,
      getBrain,
      accounts: ACCOUNTS,
    });
    assert.deepEqual(calls, ['fe-a', 'fe-b'], 'nodes spawn in plan order');
    assert.equal(done.status, 'approved_with_errors');
    assert.deepEqual(result.results.map((r) => [r.name, r.status]), [
      ['fe-a', 'spawned'],
      ['fe-b', 'failed'],
    ]);
    assert.equal(result.results[0].id, 'TST-0009');
    assert.match(result.results[1].detail, /tmux: no server/);
    assert.ok(existsSync(resultPath(done.planId)), 'the result file is written');
    assert.equal(JSON.parse(readFileSync(resultPath(done.planId), 'utf8')).planId, done.planId);
    await assert.rejects(() => approvePlan(done, { approver: null, getBrain }), /not pending/);
  } finally {
    restore();
  }
});

test('approvePlan blocks a node below the quota floor but spawns the rest', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const plan = createPlan(planFixture(), { proposer: null, getBrain, accounts: ACCOUNTS });
    const calls = [];
    const { result } = await approvePlan(plan, {
      approver: null,
      config: mergeConfig({}),
      rows: [{ account: 'a', window: 'weekly', remaining: 3 }, { account: 'b', window: 'weekly', remaining: 90 }],
      brains: [],
      spawn: async (node) => {
        calls.push(node.name);
        return { code: 0, stdout: `spawned TST-0010 ${node.name} 24:3.9`, stderr: '' };
      },
      getBrain,
      accounts: ACCOUNTS,
    });
    assert.deepEqual(calls, ['fe-b'], 'the blocked node never reaches spawn');
    assert.deepEqual(result.results.map((r) => [r.name, r.status, r.reason]), [
      ['fe-a', 'blocked', 'quota'],
      ['fe-b', 'spawned', undefined],
    ]);
    assert.match(result.results[0].detail, /account a weekly remaining 3% < floor 10%/);
  } finally {
    restore();
  }
});

test('parseSpawnOutput accepts the text and the JSON form', () => {
  assert.deepEqual(parseSpawnOutput('spawned TST-0012 ios 24:3.5\n'), { id: 'TST-0012', name: 'ios', coord: '24:3.5' });
  assert.deepEqual(parseSpawnOutput('{"id":"TST-0013","name":"ios2","coord":"24:3.6"}'), { id: 'TST-0013', name: 'ios2', coord: '24:3.6' });
  assert.equal(parseSpawnOutput('nothing here'), null);
});

test('sbb plan propose/ls/show/reject through the CLI', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const file = join(home, 'plan.json');
    const input = planFixture();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(input));
    const deps = {
      paneId: '%73',
      rows: [callerRow({ brainId: 'TST-0001', brain: 'lead-a', role: 'main' })],
      accounts: ACCOUNTS,
      sbbDir: join(home, '.sbb'),
    };

    const proposed = await captureLog(() => planRun(['propose', '--file', file], deps));
    assert.equal(proposed.result, 0);
    const planId = /plan\s+(PL-\S+)\s+pending/.exec(proposed.lines[0])[1];
    const inbox = listInbox('user');
    assert.equal(inbox.length, 1, 'the user inbox is notified');
    assert.match(inbox[0].entry.text, new RegExp(`plan ${planId} pending`));
    assert.match(inbox[0].entry.text, /fe-a, fe-b/);

    const listed = await captureLog(() => planRun(['ls'], deps));
    assert.match(listed.lines.join('\n'), new RegExp(`${planId}\\s+pending\\s+TST-0001`));
    const shown = await captureLog(() => planRun(['show', planId], deps));
    assert.equal(shown.result, 0);
    assert.equal(JSON.parse(shown.lines.join('\n')).planId, planId);

    const rejected = await captureLog(() => planRun(['reject', planId, '--reason', 'not now'], deps));
    assert.equal(rejected.result, 0);
    assert.equal(getPlan(planId).plan.status, 'rejected');
    assert.equal(getPlan(planId).plan.rejectionReason, 'not now');
    assert.equal(getPlan(planId).plan.decidedBy, 'TST-0001');
  } finally {
    restore();
  }
});

test('sbb plan approve spawns nodes, writes the report and notifies the proposer', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const input = planFixture();
    const file = join(home, 'plan.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(input));
    const proposerDeps = {
      paneId: '%73',
      rows: [callerRow({ brainId: 'TST-0001', brain: 'lead-a', role: 'main' })],
      accounts: ACCOUNTS,
      sbbDir: join(home, '.sbb'),
    };
    const proposed = await captureLog(() => planRun(['propose', '--file', file], proposerDeps));
    const planId = /plan\s+(PL-\S+)\s+pending/.exec(proposed.lines[0])[1];

    const frames = [];
    const approveDeps = {
      paneId: undefined,
      rows: [],
      accounts: ACCOUNTS,
      sbbDir: join(home, '.sbb'),
      readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 80 }],
      spawn: async (node) => ({ code: 0, stdout: `spawned TST-001${node.name === 'fe-a' ? 4 : 5} ${node.name} 24:3.9`, stderr: '' }),
      send: async (target, message) => {
        frames.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
    };
    const approved = await captureLog(() => planRun(['approve', planId], approveDeps));
    assert.equal(approved.result, 0);
    const plan = getPlan(planId).plan;
    assert.equal(plan.status, 'approved');
    assert.equal(plan.decidedBy, 'user');
    const report = JSON.parse(readFileSync(resultPath(planId), 'utf8'));
    assert.deepEqual(report.results.map((r) => r.status), ['spawned', 'spawned']);

    assert.equal(frames.length, 1, 'the proposer is notified once');
    assert.equal(frames[0].target.brainId, 'TST-0001');
    assert.match(frames[0].message.text, new RegExp(`plan ${planId} approved: spawned=2 failed=0`));
    assert.match(frames[0].message.text, new RegExp(`${planId}\\.result\\.json`));
  } finally {
    restore();
  }
});

test('rejectPlan records who rejected and why', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const plan = createPlan(planFixture(), { proposer: null, getBrain, accounts: ACCOUNTS });
    const rejected = rejectPlan(plan, 'too many brains', { decidedBy: 'user', now: 1234 });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decidedAt, 1234);
    assert.equal(getPlan(plan.planId).plan.rejectionReason, 'too many brains');
    assert.ok(PlanError.prototype instanceof Error);
  } finally {
    restore();
  }
});

test('normalizePlan keeps an optional cliArgs string and rejects other types', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const base = planFixture();
    const withArgs = normalizePlan(
      { ...base, brains: [{ ...base.brains[0], cliArgs: '--permission-mode bypassPermissions' }] },
      { getBrain, accounts: ACCOUNTS },
    );
    assert.equal(withArgs.brains[0].cliArgs, '--permission-mode bypassPermissions');
    assert.equal(normalizePlan(base, { getBrain, accounts: ACCOUNTS }).brains[0].cliArgs, undefined, 'absent by default');
    const blank = normalizePlan(
      { ...base, brains: [{ ...base.brains[0], cliArgs: '   ' }] },
      { getBrain, accounts: ACCOUNTS },
    );
    assert.equal(blank.brains[0].cliArgs, undefined, 'blank cliArgs is dropped, not spawned');
    assert.throws(
      () => normalizePlan({ ...base, brains: [{ ...base.brains[0], cliArgs: ['--x'] }] }, { getBrain, accounts: ACCOUNTS }),
      /cliArgs must be a string/,
    );
  } finally {
    restore();
  }
});

test('spawnArgs carries cliArgs as --cli-args for sbb spawn', () => {
  const node = { name: 'fe-a', role: 'sub', account: 'a', cli: 'claude', parent: 'TST-0001', cwd: '/tmp/proj' };
  const withArgs = spawnArgs({ ...node, cliArgs: '--permission-mode bypassPermissions' });
  const at = withArgs.indexOf('--cli-args');
  assert.ok(at !== -1, `the flag is passed: ${withArgs.join(' ')}`);
  assert.equal(withArgs[at + 1], '--permission-mode bypassPermissions');
  assert.equal(withArgs.filter((a) => a === '--cli-args').length, 1, 'exactly once');
  assert.ok(!spawnArgs(node).includes('--cli-args'), 'no flag without cliArgs');
});

test('approvePlan hands each node its cliArgs to the spawn runner', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    team();
    const input = planFixture();
    input.brains[0].cliArgs = '--permission-mode bypassPermissions';
    const plan = createPlan(input, { proposer: null, getBrain, accounts: ACCOUNTS });
    const seen = [];
    const { plan: done } = await approvePlan(plan, {
      approver: null,
      config: mergeConfig({}),
      rows: [{ account: 'a', window: 'weekly', remaining: 90 }, { account: 'b', window: 'weekly', remaining: 90 }],
      brains: [],
      spawn: async (node) => {
        seen.push([node.name, node.cliArgs]);
        return { code: 0, stdout: `spawned TST-0009 ${node.name} 24:3.9`, stderr: '' };
      },
      getBrain,
      accounts: ACCOUNTS,
    });
    assert.equal(done.status, 'approved');
    assert.deepEqual(seen[0], ['fe-a', '--permission-mode bypassPermissions']);
    assert.equal(seen[1][1], undefined, 'a node without cliArgs stays untouched');
  } finally {
    restore();
  }
});

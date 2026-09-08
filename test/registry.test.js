import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brainsDir } from '../src/lib/paths.js';
import { BrainError, getBrain, listBrains, listRetiredBrains, removeBrain, saveBrain } from '../src/registry/brains.js';
import { isAlive, listClaudeSessions, paneTmuxKey } from '../src/registry/claude-sessions.js';
import { CodexRegistryError, listCodexThreads } from '../src/registry/codex-threads.js';
import {
  inferCliFromCommand,
  inferCliFromProcessTree,
  roster,
  screenStatus,
} from '../src/registry/roster.js';
import { buildCodexDb, fixtureJson, tempDir, withEnv, writeBrain, writeClaudeSession } from './fixtures/registry/helpers.js';

/** A pid that has certainly exited: the runner reaps the child before returning. */
function deadPid() {
  const result = spawnSync('true');
  return result.pid;
}

/** @param {{ commands?: Record<string, string>, children?: Record<string, string[]> }} tree */
function fakeExec(tree = {}) {
  const commands = tree.commands ?? {};
  const children = tree.children ?? {};
  return async (cmd, args) => {
    if (cmd === 'pgrep') {
      const kids = children[args[1]] ?? [];
      return { code: kids.length ? 0 : 1, stdout: kids.join('\n'), stderr: '', timedOut: false };
    }
    if (cmd === 'ps') {
      const pid = args[args.length - 1];
      return { code: 0, stdout: `${commands[pid] ?? 'zsh -l'}\n`, stderr: '', timedOut: false };
    }
    return { code: 1, stdout: '', stderr: `unexpected command ${cmd}`, timedOut: false };
  };
}

function fakeAccounts(home, names) {
  return names.map((name) => ({
    name,
    baseDir: join(home, `.ai-account-${name}`),
    claudeDir: join(home, `.ai-account-${name}`, 'claude'),
    codexDir: join(home, `.ai-account-${name}`, 'codex'),
  }));
}

test('brains: save, get, list and retire by id', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const brain = writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead', model: 'claude-fable-5-1', pid: 1234 });
    assert.deepEqual(getBrain('lead'), brain);
    assert.deepEqual(getBrain('TST-0001'), brain);
    assert.deepEqual(getBrain('#tst-0001'), brain, 'id lookup ignores case and the leading #');
    assert.deepEqual(readdirSync(brainsDir()), ['TST-0001.json'], 'no temp file is left behind');
    assert.equal(listBrains().length, 1);

    writeBrain({ id: 'TST-0002', uuid: 'uuid-ios', name: 'ios', role: 'sub', parent: 'TST-0001' });
    assert.deepEqual(listBrains().map((b) => b.id), ['TST-0001', 'TST-0002']);

    const retired = removeBrain('ios');
    assert.equal(retired.id, 'TST-0002');
    assert.ok(retired.retiredAt > 0, 'retiring stamps retiredAt');
    assert.equal(removeBrain('ios'), undefined, 'a second remove finds nothing');
    assert.deepEqual(listBrains().map((b) => b.id), ['TST-0001']);
    assert.deepEqual(listRetiredBrains().map((b) => b.id), ['TST-0002'], 'the record is kept, never deleted');
    assert.equal(getBrain('ios'), undefined, 'a retired brain is not live');
  } finally {
    restore();
  }
});

test('brains: invalid records are rejected with a reason', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const base = {
      id: 'TST-0001', uuid: 'uuid-1', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude',
      cwd: '/Users/dev/proj', paneId: '%30', createdAt: Date.now(), origin: 'adopted',
    };
    assert.throws(() => saveBrain({ ...base, name: 'Lead' }), (err) => err instanceof BrainError && err.reason === 'invalid_name');
    assert.throws(() => saveBrain({ ...base, id: 'SMS-1' }), (err) => err.reason === 'invalid_id');
    assert.throws(() => saveBrain({ ...base, uuid: '' }), (err) => err.reason === 'invalid_uuid');
    const normalised = saveBrain({ ...base, id: 'sms-0001', uuid: 'uuid-norm', name: 'norm' });
    assert.equal(normalised.id, 'SMS-0001', 'a lower-case id is normalised, not rejected');
    assert.throws(() => saveBrain({ ...base, role: 'sub', parent: null }), (err) => err.reason === 'invalid_parent');
    assert.throws(() => saveBrain({ ...base, role: 'sub', parent: 'TST-9999' }), (err) => err.reason === 'unknown_parent');
    assert.throws(() => saveBrain({ ...base, parent: 'TST-0002' }), (err) => err.reason === 'invalid_parent');
    assert.throws(() => saveBrain({ ...base, paneId: '30' }), (err) => err.reason === 'invalid_pane');
    assert.throws(() => saveBrain({ ...base, cli: 'gpt' }), (err) => err.reason === 'invalid_cli');
    assert.throws(() => saveBrain({ ...base, account: '' }), (err) => err.reason === 'invalid_account');

    writeBrain({ id: 'TST-0001', uuid: 'uuid-1', name: 'lead' });
    assert.throws(() => saveBrain({ ...base, uuid: 'uuid-2' }), (err) => err.reason === 'duplicate_id');
    assert.throws(
      () => saveBrain({ ...base, id: 'TST-0003', name: 'other' }),
      (err) => err.reason === 'duplicate_uuid',
    );
    assert.throws(() => saveBrain({ ...base, id: 'TST-0004', uuid: 'uuid-4' }), (err) => err.reason === 'duplicate_name');
    assert.doesNotThrow(
      () => saveBrain({ ...base, id: 'TST-0001', uuid: 'uuid-1', name: 'lead' }),
      're-saving the same record is an update, not a conflict',
    );
  } finally {
    restore();
  }
});

test('brains: a corrupt record is skipped, not invented', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    writeBrain({ id: 'TST-0001', uuid: 'uuid-1', name: 'lead' });
    writeFileSync(join(brainsDir(), 'broken.json'), '{ not json');
    assert.deepEqual(listBrains().map((b) => b.name), ['lead']);
    assert.equal(getBrain('broken'), undefined);
  } finally {
    restore();
  }
});

test('claude sessions: dead pids are filtered and the key file is attached', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home });
  try {
    const dead = deadPid();
    writeClaudeSession(home, 'a', { pid: process.pid, tmux: '24:@16.%30', name: 'lead', status: 'busy' });
    writeClaudeSession(home, 'a', { pid: dead, tmux: '24:@16.%31', name: 'stale' });
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(dead), false);

    const sessions = listClaudeSessions(fakeAccounts(home, ['a']));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, 'lead');
    assert.equal(sessions[0].account, 'a');
    assert.equal(sessions[0].status, 'busy');
    assert.ok(sessions[0].keyFile.endsWith('.key'), 'key file path is attached');
    assert.equal(paneTmuxKey({ session: '24', windowId: '@16', paneId: '%30' }), '24:@16.%30');
  } finally {
    restore();
  }
});

test('codex threads: read-only sqlite, newest first, hasRollout from the rollout path', () => {
  const home = tempDir();
  const codexDir = join(home, '.ai-account-b', 'codex');
  const rolloutDir = join(codexDir, 'sessions', '2026', '09', '09');
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = join(rolloutDir, 'rollout-x.jsonl');
  writeFileSync(rollout, '');
  buildCodexDb(codexDir, [
    { id: 't1', name: 'Reply with PONG', cwd: '/Users/dev/proj', rolloutPath: rollout, updatedAt: 100 },
    { id: 't2', name: 'gone', cwd: '/Users/dev/other', rolloutPath: join(rolloutDir, 'missing.jsonl'), updatedAt: 200 },
  ]);

  const threads = listCodexThreads([{ name: 'b', codexDir }]);
  assert.deepEqual(threads.map((t) => t.id), ['t2', 't1']);
  assert.equal(threads.find((t) => t.id === 't1').hasRollout, true);
  assert.equal(threads.find((t) => t.id === 't1').name, 'Reply with PONG');
  assert.equal(threads.find((t) => t.id === 't2').hasRollout, false);
  assert.equal(threads.find((t) => t.id === 't1').updatedAtMs, 100000);

  const ro = new DatabaseSync(join(codexDir, 'state_5.sqlite'), { readOnly: true });
  assert.throws(() => ro.exec("UPDATE threads SET name = 'x'"));
  ro.close();
});

test('codex threads: an unreadable database raises instead of returning an empty list', () => {
  const home = tempDir();
  const codexDir = join(home, '.ai-account-b', 'codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'state_5.sqlite'), 'not a database at all');
  assert.throws(() => listCodexThreads([{ name: 'b', codexDir }]), (err) => err instanceof CodexRegistryError && err.account === 'b');
});

test('cli inference from pane_current_command', () => {
  assert.equal(inferCliFromCommand('2.1.263'), 'claude');
  assert.equal(inferCliFromCommand('agy'), 'agy');
  assert.equal(inferCliFromCommand('cursor-agent'), 'cursor');
  assert.equal(inferCliFromCommand('codex'), 'codex');
  assert.equal(inferCliFromCommand('grok-1.0.13-mac'), 'other');
  assert.equal(inferCliFromCommand('zsh'), undefined);
  assert.equal(inferCliFromCommand(''), undefined);
});

test('cli inference walks the process tree: codex is a grandchild of the pane shell', async () => {
  const exec = fakeExec({
    commands: { 9003: 'zsh -l', 9101: 'node /opt/homebrew/bin/codex' },
    children: { 9003: ['9101'] },
  });
  assert.equal(await inferCliFromProcessTree({ pid: 9003 }, exec), 'codex');

  const cursor = fakeExec({
    commands: { 9003: 'zsh -l', 9101: '/Users/dev/.local/bin/cursor-agent' },
    children: { 9003: ['9101'] },
  });
  assert.equal(await inferCliFromProcessTree({ pid: 9003 }, cursor), 'cursor');

  const plain = fakeExec({
    commands: { 9007: 'zsh -l', 9103: 'node /app/vite' },
    children: { 9007: ['9103'] },
  });
  assert.equal(await inferCliFromProcessTree({ pid: 9007 }, plain), 'other');
});

test('screen status never guesses idle', () => {
  const profiles = {
    codex: { busy: (s) => s.includes('Working'), idle: (s) => s.includes('Ask Codex') },
  };
  assert.equal(screenStatus('codex', 'Working', profiles), 'busy');
  assert.equal(screenStatus('codex', 'Ask Codex to do anything', profiles), 'idle');
  assert.equal(screenStatus('codex', 'something else', profiles), '?');
  assert.equal(screenStatus('agy', 'anything', profiles), '?');
  assert.equal(screenStatus('codex', 'Working', undefined), '?');
});

test('roster: union of panes, Claude sessions and Codex threads, brains overlaid', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const accounts = fakeAccounts(home, ['a', 'b']);
    writeClaudeSession(home, 'a', { pid: process.pid, tmux: '24:@16.%30', name: 'lead', status: 'busy' });
    writeClaudeSession(home, 'b', { pid: process.ppid, tmux: '24:@16.%73', name: 'h3', status: 'idle' });

    const rolloutDir = join(home, '.ai-account-b', 'codex', 'sessions', '2026', '09', '09');
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, 'rollout-x.jsonl');
    writeFileSync(rollout, '');
    buildCodexDb(accounts[1].codexDir, [
      { id: 't1', name: 'Reply with PONG', cwd: '/Users/dev/proj', rolloutPath: rollout, updatedAt: 100 },
      { id: 't2', name: 'other', cwd: '/Users/dev/other', rolloutPath: join(rolloutDir, 'missing.jsonl'), updatedAt: 200 },
    ]);
    writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead', model: 'claude-fable-5-1' });

    const panes = fixtureJson('panes.json');
    const rows = await roster({
      accounts,
      listPanes: async () => panes,
      exec: fakeExec({ commands: { 9003: 'zsh -l', 9101: 'node /opt/homebrew/bin/codex', 9004: 'zsh -l', 9102: 'node /opt/homebrew/bin/codex', 9007: 'zsh -l', 9103: 'node /app/vite' }, children: { 9003: ['9101'], 9004: ['9102'], 9007: ['9103'] } }),
      withStatus: false,
      onWarn: () => {},
    });

    assert.equal(rows.some((r) => r.paneId === '%34'), false, 'a plain shell is not a row');

    const lead = rows.find((r) => r.paneId === '%30');
    assert.equal(lead.cli, 'claude');
    assert.equal(lead.account, 'a');
    assert.equal(lead.name, 'lead');
    assert.equal(lead.status, 'busy');
    assert.equal(lead.brain, 'lead');
    assert.equal(lead.brainId, 'TST-0001');
    assert.equal(lead.role, 'main');
    assert.equal(lead.model, 'claude-fable-5-1');
    assert.ok(lead.claude, 'the Claude session is attached');

    const h3 = rows.find((r) => r.paneId === '%73');
    assert.equal(h3.name, 'h3');
    assert.equal(h3.status, 'idle');
    assert.equal(h3.brain, null);

    const codexProj = rows.find((r) => r.paneId === '%14');
    assert.equal(codexProj.cli, 'codex');
    assert.equal(codexProj.name, 'Reply with PONG');
    assert.equal(codexProj.hasRollout, true);
    assert.equal(codexProj.threadUncertain, false);

    const codexOther = rows.find((r) => r.paneId === '%20');
    assert.equal(codexOther.cli, 'codex');
    assert.equal(codexOther.hasRollout, false);

    assert.equal(rows.find((r) => r.paneId === '%21').cli, 'other', 'a node pane without a known CLI');
    assert.equal(rows.find((r) => r.paneId === '%29').cli, 'agy');
    assert.equal(rows.find((r) => r.paneId === '%29').status, '?', 'no profiles module means unknown');

    for (const row of rows) assert.ok(['busy', 'idle', '?'].includes(row.status), `unexpected status ${row.status}`);
    const coords = rows.map((r) => `${r.account} ${r.coord}`);
    assert.deepEqual(coords, [...coords].sort(), 'sorted by account then coord');
  } finally {
    restore();
  }
});

test('roster: two live Codex panes in one cwd mark the thread match uncertain', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const accounts = fakeAccounts(home, ['b']);
    const rolloutDir = join(accounts[0].codexDir, 'sessions', '2026', '09', '09');
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, 'rollout-x.jsonl');
    writeFileSync(rollout, '');
    buildCodexDb(accounts[0].codexDir, [
      { id: 't1', name: 'shared', cwd: '/Users/dev/proj', rolloutPath: rollout, updatedAt: 100 },
    ]);
    const panes = [
      { paneId: '%14', windowId: '@14', session: '24', windowIndex: 1, paneIndex: 1, coord: '24:1.1', command: 'node', title: 'a', path: '/Users/dev/proj', inMode: false, pid: 9003, account: 'B' },
      { paneId: '%20', windowId: '@14', session: '24', windowIndex: 1, paneIndex: 7, coord: '24:1.7', command: 'node', title: 'b', path: '/Users/dev/proj', inMode: false, pid: 9004, account: 'B' },
    ];
    const rows = await roster({
      accounts,
      listPanes: async () => panes,
      exec: fakeExec({ commands: { 9003: 'zsh -l', 9101: 'node /opt/homebrew/bin/codex', 9004: 'zsh -l', 9102: 'node /opt/homebrew/bin/codex' }, children: { 9003: ['9101'], 9004: ['9102'] } }),
      withStatus: false,
      onWarn: () => {},
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.threadUncertain), 'both matches are uncertain');
    assert.ok(rows.every((r) => r.name === 'shared'));
  } finally {
    restore();
  }
});

test('roster: a broken codex registry warns instead of failing the whole listing', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const accounts = fakeAccounts(home, ['b']);
    mkdirSync(accounts[0].codexDir, { recursive: true });
    writeFileSync(join(accounts[0].codexDir, 'state_5.sqlite'), 'not a database');
    const warnings = [];
    const rows = await roster({
      accounts,
      listPanes: async () => [],
      withStatus: false,
      onWarn: (message) => warnings.push(message),
    });
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /codex thread registry unavailable/);
  } finally {
    restore();
  }
});

test('roster: stale brains are only listed on request', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    writeBrain({ id: 'TST-0009', uuid: 'uuid-ghost', name: 'ghost', paneId: '%99', coord: '24:9.9' });
    const live = await roster({ accounts: [], listPanes: async () => [], withStatus: false, onWarn: () => {} });
    assert.deepEqual(live, []);
    const withStale = await roster({ accounts: [], listPanes: async () => [], withStatus: false, includeStaleBrains: true, onWarn: () => {} });
    assert.equal(withStale.length, 1);
    assert.equal(withStale[0].brain, 'ghost');
    assert.equal(withStale[0].brainId, 'TST-0009');
    assert.equal(withStale[0].status, 'stale');
    assert.equal(withStale[0].source, 'brain');
  } finally {
    restore();
  }
});

test('brains: paneId null marks a gone pane, other values must still be pane ids', () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const base = {
      id: 'TST-0001', uuid: 'uuid-1', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude',
      cwd: '/Users/dev/proj', paneId: '%30', createdAt: Date.now(), origin: 'adopted',
    };
    const gone = saveBrain({ ...base, paneId: null });
    assert.equal(gone.paneId, null);
    assert.equal(getBrain('TST-0001').paneId, null, 'the gone pane is persisted');
    const missing = saveBrain({ ...base, id: 'TST-0002', uuid: 'uuid-2', name: 'lead2', paneId: undefined });
    assert.equal(missing.paneId, null, 'a missing paneId normalises to null');
    assert.throws(
      () => saveBrain({ ...base, id: 'TST-0003', uuid: 'uuid-3', name: 'lead3', paneId: 'abc' }),
      (err) => err.reason === 'invalid_pane',
    );
  } finally {
    restore();
  }
});

test('roster: a codex brain that records its threadId is not re-guessed by cwd', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb') });
  try {
    const accounts = fakeAccounts(home, ['b']);
    const rolloutDir = join(home, '.ai-account-b', 'codex', 'sessions', '2026', '09', '09');
    mkdirSync(rolloutDir, { recursive: true });
    const older = join(rolloutDir, 'rollout-old.jsonl');
    const newer = join(rolloutDir, 'rollout-new.jsonl');
    writeFileSync(older, '');
    writeFileSync(newer, '');
    // Two codex threads in the same account and cwd; the newer one is the cwd guess.
    buildCodexDb(accounts[0].codexDir, [
      { id: 't1', name: 'old-thread', cwd: '/Users/dev/proj', rolloutPath: older, updatedAt: 100 },
      { id: 't2', name: 'new-thread', cwd: '/Users/dev/proj', rolloutPath: newer, updatedAt: 200 },
    ]);
    const panes = fixtureJson('panes.json');
    const deps = {
      accounts,
      listPanes: async () => panes,
      exec: fakeExec({ commands: { 9003: 'zsh -l', 9101: 'node /opt/homebrew/bin/codex' }, children: { 9003: ['9101'] } }),
      withStatus: false,
      onWarn: () => {},
    };

    const guessed = (await roster(deps)).find((r) => r.paneId === '%14');
    assert.equal(guessed.threadId, 't2', 'without a record the newest thread in the cwd wins');

    const record = { id: 'TST-0001', uuid: 'uuid-ios', name: 'ios', role: 'main', parent: null, account: 'b', cli: 'codex', paneId: '%14', coord: '24:1.1', threadId: 't1' };
    writeBrain(record);
    const recorded = (await roster(deps)).find((r) => r.paneId === '%14');
    assert.equal(recorded.threadId, 't1', 'the recorded thread wins even though it is older');
    assert.equal(recorded.name, 'old-thread');
    assert.equal(recorded.brain, 'ios');
    assert.equal(recorded.threadUncertain, false);

    // A record naming a thread that is gone stays null: no fallback to guessing.
    writeBrain({ ...record, threadId: 't9' });
    const missing = (await roster(deps)).find((r) => r.paneId === '%14');
    assert.equal(missing.threadId, null);
    assert.equal(missing.name, null);
  } finally {
    restore();
  }
});

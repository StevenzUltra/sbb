// codex thread recording: findSpawnedThread (threads.created_at, rollout fallback) and the
// threadId/threadName fields spawn writes into the brain record (task m2/h1-codex-thread).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSpawnedThread, listCodexThreads } from '../src/registry/codex-threads.js';
import { spawnBrain } from '../src/lifecycle/spawn.js';
import { run } from '../src/cli/spawn.js';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import { buildCodexDb, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const CWD = '/tmp/proj';
const UUID_A = '01a08255-2887-7c51-b166-5df0dbfbe5a1';
const UUID_B = '01a08250-a98a-7670-b6ec-6eecb4afcc97';

/** @param {string} home @param {Record<string, any>[]} threads */
function accountWith(home, threads) {
  const codexDir = join(home, '.ai-account-b', 'codex');
  buildCodexDb(codexDir, threads);
  return [{ name: 'b', codexDir }];
}

/** @param {string} codexDir @param {string} uuid @param {Date} mtime */
function writeRollout(codexDir, uuid, mtime) {
  const dir = join(codexDir, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-09T02-00-00-${uuid}.jsonl`);
  writeFileSync(path, '{}\n');
  utimesSync(path, mtime, mtime);
  return path;
}

test('findSpawnedThread: the newest thread created after the spawn start wins', () => {
  const home = tempDir();
  const accounts = accountWith(home, [
    { id: UUID_A, rolloutPath: '/tmp/a.jsonl', cwd: CWD, updatedAt: 1000, createdAt: 1000, name: '旧线程' },
    { id: UUID_B, rolloutPath: '/tmp/b.jsonl', cwd: CWD, updatedAt: 2000, createdAt: 2000, name: '新线程' },
    { id: '01a0824c-8ba7-7e51-9185-82acdecefe6e', rolloutPath: '/tmp/c.jsonl', cwd: '/tmp/other', updatedAt: 3000, createdAt: 3000, name: '别的目录' },
  ]);

  assert.deepEqual(
    findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: 1_500_000, accounts }),
    { id: UUID_B, name: '新线程', source: 'threads.created_at' },
  );
  assert.equal(findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: 5_000_000, accounts }), undefined, 'an older thread is never attributed');
  assert.equal(findSpawnedThread({ account: 'a', cwd: CWD, sinceMs: 0, accounts }), undefined, 'another account is ignored');
  assert.equal(findSpawnedThread({ account: 'b', cwd: '/tmp/none', sinceMs: 0, accounts }), undefined, 'another cwd is ignored');
});

test('findSpawnedThread: a rollout file written since the spawn is the fallback', () => {
  const home = tempDir();
  // The row exists but predates the spawn, so only the rollout file proves this thread.
  const accounts = accountWith(home, [
    { id: UUID_B, rolloutPath: '/tmp/b.jsonl', cwd: CWD, updatedAt: 1000, createdAt: 1000, name: '已知名字' },
  ]);
  const since = Date.now() - 60_000;
  const path = writeRollout(accounts[0].codexDir, UUID_B, new Date());

  assert.deepEqual(
    findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: since, accounts }),
    { id: UUID_B, name: '已知名字', source: 'rollout', rolloutPath: path },
  );
  assert.equal(
    findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: Date.now() + 1000, accounts }),
    undefined,
    'a rollout older than the spawn is ignored',
  );
});

test('findSpawnedThread: an unknown rollout uuid is reported without a name, never invented', () => {
  const home = tempDir();
  const accounts = accountWith(home, []);
  writeRollout(accounts[0].codexDir, UUID_A, new Date());
  const found = findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: Date.now() - 60_000, accounts });
  assert.deepEqual({ id: found.id, name: found.name, source: found.source }, { id: UUID_A, name: undefined, source: 'rollout' });
});

test('findSpawnedThread: a CODEX_HOME without sessions is not an error', () => {
  const home = tempDir();
  const accounts = accountWith(home, []);
  assert.equal(findSpawnedThread({ account: 'b', cwd: CWD, sinceMs: 0, accounts }), undefined);
});

test('listCodexThreads: created_at is exposed as createdAtMs', () => {
  const home = tempDir();
  const accounts = accountWith(home, [
    { id: UUID_A, rolloutPath: '/tmp/a.jsonl', cwd: CWD, updatedAt: 3000, createdAt: 2000, name: 't' },
  ]);
  const [thread] = listCodexThreads(accounts);
  assert.equal(thread.createdAtMs, 2_000_000);
  assert.equal(thread.updatedAtMs, 3_000_000);
});

// --- spawn integration ---------------------------------------------------------------

const ACCOUNTS = [{ name: 'a', baseDir: '/tmp/home/.ai-account-a', claudeDir: '/tmp/home/.ai-account-a/claude', codexDir: '/tmp/home/.ai-account-a/codex' }];

/** @param {Record<string, any>} [over] */
function codexDeps(over = {}) {
  const tmuxApi = createFakeTmux();
  return {
    accounts: ACCOUNTS,
    listBrains: () => [],
    getBrain: () => undefined,
    which: async () => true,
    readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 50 }],
    allocateId: () => 'SMS-0042',
    newUuid: () => 'uuid-42',
    tmuxApi,
    tmuxApiRef: tmuxApi,
    awaitReady: async () => ({ ready: true, thread: undefined, screen: '› ok' }),
    readCodexTrust: () => ({ configPath: '/tmp/home/.ai-account-a/codex/config.toml', found: true, trusted: true, level: 'trusted' }),
    config: {},
    ...over,
  };
}

/** @param {Record<string, any>} [over] */
function codexInput(over = {}) {
  return { name: 'worker', role: 'main', account: 'a', cli: 'codex', model: 'gpt-5', cwd: CWD, ...over };
}

test('spawnBrain: the codex thread is written into the brain record', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const deps = codexDeps({ findSpawnedThread: () => ({ id: UUID_B, name: '新线程', source: 'threads.created_at' }) });
    const result = await spawnBrain(codexInput(), deps);

    assert.equal(result.brain.threadId, UUID_B);
    assert.equal(result.brain.threadName, '新线程');
    assert.deepEqual(result.thread, { id: UUID_B, name: '新线程', source: 'threads.created_at' });
    assert.equal(result.threadError, undefined);
    const record = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0042.json'), 'utf8'));
    assert.equal(record.threadId, UUID_B);
    assert.equal(record.threadName, '新线程');
  } finally {
    restore();
  }
});

test('spawnBrain: no thread found means no field, not a guess', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const result = await spawnBrain(codexInput(), codexDeps({ findSpawnedThread: () => undefined }));
    const record = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0042.json'), 'utf8'));
    assert.equal('threadId' in record, false);
    assert.equal('threadName' in record, false);
    assert.equal(result.thread, null);
  } finally {
    restore();
  }
});

test('spawnBrain: a failing lookup does not fail the spawn, but is reported', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const deps = codexDeps({ findSpawnedThread: () => { throw new Error('cannot read threads from /tmp/x: corrupt'); } });
    const result = await spawnBrain(codexInput(), deps);

    assert.ok(result.brain, JSON.stringify(result));
    assert.equal(result.thread, null);
    assert.match(result.threadError, /cannot read threads from \/tmp\/x/);
    const record = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0042.json'), 'utf8'));
    assert.equal('threadId' in record, false);
  } finally {
    restore();
  }
});

test('spawnBrain: claude spawns never look up a codex thread', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    let called = 0;
    const deps = codexDeps({
      awaitReady: async () => ({ ready: true, session: { pid: 4242 } }),
      findSpawnedThread: () => { called += 1; return undefined; },
    });
    await spawnBrain(codexInput({ cli: 'claude', model: 'claude-haiku-4-5-20251001' }), deps);
    assert.equal(called, 0);
  } finally {
    restore();
  }
});

test('cli spawn: prints the thread line and warns when the lookup failed', async () => {
  const logged = [];
  const warned = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => logged.push(line);
  console.error = (line) => warned.push(line);
  try {
    assert.equal(await run(['--name', 'worker', '--role', 'main', '--account', 'a', '--cli', 'codex'], {
      spawnBrain: async () => ({
        brain: { id: 'SMS-0042', name: 'worker', coord: '24:3.4' },
        thread: { id: UUID_B, name: '新线程', source: 'threads.created_at' },
      }),
    }), 0);
    assert.deepEqual(logged, ['spawned SMS-0042 worker 24:3.4', `thread    ${UUID_B} 新线程 (threads.created_at)`]);

    logged.length = 0;
    assert.equal(await run(['--name', 'worker', '--role', 'main', '--account', 'a', '--cli', 'codex'], {
      spawnBrain: async () => ({
        brain: { id: 'SMS-0042', name: 'worker', coord: '24:3.4' },
        thread: null,
        threadError: 'cannot read threads: corrupt',
      }),
    }), 0);
    assert.deepEqual(logged, ['spawned SMS-0042 worker 24:3.4']);
    assert.match(warned[0], /codex thread lookup failed: cannot read threads: corrupt/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

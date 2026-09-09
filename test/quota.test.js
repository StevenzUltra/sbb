import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountFromAlias,
  readQuota,
  refreshQuota,
  usageGuardBinary,
} from '../src/quota/usage-guard.js';
import { STATIC_MODELS, catalog, parseTomlTopLevel, readCodexConfig, which } from '../src/quota/catalog.js';
import { buildUsageDb, tempDir, withEnv } from './fixtures/registry/helpers.js';

test('quota: reads the newest snapshot per provider and computes remaining', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'usage.sqlite');
  buildUsageDb(dbPath, [
    // older row for the same pair is inserted first (id order is time order)
    { provider: 'claude', account_alias: 'root', captured_at: 500, status: 'fresh', session_used: 99, session_resets_at: 1 },
    { provider: 'claude', account_alias: 'root', captured_at: 1000, status: 'fresh', session_used: 11, session_resets_at: 2000, weekly_used: 10, weekly_resets_at: 3000, fable_used: 20, fable_resets_at: 4000 },
    { provider: 'codex', account_alias: 'a', captured_at: 1500, status: 'fresh', weekly_used: 94, weekly_resets_at: 5000 },
  ]);
  const rows = await readQuota({ dbPath });
  const claude = rows.filter((r) => r.provider === 'claude');
  assert.equal(claude.length, 3, 'session, weekly and fable windows');
  assert.equal(claude[0].account, 'default', 'the Usage Guard alias root is the default account');
  assert.equal(claude[0].alias, 'root');
  assert.equal(claude[0].usedPercent, 11);
  assert.equal(claude[0].remaining, 89);
  assert.equal(claude[0].resetsAt, 2000000);
  assert.equal(claude[0].capturedAt, 1000000);
  assert.equal(claude[0].note, null);
  assert.equal(claude.find((r) => r.window === 'fable').remaining, 80);

  const codex = rows.find((r) => r.provider === 'codex');
  assert.equal(codex.window, 'weekly');
  assert.equal(codex.remaining, 6);
});

test('quota: a non-fresh snapshot keeps remaining unknown and carries the error code', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'usage.sqlite');
  buildUsageDb(dbPath, [
    { provider: 'claude', account_alias: 'b', captured_at: 1000, status: 'authenticationRequired', error_code: 'credential' },
    { provider: 'codex', account_alias: 'c', captured_at: 1000, status: 'unavailable', error_code: 'unavailable' },
  ]);
  const rows = await readQuota({ dbPath });
  const claude = rows.find((r) => r.provider === 'claude');
  assert.equal(claude.remaining, null);
  assert.equal(claude.window, 'unknown');
  assert.equal(claude.note, 'credential');
  assert.equal(rows.find((r) => r.provider === 'codex').note, 'unavailable');
});

test('quota: a missing database prints unknown, never 0%', async () => {
  const dir = tempDir();
  const rows = await readQuota({ dbPath: join(dir, 'nope.sqlite') });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remaining, null);
  assert.equal(rows[0].note, 'usage_guard_db_missing');
  assert.equal(accountFromAlias('ROOT'), 'default');
  assert.equal(accountFromAlias('a'), 'a');
});

test('quota: an unreadable database is reported, not swallowed', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'usage.sqlite');
  writeFileSync(dbPath, 'not a database');
  const rows = await readQuota({ dbPath });
  assert.equal(rows.length, 1);
  assert.match(rows[0].note, /usage_guard_(db_unreadable|query_failed)/);
  assert.equal(rows[0].remaining, null);
});

test('quota: refresh runs the app read-only and reports what happened', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: 'Claude Root session_remaining=87%', stderr: '', timedOut: false };
  };
  const dir = tempDir();
  const dbPath = join(dir, 'usage.sqlite');
  buildUsageDb(dbPath, [{ provider: 'claude', account_alias: 'root', captured_at: 1, status: 'fresh', session_used: 13 }]);

  let info;
  const rows = await readQuota({ dbPath, refresh: true, run, env: { SBB_USAGE_GUARD_APP: '/tmp/fake-app' }, onRefresh: (i) => { info = i; } });
  assert.equal(rows.length, 1);
  assert.equal(info.ran, false, 'no app binary at that path');
  assert.equal(calls.length, 0, 'nothing is executed when the app is missing');

  const missing = await refreshQuota({ env: { SBB_USAGE_GUARD_APP: '/tmp/definitely-not-here' } });
  assert.deepEqual(missing, { ran: false, reason: 'app_missing' });
  assert.equal(usageGuardBinary({ SBB_USAGE_GUARD_APP: '/tmp/definitely-not-here' }), undefined);
});

test('quota: refreshQuota passes the read-only flags', async () => {
  const dir = tempDir();
  const app = join(dir, 'Fake Usage Guard.app', 'Contents', 'MacOS');
  mkdirSync(app, { recursive: true });
  const binary = join(app, 'EagerStudyUsageGuard');
  writeFileSync(binary, '#!/bin/sh\necho fake\n');
  chmodSync(binary, 0o755);

  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
  };
  const info = await refreshQuota({ run, env: { SBB_USAGE_GUARD_APP: join(dir, 'Fake Usage Guard.app') } });
  assert.equal(info.ran, true);
  assert.equal(info.ok, true);
  assert.deepEqual(calls[0].args, ['--read-once', '--no-ui', '--no-redeem']);
  assert.equal(calls[0].cmd, binary);
});

test('catalog: TOML reader handles top-level scalars only', () => {
  const parsed = parseTomlTopLevel([
    '# a comment',
    'model = "gpt-6-astra"',
    'model_catalog_json = "/tmp/catalog.json" # trailing comment',
    'suppress_unstable_features_warning = true',
    'some_number = 42',
    '[projects."/Users/dev"]',
    'model = "must-not-win"',
  ].join('\n'));
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.model_catalog_json, '/tmp/catalog.json');
  assert.equal(parsed.suppress_unstable_features_warning, true);
  assert.equal(parsed.some_number, 42);
});

test('catalog: codex models come from config.toml and the model catalog json', () => {
  const dir = tempDir();
  const codexDir = join(dir, 'codex');
  mkdirSync(codexDir, { recursive: true });
  const catalogPath = join(codexDir, 'models.json');
  writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: 'deepseek-v4-flash' }, { slug: 'deepseek-v4-pro' }] }));
  writeFileSync(join(codexDir, 'config.toml'), `model = "deepseek-v4-flash-vision-exp"\nmodel_catalog_json = "${catalogPath}"\n`);

  const config = readCodexConfig(codexDir);
  assert.equal(config.model, 'deepseek-v4-flash-vision-exp');
  assert.deepEqual(config.catalogModels, ['deepseek-v4-flash', 'deepseek-v4-pro']);

  const rows = catalog({
    accounts: [{ name: 'c', baseDir: dir, claudeDir: undefined, codexDir }],
    which: (name) => (name === 'codex' ? '/opt/homebrew/bin/codex' : undefined),
    env: { PATH: '' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cli, 'codex');
  assert.deepEqual(rows[0].models.map((m) => m.id), ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(rows[0].models[0].source, 'config.toml:model');
  assert.equal(rows[0].source, 'config.toml + model_catalog_json');
});

test('catalog: a CLI is listed only under accounts that have its config dir', () => {
  const dir = tempDir();
  const accounts = [
    {
      name: 'default', baseDir: '', claudeDir: join(dir, '.claude'), codexDir: join(dir, '.codex'),
      agyDir: join(dir, '.gemini'), cursorDir: join(dir, '.cursor'),
    },
    {
      name: 'b', baseDir: join(dir, '.ai-account-b'), claudeDir: join(dir, '.ai-account-b', 'claude'),
      codexDir: join(dir, '.ai-account-b', 'codex'), cursorDir: join(dir, '.ai-account-b', 'cursor-agent'),
    },
  ];
  for (const account of accounts) {
    for (const field of ['claudeDir', 'codexDir', 'agyDir', 'cursorDir']) {
      if (account[field]) mkdirSync(account[field], { recursive: true });
    }
  }
  writeFileSync(join(accounts[1].codexDir, 'config.toml'), 'model = "gpt-6-astra"\n');

  const all = catalog({
    accounts,
    which: () => '/usr/local/bin/fake',
    env: { PATH: '' },
  });
  const key = (r) => `${r.account}/${r.cli}`;
  assert.deepEqual(
    all.map(key).sort(),
    ['b/claude', 'b/codex', 'b/cursor', 'default/agy', 'default/claude', 'default/codex', 'default/cursor'],
  );
  assert.ok(all.find((r) => key(r) === 'default/claude').models.length === STATIC_MODELS.claude.length);
  assert.ok(all.find((r) => key(r) === 'b/claude').models.every((m) => m.source === 'static'));
  // No agy dir under b, so b gets no agy row; the source names the dir that produced it.
  assert.equal(all.find((r) => key(r) === 'b/agy'), undefined);
  assert.match(all.find((r) => key(r) === 'default/agy').source, /\.gemini\)$/);
  assert.match(all.find((r) => key(r) === 'b/cursor').source, /\.ai-account-b\/cursor-agent\)$/);

  const none = catalog({ accounts, which: () => undefined, env: { PATH: '' } });
  assert.deepEqual(none, []);
});

test('catalog: which finds executables on PATH only', () => {
  const dir = tempDir();
  const bin = join(dir, 'mycli');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'notexec'), 'text');
  assert.equal(which('mycli', { PATH: dir }), bin);
  assert.equal(which('notexec', { PATH: dir }), undefined);
  assert.equal(which('nope', { PATH: dir }), undefined);
  assert.equal(which('mycli', { PATH: '' }), undefined);
});

// codex default model: a spawn without --model runs the account's own top-level model
// from <CODEX_HOME>/config.toml, not whatever a project .codex/config.toml asks for
// (task m2/h1-codex-default-model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCodexDefaultModel } from '../src/lifecycle/launch.js';
import { spawnBrain } from '../src/lifecycle/spawn.js';
import { run } from '../src/cli/spawn.js';
import { createFakeTmux, tmuxCommands } from './fixtures/lifecycle/fake-tmux.js';
import { tempDir, withEnv } from './fixtures/registry/helpers.js';

const CWD = '/tmp/proj';

/** @param {string} body @param {{name?: string}} [opts] */
function codexHome(body, { name = 'a' } = {}) {
  const home = tempDir();
  const codexDir = join(home, 'codex');
  mkdirSync(codexDir, { recursive: true });
  if (body !== null) writeFileSync(join(codexDir, 'config.toml'), body);
  return { name, baseDir: home, claudeDir: join(home, 'claude'), codexDir };
}

test('readCodexDefaultModel: reads the top-level model and stops at the first section', () => {
  const account = codexHome([
    '# comment',
    'model = "deepseek-chat"',
    'approval_policy = "never"',
    '',
    '[projects."/tmp/proj"]',
    'trust_level = "trusted"',
    'model = "gpt-6-astra"',
    '',
  ].join('\n'));
  assert.deepEqual(readCodexDefaultModel({ dir: account.codexDir }), {
    configPath: join(account.codexDir, 'config.toml'),
    model: 'deepseek-chat',
  });
});

test('readCodexDefaultModel: no file or no top-level model means no default', () => {
  const missing = codexHome(null);
  assert.equal(readCodexDefaultModel({ dir: missing.codexDir }).model, undefined);
  assert.equal(readCodexDefaultModel({ dir: missing.codexDir }).detail, undefined, 'a missing file is not a warning');
  const sectionOnly = codexHome('[projects."/tmp/proj"]\nmodel = "gpt-6-astra"\n');
  assert.equal(readCodexDefaultModel({ dir: sectionOnly.codexDir }).model, undefined);
  const blank = codexHome('model = "   "\n');
  assert.equal(readCodexDefaultModel({ dir: blank.codexDir }).model, undefined);
});

test('readCodexDefaultModel: a config that exists but cannot be read is reported', () => {
  const result = readCodexDefaultModel({
    dir: '/tmp/nowhere',
    readFile: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; },
  });
  assert.equal(result.model, undefined);
  assert.match(result.detail, /cannot read \/tmp\/nowhere\/config\.toml: EACCES/);
});

// --- spawn integration ---------------------------------------------------------------

const PARENT = { id: 'SMS-0007', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude' };

/** @param {import('../src/types.js').Account} account @param {Record<string, any>} [over] */
function baseDeps(account, over = {}) {
  const tmuxApi = createFakeTmux();
  return {
    accounts: [account],
    listBrains: () => [],
    getBrain: (ref) => (ref === 'lead' ? PARENT : undefined),
    which: async () => true,
    readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 50 }],
    allocateId: () => 'SMS-0042',
    newUuid: () => 'uuid-42',
    tmuxApi,
    tmuxApiRef: tmuxApi,
    awaitReady: async () => ({ ready: true, session: { pid: 4242 } }),
    readCodexTrust: () => ({ configPath: join(account.codexDir, 'config.toml'), found: true, trusted: true, level: 'trusted' }),
    config: {},
    ...over,
  };
}

/** @param {Record<string, any>} [over] */
function codexInput(over = {}) {
  return { name: 'ios', role: 'main', account: 'a', cli: 'codex', cwd: CWD, ...over };
}

/** @param {Record<string, any>} deps @returns {string} the shell line tmux would run */
function shellLineOf(deps) {
  return tmuxCommands(deps.tmuxApiRef)[0][12]; // after new-window -t =sbb: -n .. -c .. -P -F #{pane_id} sh -c
}

test('spawnBrain: a codex spawn without --model uses the account model and records it', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const account = codexHome('model = "deepseek-chat"\n');
    const deps = baseDeps(account);
    const result = await spawnBrain(codexInput(), deps);

    assert.match(shellLineOf(deps), /codex -m deepseek-chat "\$\(cat .*\)"$/);
    assert.equal(result.model, 'deepseek-chat');
    assert.equal(result.modelSource, 'codex-config');
    const record = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0042.json'), 'utf8'));
    assert.equal(record.model, 'deepseek-chat');
  } finally {
    restore();
  }
});

test('spawnBrain: --model wins and the account config is not read', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const account = codexHome('model = "deepseek-chat"\n');
    let reads = 0;
    const deps = baseDeps(account, { readCodexDefaultModel: () => { reads += 1; return { model: 'deepseek-chat' }; } });
    const result = await spawnBrain(codexInput({ model: 'gpt-5' }), deps);

    assert.equal(reads, 0, 'an explicit --model needs no fallback');
    assert.match(shellLineOf(deps), /codex -m gpt-5 "\$\(cat .*\)"$/);
    assert.equal(result.model, 'gpt-5');
    assert.equal(result.modelSource, 'flag');
  } finally {
    restore();
  }
});

test('spawnBrain: a claude spawn never consults the codex config', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const account = codexHome('model = "deepseek-chat"\n');
    let reads = 0;
    const deps = baseDeps(account, { readCodexDefaultModel: () => { reads += 1; return {}; } });
    const result = await spawnBrain(codexInput({ cli: 'claude', model: undefined }), deps);

    assert.equal(reads, 0);
    assert.equal(result.model, null);
    assert.doesNotMatch(shellLineOf(deps), /-m |--model/);
  } finally {
    restore();
  }
});

test('spawnBrain: an unreadable config warns and still spawns without a model', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const account = codexHome('model = "deepseek-chat"\n');
    const warned = [];
    const deps = baseDeps(account, {
      readCodexDefaultModel: () => ({ configPath: '/x/config.toml', detail: 'cannot read /x/config.toml: EACCES' }),
      onWarn: (message) => warned.push(message),
    });
    const result = await spawnBrain(codexInput(), deps);

    assert.deepEqual(warned, ['cannot read /x/config.toml: EACCES']);
    assert.equal(result.model, null);
    assert.match(shellLineOf(deps), /codex "\$\(cat .*\)"$/, 'no model argument invented');
  } finally {
    restore();
  }
});

test('cli spawn: prints the model that will run', async () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    assert.equal(await run(['--name', 'ios', '--role', 'sub', '--parent', 'lead', '--account', 'a', '--cli', 'codex'], {
      spawnBrain: async () => ({
        brain: { id: 'SMS-0042', name: 'ios', coord: '24:3.4' },
        model: 'deepseek-chat',
        modelSource: 'codex-config',
      }),
    }), 0);
    assert.deepEqual(logged, ['spawned SMS-0042 ios 24:3.4', 'model     deepseek-chat (codex-config)']);
  } finally {
    console.log = originalLog;
  }
});

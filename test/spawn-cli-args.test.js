// spawn config defaults: ~/.sbb/config.json spawn.cliArgs[<cli>] is appended before
// explicit --cli-args and plan-node cliArgs (task m2/h1-spawn-defaults item 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeCliArgs, spawnBrain, spawnCliArgs } from '../src/lifecycle/spawn.js';
import { createFakeTmux, tmuxCommands } from './fixtures/lifecycle/fake-tmux.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const ACCOUNTS = [{
  name: 'a',
  baseDir: '/tmp/home/.ai-account-a',
  claudeDir: '/tmp/home/.ai-account-a/claude',
  codexDir: '/tmp/home/.ai-account-a/codex',
}];
const PARENT = { id: 'SMS-0007', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude' };

const CONFIG = {
  spawn: {
    cliArgs: {
      claude: '--permission-mode bypassPermissions',
      codex: '--sandbox danger-full-access -a never',
    },
  },
};

/** @param {Record<string, any>} [over] */
function baseDeps(over = {}) {
  const tmuxApi = createFakeTmux();
  return {
    accounts: ACCOUNTS,
    listBrains: () => [],
    getBrain: (ref) => (ref === 'lead' ? PARENT : undefined),
    which: async () => true,
    readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 50 }],
    allocateId: () => 'SMS-0042',
    newUuid: () => 'uuid-42',
    tmuxApi,
    awaitReady: async () => ({ ready: true, session: { pid: 4242 } }),
    resolve: async () => ({ address: 'lead', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' }),
    deliver: async () => ({ receipt: { status: 'delivered', via: 'uds', msgId: 'm1', elapsedMs: 1 } }),
    config: {},
    tmuxApiRef: tmuxApi,
    ...over,
  };
}

/** @param {Record<string, any>} [over] */
function spawnInput(over = {}) {
  return {
    name: 'ios', role: 'sub', parent: 'lead', account: 'a', cli: 'claude',
    model: 'claude-haiku-4-5-20251001', cwd: '/tmp/proj', ...over,
  };
}

/** @param {string} dir @param {unknown} body */
function writeConfig(dir, body) {
  writeFileSync(join(dir, 'config.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

test('spawnCliArgs: reads spawn.cliArgs[<cli>] from the raw config file', () => {
  const dir = tempDir();
  writeConfig(dir, CONFIG);
  assert.equal(spawnCliArgs('claude', { dir }), '--permission-mode bypassPermissions');
  assert.equal(spawnCliArgs('codex', { dir }), '--sandbox danger-full-access -a never');
  assert.equal(spawnCliArgs('agy', { dir }), undefined, 'a CLI without a default yields nothing');
});

test('spawnCliArgs: missing, unparseable or non-string config yields nothing', () => {
  const dir = tempDir();
  const warned = [];
  const onWarn = (message) => warned.push(message);
  assert.equal(spawnCliArgs('claude', { dir, onWarn }), undefined, 'no config.json is not an error');
  assert.deepEqual(warned, []);
  writeConfig(dir, '{ not json');
  assert.equal(spawnCliArgs('claude', { dir, onWarn }), undefined);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /cannot parse/);
  writeConfig(dir, { spawn: { cliArgs: { claude: '   ' } } });
  assert.equal(spawnCliArgs('claude', { dir }), undefined, 'blank is not a default');
  writeConfig(dir, { spawn: { cliArgs: { claude: ['--x'] } } });
  assert.equal(spawnCliArgs('claude', { dir }), undefined, 'only strings are accepted');
  writeConfig(dir, { machineTag: 'mbp' });
  assert.equal(spawnCliArgs('claude', { dir }), undefined, 'no spawn section');
});

test('mergeCliArgs: config defaults, then explicit args, then plan-node args', () => {
  assert.deepEqual(
    mergeCliArgs(['--permission-mode bypassPermissions', ['--add-dir', '/tmp/x'], '--model "haiku 4.5"']),
    ['--permission-mode', 'bypassPermissions', '--add-dir', '/tmp/x', '--model', 'haiku 4.5'],
  );
  assert.deepEqual(mergeCliArgs([undefined, null, '', []]), []);
});

test('spawnBrain: config defaults precede --cli-args and plan-node cliArgs', async () => {
  const dir = tempDir();
  writeConfig(dir, CONFIG);
  const restore = withEnv({ SBB_DIR: dir });
  try {
    writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' });
    const deps = baseDeps({ configDir: dir });
    const result = await spawnBrain(
      spawnInput({ extraArgs: '--verbose', cliArgs: ['--add-dir', '/tmp/plan'] }),
      deps,
    );

    assert.deepEqual(result.cliArgs, [
      '--permission-mode', 'bypassPermissions',
      '--verbose',
      '--add-dir', '/tmp/plan',
    ]);
    const shellLine = tmuxCommands(deps.tmuxApiRef)[0][10];
    const positions = result.cliArgs.map((arg) => shellLine.indexOf(` ${arg}`));
    assert.ok(positions.every((index) => index > 0), shellLine);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'args keep their order');
  } finally {
    restore();
  }
});

test('spawnBrain: no config and no explicit args sends no extra args', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' });
    const deps = baseDeps({ configDir: dir });
    const result = await spawnBrain(spawnInput(), deps);

    assert.deepEqual(result.cliArgs, []);
    const shellLine = tmuxCommands(deps.tmuxApiRef)[0][10];
    assert.match(shellLine, /--append-system-prompt-file \S+$/);
    assert.doesNotMatch(shellLine, /  /, 'no empty argument left behind');
  } finally {
    restore();
  }
});

test('spawnBrain: a codex default lands after the model flag', async () => {
  const dir = tempDir();
  writeConfig(dir, CONFIG);
  const restore = withEnv({ SBB_DIR: dir });
  try {
    writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', account: 'a', cli: 'codex', paneId: '%29', coord: '24:3.3' });
    const deps = baseDeps({
      configDir: dir,
      readCodexTrust: () => ({ configPath: '/tmp/home/.ai-account-a/codex/config.toml', found: true, trusted: true, level: 'trusted' }),
      resolve: async () => ({ address: 'lead', account: 'a', cli: 'codex', paneId: '%29', coord: '24:3.3' }),
    });
    const result = await spawnBrain(spawnInput({ cli: 'codex', model: 'gpt-5' }), deps);

    assert.deepEqual(result.cliArgs, ['--sandbox', 'danger-full-access', '-a', 'never']);
    const shellLine = tmuxCommands(deps.tmuxApiRef)[0][10];
    assert.match(shellLine, /codex -m gpt-5 "\$\(cat .*\)" --sandbox danger-full-access -a never$/);
  } finally {
    restore();
  }
});

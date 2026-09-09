// launch.js: per-CLI command lines, shell quoting, brief files and readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT_COMMANDS,
  awaitReady,
  buildCommand,
  prepareBrief,
  readCodexTrust,
  shellQuote,
  splitArgs,
} from '../src/lifecycle/launch.js';
import { createFakeTmux, screen, tmuxCommands, typedLiterals } from './fixtures/lifecycle/fake-tmux.js';

const execFileP = promisify(execFile);
const ACCOUNTS = [{ name: 'a', baseDir: '/tmp/home/.ai-account-a', claudeDir: '/tmp/home/.ai-account-a/claude', codexDir: '/tmp/home/.ai-account-a/codex' }];

/** @param {string} value @param {string} shell */
async function throughShell(value, shell) {
  const { stdout } = await execFileP(shell, ['-c', `printf %s ${shellQuote(value)}`]);
  return stdout;
}

test('buildCommand: claude reads the brief from its file and gets the account environment', () => {
  const built = buildCommand({
    cli: 'claude',
    model: 'claude-haiku-4-5-20251001',
    briefFile: '/tmp/briefs/SMS-0012.md',
    extraArgs: '--verbose --add-dir /tmp/x',
    account: 'a',
    name: 'ios',
    accounts: ACCOUNTS,
  });
  assert.deepEqual(built.argv, [
    'claude',
    '--model', 'claude-haiku-4-5-20251001',
    '--append-system-prompt-file', '/tmp/briefs/SMS-0012.md',
    '--verbose', '--add-dir', '/tmp/x',
  ]);
  assert.deepEqual(built.env, {
    CLAUDE_CONFIG_DIR: '/tmp/home/.ai-account-a/claude',
    CLAUDE_CODE_SESSION_NAME: 'ios',
  });
  assert.equal(
    built.shellLine,
    'exec env CLAUDE_CONFIG_DIR=/tmp/home/.ai-account-a/claude CLAUDE_CODE_SESSION_NAME=ios'
      + ' claude --model claude-haiku-4-5-20251001 --append-system-prompt-file /tmp/briefs/SMS-0012.md'
      + ' --verbose --add-dir /tmp/x',
  );
  assert.deepEqual(built.paneCommand, ['sh', '-c', built.shellLine], 'tmux runs the CLI directly');
  assert.ok(!/[\r\n]/.test(built.shellLine), 'the pane command stays one line');
});

test('buildCommand: codex gets -m, CODEX_HOME and $(cat <file>) as its first prompt', () => {
  const built = buildCommand({ cli: 'codex', model: 'gpt-6', briefFile: '/tmp/briefs/SMS-0042.md', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(built.argv, ['codex', '-m', 'gpt-6', '$(cat /tmp/briefs/SMS-0042.md)']);
  assert.deepEqual(built.env, { CODEX_HOME: '/tmp/home/.ai-account-a/codex' });
  assert.equal(
    built.shellLine,
    'exec env CODEX_HOME=/tmp/home/.ai-account-a/codex codex -m gpt-6 "$(cat /tmp/briefs/SMS-0042.md)"',
  );
});

test('buildCommand: agy and cursor read the brief through $(cat <file>) too', () => {
  const agy = buildCommand({ cli: 'agy', model: 'gemini-3-pro', briefFile: '/tmp/briefs/b.md', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(agy.argv, ['agy', '--model', 'gemini-3-pro', '--prompt-interactive', '$(cat /tmp/briefs/b.md)']);
  assert.deepEqual(agy.env, {});
  const cursor = buildCommand({ cli: 'cursor', briefFile: '/tmp/briefs/b.md', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(cursor.argv, ['cursor-agent', '$(cat /tmp/briefs/b.md)']);
  assert.match(cursor.shellLine, /^exec cursor-agent /, 'no env assignments means no env wrapper');
});

test('buildCommand: a brief file path with spaces survives as one argument', () => {
  const built = buildCommand({ cli: 'codex', briefFile: '/tmp/my briefs/b.md', account: 'a', accounts: ACCOUNTS });
  assert.equal(
    built.shellLine,
    'exec env CODEX_HOME=/tmp/home/.ai-account-a/codex codex "$(cat \'/tmp/my briefs/b.md\')"',
  );
});

test('buildCommand: an unknown cli, a missing brief file or account is refused, never guessed', () => {
  assert.throws(() => buildCommand({ cli: 'gpt', briefFile: '/x/b.md', account: 'a', accounts: ACCOUNTS }), /unknown cli/);
  assert.throws(() => buildCommand({ cli: 'claude', briefFile: '/x/b.md', account: 'zz', accounts: ACCOUNTS }), /unknown account/);
  assert.throws(() => buildCommand({ cli: 'claude', account: 'a', accounts: ACCOUNTS }), /briefFile is required/);
});

test('shellQuote: the quoted value survives a real shell byte for byte', async () => {
  const values = [
    'plain', 'with space', "it's", 'back\\slash', 'a$b`c', '中文 brief', 'tab\there',
    'line1\nline2', 'quote"inside', 'semi;colon', 'star*', '!history',
  ];
  for (const shell of ['bash', 'zsh']) {
    for (const value of values) {
      assert.equal(await throughShell(value, shell), value, `${shell} round-trip for ${JSON.stringify(value)}`);
    }
  }
});

test('shellQuote: control characters and newlines keep the command one line', () => {
  const quoted = shellQuote('a\nb\x07c');
  assert.match(quoted, /^\$'/);
  assert.ok(!/[\r\n]/.test(quoted));
  assert.equal(shellQuote(''), "''");
});

test('splitArgs: whitespace splits, quotes group', () => {
  assert.deepEqual(splitArgs('--a 1 --b two'), ['--a', '1', '--b', 'two']);
  assert.deepEqual(splitArgs('--msg "hello world" --x'), ['--msg', 'hello world', '--x']);
  assert.deepEqual(splitArgs(["--x", "y z"]), ['--x', 'y z']);
  assert.deepEqual(splitArgs(undefined), []);
});

test('prepareBrief: every brief goes to ~/.sbb/briefs/<id>.md, short or long', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-briefs-'));
  const short = prepareBrief({ id: 'SMS-0001', brief: '一行', dir });
  assert.deepEqual(short, { brief: '一行', file: join(dir, 'SMS-0001.md') });
  assert.equal(readFileSync(short.file, 'utf8'), '一行\n');

  const long = 'x'.repeat(20000);
  const big = prepareBrief({ id: 'SMS-0002', brief: long, dir });
  assert.equal(big.file, join(dir, 'SMS-0002.md'));
  assert.equal(readFileSync(big.file, 'utf8').length, 20001);
  assert.equal(big.brief, long);
});

test('awaitReady: claude is ready when a registry file names the pane', async () => {
  const tmuxApi = createFakeTmux();
  const result = await awaitReady(
    { cli: 'claude', paneId: '%30', account: 'a', name: 'ios', cwd: '/tmp/x' },
    {
      tmuxApi,
      timeoutMs: 5,
      pollMs: 1,
      sleep: async () => {},
      listSessions: () => [{ pid: 4242, tmux: '24:@16.%30', account: 'a', name: 'ios', status: 'idle' }],
    },
  );
  assert.equal(result.ready, true);
  assert.equal(result.session.pid, 4242);
});

test('awaitReady: claude reports the last screen when no session ever registers', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('claude-idle')] });
  const result = await awaitReady(
    { cli: 'claude', paneId: '%30', account: 'a' },
    { tmuxApi, timeoutMs: 5, pollMs: 1, sleep: async () => {}, listSessions: () => [] },
  );
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'not_ready');
  assert.match(result.screen, /bypass permissions/);
});

test('awaitReady: a registry read failure is reported in the detail', async () => {
  const tmuxApi = createFakeTmux();
  const result = await awaitReady(
    { cli: 'claude', paneId: '%30', account: 'a' },
    {
      tmuxApi,
      timeoutMs: 5,
      pollMs: 1,
      sleep: async () => {},
      listSessions: () => { throw new Error('registry unreadable'); },
    },
  );
  assert.equal(result.ready, false);
  assert.match(result.detail, /registry read failed: registry unreadable/);
});

test('awaitReady: codex needs the brief accepted or a thread written since the spawn', async () => {
  const started = Date.now();
  const tmuxApi = createFakeTmux({ screens: [screen('codex-busy'), screen('codex-idle')] });
  const notYet = await awaitReady(
    { cli: 'codex', paneId: '%30', account: 'a', cwd: '/tmp/proj' },
    { tmuxApi, timeoutMs: 5, pollMs: 1, sleep: async () => {}, listThreads: () => [] },
  );
  assert.equal(notYet.ready, false);

  const tmuxApi2 = createFakeTmux({ screens: [screen('codex-busy'), screen('codex-idle')] });
  const ready = await awaitReady(
    { cli: 'codex', paneId: '%30', account: 'a', cwd: '/tmp/proj/' },
    {
      tmuxApi: tmuxApi2,
      timeoutMs: 50,
      pollMs: 1,
      sleep: async () => {},
      listThreads: () => [{ id: 't1', account: 'a', cwd: '/tmp/proj', updatedAtMs: started, hasRollout: true }],
    },
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.thread.id, 't1');
});

test('awaitReady: a codex thread from before the spawn does not count', async () => {
  const tmuxApi = createFakeTmux({ screens: [screen('codex-idle')] });
  const result = await awaitReady(
    { cli: 'codex', paneId: '%30', account: 'a', cwd: '/tmp/proj' },
    {
      tmuxApi,
      timeoutMs: 5,
      pollMs: 1,
      sleep: async () => {},
      listThreads: () => [{ id: 'old', account: 'a', cwd: '/tmp/proj', updatedAtMs: Date.now() - 600000 }],
    },
  );
  assert.equal(result.ready, false);
});

test('awaitReady: agy and cursor only need an idle composer', async () => {
  for (const [cli, sample] of [['agy', 'agy-idle'], ['cursor', 'cursor-idle']]) {
    const tmuxApi = createFakeTmux({ screens: [screen(sample)] });
    const result = await awaitReady(
      { cli, paneId: '%30', account: 'a' },
      { tmuxApi, timeoutMs: 20, pollMs: 1, sleep: async () => {} },
    );
    assert.equal(result.ready, true, `${cli} should be ready on its idle composer`);
  }
});

test('awaitReady: a codex pane that echoes the brief is ready even while the turn runs', async () => {
  const brief = '你是 ios#SMS-0042，角色 子脑，上级 lead#SMS-0007，账户 a，CLI codex，模型 默认。';
  const tmuxApi = createFakeTmux({ screens: [`› ${brief}\n${screen('codex-busy')}`] });
  const result = await awaitReady(
    { cli: 'codex', paneId: '%30', account: 'a', cwd: '/tmp/proj', brief },
    { tmuxApi, timeoutMs: 50, pollMs: 1, sleep: async () => {}, listThreads: () => [] },
  );
  assert.equal(result.ready, true);
  assert.match(result.detail, /brief was accepted as the first turn/);
});

test('awaitReady: a blank or absent brief never proves acceptance', async () => {
  for (const brief of [undefined, '   ', '别的简报']) {
    const tmuxApi = createFakeTmux({ screens: [screen('codex-idle')] });
    const result = await awaitReady(
      { cli: 'codex', paneId: '%30', account: 'a', cwd: '/tmp/proj', brief },
      { tmuxApi, timeoutMs: 5, pollMs: 1, sleep: async () => {}, listThreads: () => [] },
    );
    assert.equal(result.ready, false, `brief ${JSON.stringify(brief)} must not count`);
  }
});

test('readCodexTrust: an exact trusted path only, subdirectories are not covered', () => {
  const toml = [
    '# comment',
    '[projects."/tmp/proj"]',
    'trust_level = "trusted"',
    '',
    '[projects."/tmp/proj/sub"]',
    'trust_level = "untrusted"',
  ].join('\n');
  const readFile = () => toml;
  const dir = '/tmp/home/.ai-account-a/codex';
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj', readFile }).trusted, true);
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj/', readFile }).trusted, true);
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj/sub', readFile }).trusted, false);
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj/sub', readFile }).level, 'untrusted');
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj/sub/deep', readFile }).trusted, false);
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/elsewhere', readFile }).trusted, false);
});

test('readCodexTrust: a missing CODEX_HOME or config.toml is not trusted, and says why', () => {
  assert.deepEqual(readCodexTrust({ cwd: '/tmp/proj' }), { configPath: undefined, found: false, trusted: false });
  const enoent = () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); };
  const missing = readCodexTrust({ dir: '/tmp/home/.ai-account-a/codex', cwd: '/tmp/proj', readFile: enoent });
  assert.equal(missing.trusted, false);
  assert.equal(missing.found, false);
  assert.match(missing.detail, /ENOENT/);
});

test('readCodexTrust: reads a real config.toml from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-codex-'));
  writeFileSync(join(dir, 'config.toml'), '[projects."/tmp/proj"]\ntrust_level = "trusted"\n');
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/proj' }).trusted, true);
  assert.equal(readCodexTrust({ dir, cwd: '/tmp/other' }).trusted, false);
});

test('EXIT_COMMANDS: every CLI with a known exit command is listed', () => {
  assert.deepEqual(EXIT_COMMANDS, { claude: '/exit', codex: '/quit', agy: '/quit', cursor: '/exit' });
  assert.equal(existsSync('/nonexistent'), false);
});

test('buildCommand: launcher settings add a preamble, replace the binary and pick the shell', () => {
  const built = buildCommand({
    cli: 'claude', briefFile: '/tmp/b.md', account: 'a', accounts: ACCOUNTS,
    preamble: 'source /Users/me/spxy.sh on', command: '/Users/me/bin/claude-launch', shell: '/bin/zsh',
    extraArgs: '--dangerously-skip-permissions',
  });
  assert.deepEqual(built.paneCommand, ['/bin/zsh', '-c', built.shellLine], 'the user shell runs the line');
  const [first, second] = built.shellLine.split('\n');
  assert.equal(first, 'source /Users/me/spxy.sh on', 'the preamble is its own statement');
  assert.equal(second, 'exec env CLAUDE_CONFIG_DIR=/tmp/home/.ai-account-a/claude /Users/me/bin/claude-launch --append-system-prompt-file /tmp/b.md --dangerously-skip-permissions');
  assert.equal(built.argv[0], '/Users/me/bin/claude-launch');

  const plain = buildCommand({ cli: 'claude', briefFile: '/tmp/b.md', account: 'a', accounts: ACCOUNTS, preamble: '  ', command: '', shell: '' });
  assert.deepEqual(plain.paneCommand, ['sh', '-c', plain.shellLine], 'blank settings mean the defaults');
  assert.ok(!plain.shellLine.includes('\n'));
  assert.throws(() => buildCommand({ cli: 'nope', briefFile: '/tmp/b.md', account: 'a', accounts: ACCOUNTS, command: 'x' }), /unknown cli/);
});

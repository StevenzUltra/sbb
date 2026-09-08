// launch.js: per-CLI command lines, shell quoting, brief files and readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIEF_FILE_LIMIT,
  EXIT_COMMANDS,
  awaitReady,
  buildCommand,
  prepareBrief,
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

test('buildCommand: claude gets --append-system-prompt and its account environment', () => {
  const built = buildCommand({
    cli: 'claude',
    model: 'claude-haiku-4-5-20251001',
    brief: '你是 ios#SMS-0012',
    extraArgs: '--verbose --add-dir /tmp/x',
    account: 'a',
    name: 'ios',
    accounts: ACCOUNTS,
  });
  assert.deepEqual(built.argv, [
    'claude',
    '--model', 'claude-haiku-4-5-20251001',
    '--append-system-prompt', '你是 ios#SMS-0012',
    '--verbose', '--add-dir', '/tmp/x',
  ]);
  assert.deepEqual(built.env, {
    CLAUDE_CONFIG_DIR: '/tmp/home/.ai-account-a/claude',
    CLAUDE_CODE_SESSION_NAME: 'ios',
  });
  assert.match(built.shellLine, /^exec env /);
  assert.ok(!/[\r\n]/.test(built.shellLine), 'the command line must stay one line for send-keys');
});

test('buildCommand: codex gets -m, CODEX_HOME and the brief as its first prompt', () => {
  const built = buildCommand({ cli: 'codex', model: 'gpt-6', brief: '简报', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(built.argv, ['codex', '-m', 'gpt-6', '简报']);
  assert.deepEqual(built.env, { CODEX_HOME: '/tmp/home/.ai-account-a/codex' });
  assert.match(built.shellLine, /^exec env CODEX_HOME=\/tmp\/home\/\.ai-account-a\/codex codex -m gpt-6 '简报'$/);
});

test('buildCommand: agy and cursor use their own prompt flags', () => {
  const agy = buildCommand({ cli: 'agy', model: 'gemini-3-pro', brief: '简报', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(agy.argv, ['agy', '--model', 'gemini-3-pro', '--prompt-interactive', '简报']);
  assert.deepEqual(agy.env, {});
  const cursor = buildCommand({ cli: 'cursor', brief: '简报', account: 'a', accounts: ACCOUNTS });
  assert.deepEqual(cursor.argv, ['cursor-agent', '简报']);
  assert.match(cursor.shellLine, /^exec cursor-agent /, 'no env assignments means no env wrapper');
});

test('buildCommand: an unknown cli or account is refused, never guessed', () => {
  assert.throws(() => buildCommand({ cli: 'gpt', account: 'a', accounts: ACCOUNTS }), /unknown cli/);
  assert.throws(() => buildCommand({ cli: 'claude', account: 'zz', accounts: ACCOUNTS }), /unknown account/);
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

test('prepareBrief: a short brief stays inline, a long one goes to ~/.sbb/briefs', () => {
  const short = prepareBrief({ id: 'SMS-0001', brief: '一行' });
  assert.deepEqual(short, { brief: '一行' });

  const dir = mkdtempSync(join(tmpdir(), 'sbb-briefs-'));
  const long = 'x'.repeat(BRIEF_FILE_LIMIT + 1);
  const prepared = prepareBrief({ id: 'SMS-0001', brief: long, dir });
  assert.equal(prepared.file, join(dir, 'SMS-0001.md'));
  assert.equal(readFileSync(prepared.file, 'utf8'), `${long}\n`);
  assert.equal(prepared.brief.split('\n').length, 2);
  assert.match(prepared.brief, /SMS-0001\.md/);
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

test('awaitReady: codex needs an idle composer and a thread written since the spawn', async () => {
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

test('EXIT_COMMANDS: every CLI with a known exit command is listed', () => {
  assert.deepEqual(EXIT_COMMANDS, { claude: '/exit', codex: '/quit', agy: '/quit', cursor: '/exit' });
  assert.equal(existsSync('/nonexistent'), false);
});

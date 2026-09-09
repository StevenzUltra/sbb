// Accounts: listing, creation under a temporary HOME only, and the generated wrapper's
// real behaviour (run with `env` so the exports are observed, not assumed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run as accountRun } from '../src/cli/account.js';
import { AccountError, accountAdd, accountList } from '../src/account/account.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const UNIQUE = `zz-${process.pid}-${Date.now().toString(36)}`;

function sbbEnv(home, extra = {}) {
  return { SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb'), TMUX_PANE: undefined, ...extra };
}

/**
 * Env for running a generated wrapper. `$TMUX`/`$TMUX_PANE` are dropped unless a test
 * passes them: an inherited server handle is what let the wrapper retag a real pane
 * (incident 2026-09-09).
 */
function wrapperEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return { ...env, ...extra };
}

// A scratch tmux server, so wrapper tests can exercise the real `tmux` binary without
// reaching the machine's server. $TMUX is built by hand because the wrapper calls plain
// `tmux` and resolves the server from that variable.
const HAS_TMUX = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const SCRATCH_SOCKET = `sbb-account-test-${process.pid}`;

function scratch(args) {
  return execFileSync('tmux', ['-L', SCRATCH_SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Start one detached scratch pane and return its id plus the $TMUX value that targets it. */
function scratchPane(session) {
  try {
    scratch(['kill-session', '-t', session]);
  } catch {
    // no such session
  }
  scratch(['new-session', '-d', '-s', session, '-x', '80', '-y', '20']);
  const pane = scratch(['list-panes', '-t', session, '-F', '#{pane_id}']).trim();
  const sock = scratch(['display-message', '-p', '#{socket_path}']).trim();
  const pid = scratch(['display-message', '-p', '#{pid}']).trim();
  const sid = scratch(['display-message', '-p', '#{session_id}']).trim();
  return { pane, tmux: `${sock},${pid},${sid}` };
}

/** Read one pane option from the scratch server; '' when unset. */
function scratchOption(pane, option) {
  try {
    return scratch(['show-options', '-p', '-t', pane, option]).trim().split(' ')[1] ?? '';
  } catch {
    return '';
  }
}

function killScratch() {
  try {
    scratch(['kill-server']);
  } catch {
    // already gone
  }
}

test('accountAdd creates dirs and a wrapper under the given HOME only', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const result = accountAdd(UNIQUE, { home });
    const base = join(home, `.ai-account-${UNIQUE}`);
    assert.equal(result.baseDir, base);
    assert.equal(statSync(base).mode & 0o777, 0o700);
    // One config dir per CLI, all 0700, mirroring ~/bin/ai-a's layout.
    for (const name of ['claude', 'codex', 'gemini', 'cursor-agent', 'kimi', 'grok']) {
      assert.equal(statSync(join(base, name)).mode & 0o777, 0o700, `${name} is 0700`);
    }
    assert.equal(result.claudeDir, join(base, 'claude'));
    assert.equal(result.codexDir, join(base, 'codex'));
    assert.equal(result.agyDir, join(base, 'gemini'));
    assert.equal(result.cursorDir, join(base, 'cursor-agent'));
    assert.equal(result.kimiDir, join(base, 'kimi'));
    assert.equal(result.grokDir, join(base, 'grok'));
    assert.equal(result.wrapper, join(home, 'bin', `ai-${UNIQUE}`));
    assert.equal(statSync(result.wrapper).mode & 0o777, 0o700);

    const wrapper = readFileSync(result.wrapper, 'utf8');
    assert.match(wrapper, new RegExp(`BASE="\\$HOME/\\.ai-account-${UNIQUE}"`));
    assert.match(wrapper, /export CODEX_HOME="\$CODEX_DIR"/);
    assert.match(wrapper, /export CLAUDE_CONFIG_DIR="\$CLAUDE_DIR"/);
    assert.match(wrapper, /export GROK_HOME="\$GROK_DIR"/);
    assert.match(wrapper, /export CURSOR_CONFIG_DIR="\$CURSOR_DIR"/);
    assert.match(wrapper, /export CURSOR_DATA_DIR="\$CURSOR_DIR"/);
    assert.match(wrapper, /export KIMI_CODE_HOME="\$KIMI_DIR"/);
    assert.match(wrapper, new RegExp(`@ai_account "${UNIQUE.toUpperCase()}"`));
    assert.match(wrapper, /cli_auth_credentials_store = "file"/);
    assert.match(wrapper, new RegExp(`usage: ai-${UNIQUE} \\{codex\\|claude\\|grok\\|cursor\\|kimi\\|shell\\|env\\}`));
    assert.ok(!wrapper.includes('__NAME__') && !wrapper.includes('__TAG__'), 'placeholders are substituted');

    // Run the generated wrapper for real: `env` prints the two config dirs it exports.
    // No $TMUX_PANE in this env, so the wrapper must not tag anything (the test below
    // pins that against a scratch tmux server).
    const printed = execFileSync('bash', [result.wrapper, 'env'], { env: wrapperEnv(home), encoding: 'utf8' });
    assert.match(printed, new RegExp(`export CODEX_HOME="${base}/codex"`));
    assert.match(printed, new RegExp(`export CLAUDE_CONFIG_DIR="${base}/claude"`));
    assert.match(printed, new RegExp(`export GROK_HOME="${base}/grok"`));
    assert.match(printed, new RegExp(`export CURSOR_CONFIG_DIR="${base}/cursor-agent"`));
    assert.match(printed, new RegExp(`export CURSOR_DATA_DIR="${base}/cursor-agent"`));
    assert.match(printed, new RegExp(`export KIMI_CODE_HOME="${base}/kimi"`));
    assert.ok(existsSync(join(base, 'codex', 'config.toml')), 'the wrapper writes the codex config');

    // Nothing was created outside the injected HOME.
    assert.ok(!existsSync(join(homedir(), `.ai-account-${UNIQUE}`)), 'the real HOME is untouched');
    assert.ok(!existsSync(join(homedir(), 'bin', `ai-${UNIQUE}`)), 'no wrapper in the real ~/bin');
  } finally {
    restore();
  }
});

test('accountAdd refuses an existing account unless forced, and rejects bad names', () => {
  const home = tempDir();
  try {
    accountAdd(UNIQUE, { home });
    assert.throws(() => accountAdd(UNIQUE, { home }), AccountError);
    assert.throws(() => accountAdd(UNIQUE, { home }), /already exists/);
    const forced = accountAdd(UNIQUE, { home, force: true });
    assert.equal(forced.replaced, true);
    assert.throws(() => accountAdd('Bad Name', { home }), /invalid account name/);
    assert.throws(() => accountAdd('', { home }), AccountError);
  } finally {
    // no env change needed: every path came from the `home` option
  }
});

test('accountList reports per-CLI login state (keychain included) and live brain counts', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const alphaBase = join(home, '.ai-account-alpha');
    mkdirSync(join(alphaBase, 'claude'), { recursive: true });
    mkdirSync(join(alphaBase, 'codex'), { recursive: true });
    mkdirSync(join(alphaBase, 'gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(join(alphaBase, 'cursor-agent'), { recursive: true });
    mkdirSync(join(alphaBase, 'kimi', 'credentials'), { recursive: true });
    mkdirSync(join(alphaBase, 'grok'), { recursive: true });
    writeFileSync(join(alphaBase, 'claude', '.credentials.json'), '{}');
    writeFileSync(join(alphaBase, 'codex', 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    writeFileSync(join(alphaBase, 'gemini', 'antigravity-cli', 'antigravity-oauth-token'), '{}');
    writeFileSync(join(alphaBase, 'cursor-agent', 'auth.json'), '{}');
    writeFileSync(join(alphaBase, 'kimi', 'credentials', 'kimi-code.json'), '{}');
    writeFileSync(join(alphaBase, 'grok', 'auth.json'), '{}');
    mkdirSync(join(home, '.ai-account-beta', 'claude'), { recursive: true });
    // beta's claude login lives in the keychain: no .credentials.json, but a config exists.
    writeFileSync(join(home, '.ai-account-beta', 'claude', '.claude.json'), '{}');

    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'alpha' });
    writeBrain({ id: 'TST-0002', name: 'sub-a', role: 'sub', parent: 'TST-0001', account: 'alpha' });
    writeBrain({ id: 'TST-0003', name: 'lead-b', role: 'main', parent: null, account: 'beta' });

    const rows = accountList({ home });
    const alpha = rows.find((r) => r.name === 'alpha');
    assert.equal(alpha.hasClaudeCreds, true);
    assert.equal(alpha.hasAgyCreds, true);
    assert.equal(alpha.hasCursorCreds, true);
    assert.equal(alpha.hasKimiCreds, true);
    assert.equal(alpha.hasGrokCreds, true);
    // config.toml is written by the generated wrapper, so it is not login evidence.
    assert.equal(alpha.hasCodexCreds, false);
    assert.equal(alpha.agyDir, join(alphaBase, 'gemini'));
    assert.equal(alpha.cursorDir, join(alphaBase, 'cursor-agent'));
    assert.equal(alpha.kimiDir, join(alphaBase, 'kimi'));
    assert.equal(alpha.grokDir, join(alphaBase, 'grok'));
    assert.deepEqual(alpha.brains, ['lead-a', 'sub-a']);
    assert.equal(alpha.wrapper, join(home, 'bin', 'ai-alpha'));
    const beta = rows.find((r) => r.name === 'beta');
    assert.equal(beta.hasClaudeCreds, true, 'keychain login counts once a config exists');
    assert.equal(beta.agyDir, undefined, 'dirs that do not exist are not invented');
    assert.deepEqual(beta.brains, ['lead-b']);
  } finally {
    restore();
  }
});

test('sbb account add/ls through the CLI', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const added = await captureLog(() => accountRun(['add', UNIQUE], { home }));
    assert.equal(added.result, 0);
    const text = added.lines.join('\n');
    assert.match(text, new RegExp(`account ${UNIQUE} ready`));
    assert.match(text, new RegExp(`next: log in once with \`ai-${UNIQUE} <cli>\``));
    for (const dir of ['claude', 'codex', 'gemini', 'cursor-agent', 'kimi', 'grok']) {
      assert.match(text, new RegExp(`${UNIQUE}/${dir}`), `add prints the ${dir} dir`);
    }
    assert.ok(existsSync(join(home, `.ai-account-${UNIQUE}`)));

    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: UNIQUE });
    const listed = await captureLog(() => accountRun(['ls'], { home }));
    assert.equal(listed.result, 0);
    // One column per CLI, then BRAINS and WRAPPER (src/cli/account.js).
    assert.match(listed.lines.join('\n'), new RegExp(`${UNIQUE}\\s+no\\s+no\\s+no\\s+no\\s+no\\s+no\\s+1\\s+.*ai-${UNIQUE}`));

    const bad = await captureLog(() => accountRun(['add', 'Bad Name'], { home }));
    assert.equal(bad.result, 2);
    const usage = await captureLog(() => accountRun(['--help'], { home }));
    assert.equal(usage.result, 0);
    assert.match(usage.lines.join('\n'), /usage: sbb account/);
  } finally {
    restore();
  }
});

test('the generated wrapper tags only the pane tmux handed it', { skip: !HAS_TMUX }, () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const result = accountAdd(UNIQUE, { home });
    const target = scratchPane(`wrap-${process.pid}`);
    const printed = execFileSync('bash', [result.wrapper, 'env'], {
      env: wrapperEnv(home, { TMUX: target.tmux, TMUX_PANE: target.pane }),
      encoding: 'utf8',
    });
    assert.match(printed, new RegExp(`export CODEX_HOME="${home}/\\.ai-account-${UNIQUE}/codex"`));

    assert.equal(scratchOption(target.pane, '@ai_account'), UNIQUE.toUpperCase());
    assert.equal(scratchOption(target.pane, '@codex_home'), `${home}/.ai-account-${UNIQUE}/codex`);
    assert.match(scratchOption(target.pane, '@ai_pane_pid'), /^\d+$/, 'the owner pid is stamped');
  } finally {
    restore();
    killScratch();
  }
});

test('the wrapper never touches tmux when TMUX_PANE is missing (incident 2026-09-09)', { skip: !HAS_TMUX }, () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  const log = join(home, 'tmux-calls.log');
  try {
    const result = accountAdd(UNIQUE, { home });
    const target = scratchPane(`nowrap-${process.pid}`);

    // Count invocations with a shell function, so "no tmux call" is observed, not inferred.
    const printed = execFileSync(
      'bash',
      ['-c', 'tmux() { printf "%s\\n" "$*" >> "$SBB_TEST_TMUX_LOG"; }; . "$1" env', 'bash', result.wrapper],
      { env: wrapperEnv(home, { TMUX: target.tmux, SBB_TEST_TMUX_LOG: log }), encoding: 'utf8' },
    );
    assert.match(printed, /export CODEX_HOME=/);
    assert.equal(existsSync(log), false, 'the wrapper invoked tmux without a pane to tag');

    // And the same run against a real (scratch) server leaves its pane untouched: this is
    // the incident's shape, where the old template retagged the server's current pane.
    execFileSync('bash', [result.wrapper, 'env'], {
      env: wrapperEnv(home, { TMUX: target.tmux }),
      encoding: 'utf8',
    });
    assert.equal(scratchOption(target.pane, '@ai_account'), '', 'no pane was retagged');
    assert.equal(scratchOption(target.pane, '@codex_home'), '');
  } finally {
    restore();
    killScratch();
  }
});

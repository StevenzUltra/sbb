// Per-CLI launch command lines and readiness detection. docs/spec/lifecycle.md
// sections "sbb spawn" steps 4-5. Command building is pure; readiness polls injected
// APIs (tmux, the Claude session registry, the Codex thread registry).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountByName, discoverAccounts, sbbDir } from '../lib/paths.js';
import * as tmuxLib from '../lib/tmux.js';
import { listClaudeSessions } from '../registry/claude-sessions.js';
import { listCodexThreads } from '../registry/codex-threads.js';
import { collapse, profileFor, probeOf } from '../transports/cli-profiles.js';

/** A brief longer than this goes to a file; the pane gets a two-line pointer instead. */
export const BRIEF_FILE_LIMIT = 6000;
export const DEFAULT_READY_TIMEOUT_MS = 60000;
export const DEFAULT_READY_POLL_MS = 1000;
/** Grace period for a Codex thread's `updated_at_ms` against clock skew. */
export const THREAD_MTIME_SLACK_MS = 5000;

/** The binary each CLI is launched with. `cursor` runs `cursor-agent`. */
export const CLI_BINARIES = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  agy: 'agy',
  cursor: 'cursor-agent',
});

/**
 * Each CLI's own exit command, typed into an idle composer by `sbb kill`.
 * Measured on scratch panes 2026-09-09 (docs/reports/m2-h1-2026-09-09.md): claude and
 * cursor accept `/exit`, codex and agy accept `/quit`. `other` has none.
 */
export const EXIT_COMMANDS = Object.freeze({
  claude: '/exit',
  codex: '/quit',
  agy: '/quit',
  cursor: '/exit',
});

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Characters that need no shell quoting at all. */
const PLAIN_RE = /^[A-Za-z0-9@%_+=:,./-]+$/;
/** Control characters a one-line command cannot carry literally. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Quote one shell argument. A value with newlines or control characters uses ANSI-C
 * quoting (`$'...'`) so the whole command line stays a single line: `tmux send-keys -l`
 * would otherwise submit the line at the first embedded newline.
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  if (PLAIN_RE.test(text)) return text;
  if (!CONTROL_RE.test(text) && !/[\r\n\t]/.test(text)) {
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `$'${escaped}'`;
}

/**
 * Split `--cli-args` text on whitespace, honouring single and double quotes.
 * @param {string|string[]|undefined} input
 * @returns {string[]}
 */
export function splitArgs(input) {
  if (Array.isArray(input)) return input.map(String);
  const text = String(input ?? '');
  /** @type {string[]} */
  const out = [];
  let current = '';
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/**
 * Resolve an account name (or record) to its Account. Throws for an unknown name.
 * @param {string|import('../types.js').Account} account
 * @param {import('../types.js').Account[]} [accounts]
 */
export function resolveAccount(account, accounts) {
  if (account && typeof account === 'object') return account;
  const name = String(account ?? '').toLowerCase();
  const found = (accounts ?? discoverAccounts()).find((a) => a.name === name);
  if (!found) throw new Error(`unknown account "${account}"`);
  return found;
}

/**
 * Write a long brief to ~/.sbb/briefs/<id>.md and return the two-line pointer the pane
 * gets instead of the full text.
 * @param {{ id: string, brief: string, dir?: string, limit?: number }} input
 * @returns {{ brief: string, file?: string }}
 */
export function prepareBrief({ id, brief, dir, limit = BRIEF_FILE_LIMIT }) {
  const text = String(brief ?? '');
  if (text.length <= limit) return { brief: text };
  const target = dir ?? join(sbbDir(), 'briefs');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const file = join(target, `${id}.md`);
  writeFileSync(file, `${text}\n`, { mode: 0o600 });
  return { brief: `简报文件：${file}\n先读该文件再开始工作。`, file };
}

/**
 * Build the command that starts one CLI in a fresh pane.
 * @param {{ cli: import('../types.js').CliKind, model?: string, brief?: string,
 *           extraArgs?: string|string[], account: string|import('../types.js').Account,
 *           name?: string, accounts?: import('../types.js').Account[] }} input
 * @returns {{ env: Record<string,string>, argv: string[], shellLine: string }}
 */
export function buildCommand({ cli, model, brief, extraArgs, account, name, accounts } = {}) {
  const binary = CLI_BINARIES[cli];
  if (!binary) throw new Error(`unknown cli "${cli}"`);
  const acct = resolveAccount(account, accounts);

  /** @type {Record<string,string>} */
  const env = {};
  if (cli === 'claude') {
    if (acct.claudeDir) env.CLAUDE_CONFIG_DIR = acct.claudeDir;
    if (name) env.CLAUDE_CODE_SESSION_NAME = name;
  } else if (cli === 'codex' && acct.codexDir) {
    env.CODEX_HOME = acct.codexDir;
  }

  const extra = splitArgs(extraArgs);
  /** @type {string[]} */
  const argv = [binary];
  if (model) {
    if (cli === 'codex') argv.push('-m', model);
    else argv.push('--model', model);
  }
  if (brief) {
    if (cli === 'claude') argv.push('--append-system-prompt', brief);
    else if (cli === 'agy') argv.push('--prompt-interactive', brief);
    else argv.push(brief); // codex and cursor take the brief as their first prompt
  }
  argv.push(...extra);

  const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
  const shellLine = ['exec', ...(assignments.length ? ['env', ...assignments] : []), ...argv.map(shellQuote)].join(' ');
  return { env, argv, shellLine };
}

/**
 * tmux's own key for a pane, in the shape the Claude session registry stores
 * (`session:@windowId.%paneId`, see registry/claude-sessions.js `paneTmuxKey`).
 * @param {typeof tmuxLib} tmuxApi
 * @param {string} paneId
 * @returns {Promise<string>}
 */
async function paneRegistryKey(tmuxApi, paneId) {
  return tmuxApi.tmux(['display-message', '-p', '-t', paneId, '#{session_name}:#{window_id}.#{pane_id}']);
}

/** @param {string|undefined} path */
function normCwd(path) {
  return String(path ?? '').replace(/\/+$/, '');
}

/** The only `trust_level` that lets `sbb spawn` start Codex in a directory. */
export const CODEX_TRUSTED_LEVEL = 'trusted';

/**
 * Read one account's Codex directory trust for `cwd` from `<CODEX_HOME>/config.toml`
 * (`[projects."<cwd>"] trust_level = "..."`). Codex trusts exact paths only, so a
 * trusted parent directory does not cover a subdirectory. A missing file or a missing
 * section is reported as not trusted, never guessed.
 * @param {{ dir?: string, cwd?: string, readFile?: (path: string, enc: string) => string }} [input]
 * @returns {{ configPath?: string, found: boolean, trusted: boolean, level?: string, detail?: string }}
 */
export function readCodexTrust({ dir, cwd, readFile = readFileSync } = {}) {
  const configPath = dir ? join(dir, 'config.toml') : undefined;
  if (!configPath) return { configPath, found: false, trusted: false };
  let raw;
  try {
    raw = readFile(configPath, 'utf8');
  } catch (err) {
    return { configPath, found: false, trusted: false, detail: `cannot read ${configPath}: ${err?.code ?? err?.message ?? err}` };
  }
  const wanted = normCwd(cwd);
  let section = null;
  let level;
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (!section) continue;
    const project = /^projects\."(.*)"$/.exec(section);
    if (!project || normCwd(project[1]) !== wanted) continue;
    const match = /^\s*trust_level\s*=\s*["']([^"']*)["']/.exec(line);
    if (match) level = match[1];
  }
  return { configPath, found: true, level, trusted: level === CODEX_TRUSTED_LEVEL };
}

/**
 * Codex readiness: the first turn has been accepted. The pane echoes the brief back on a
 * `›` line (as the submitted first prompt) or in the composer, so the brief's own text is
 * the proof that Codex took it. A blank brief proves nothing and never counts.
 * @param {string|undefined} screen
 * @param {string|undefined} brief
 */
export function briefAccepted(screen, brief) {
  const probe = probeOf(brief);
  if (!probe) return false;
  return collapse(screen).includes(probe);
}

/**
 * Wait until the spawned CLI is ready to receive work.
 * Claude: a registry file whose `tmux` names the new pane. Codex: the brief has been
 * accepted (its `›` line is on screen) or a thread row for the pane's cwd was written
 * since the spawn started. agy / cursor: an idle composer. Never reports ready from a
 * screen it could not read.
 *
 * @param {{ cli: import('../types.js').CliKind, paneId: string,
 *           account?: string, name?: string, cwd?: string, brief?: string }} input
 * @param {{ timeoutMs?: number, pollMs?: number, tmuxApi?: typeof tmuxLib,
 *           listSessions?: Function, listThreads?: Function,
 *           accounts?: import('../types.js').Account[],
 *           sleep?: (ms: number) => Promise<void>, now?: () => number }} [deps]
 * @returns {Promise<{ ready: boolean, reason?: string, detail?: string, screen?: string,
 *                     session?: import('../types.js').ClaudeSession,
 *                     thread?: import('../types.js').CodexThread }>}
 */
export async function awaitReady({ cli, paneId, account, name, cwd, brief } = {}, deps = {}) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_READY_POLL_MS;
  const tmuxApi = deps.tmuxApi ?? tmuxLib;
  const listSessions = deps.listSessions ?? listClaudeSessions;
  const listThreads = deps.listThreads ?? listCodexThreads;
  const accounts = deps.accounts;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const profile = profileFor(cli);
  const wantedCwd = normCwd(cwd);

  let key;
  if (cli === 'claude') {
    try {
      key = await paneRegistryKey(tmuxApi, paneId);
    } catch (err) {
      return { ready: false, reason: 'pane_gone', detail: `cannot read pane key: ${err?.message ?? err}` };
    }
  }

  const deadline = now() + timeoutMs;
  let screen;
  let registryError;
  for (;;) {
    try {
      if (cli === 'claude') {
        const session = listSessions(accounts).find(
          (s) => s.tmux === key && (!account || s.account === account) && (!name || !s.name || s.name === name),
        );
        if (session) return { ready: true, session };
      } else if (cli === 'codex') {
        screen = await tmuxApi.capturePane(paneId, 60);
        if (briefAccepted(screen, brief)) {
          return { ready: true, screen, detail: 'the brief was accepted as the first turn' };
        }
        const thread = listThreads(accounts).find(
          (t) => (!account || t.account === account)
            && normCwd(t.cwd) === wantedCwd
            && t.updatedAtMs >= startedAt - THREAD_MTIME_SLACK_MS,
        );
        if (thread) return { ready: true, thread, screen };
      } else {
        screen = await tmuxApi.capturePane(paneId, 60);
        if (profile.idle(screen)) return { ready: true, screen };
      }
    } catch (err) {
      // A registry read failure is reported, never treated as "not ready yet" silently.
      registryError = err;
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }

  if (screen === undefined) {
    try {
      screen = await tmuxApi.capturePane(paneId, 60);
    } catch {
      screen = undefined;
    }
  }
  const lines = String(screen ?? '').split('\n').slice(-12).join('\n');
  const detail = registryError
    ? `registry read failed: ${registryError.message ?? registryError}`
    : `not ready within ${timeoutMs}ms`;
  return { ready: false, reason: 'not_ready', detail, screen: lines };
}

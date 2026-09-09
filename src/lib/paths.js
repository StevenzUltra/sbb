// Account discovery and well-known paths. Pure functions over the filesystem; no caching.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {import('../types.js').Account} Account */

export function homeDir() {
  return process.env.SBB_HOME_OVERRIDE || homedir();
}

/** Root of SBB's own state. */
export function sbbDir() {
  return process.env.SBB_DIR || join(homeDir(), '.sbb');
}

export function brainsDir() {
  return join(sbbDir(), 'brains');
}

/** Directory where Claude Code sessions publish their Unix sockets. */
export function claudeSocksDir() {
  const uid = process.getuid?.() ?? 0;
  return uid === 0 ? '/tmp/cc-socks' : `/tmp/cc-socks-${uid}`;
}

/**
 * Claude Code writes sockets to /tmp/cc-socks/ for the primary dir and falls back to
 * /tmp/cc-socks-<uid>/. Both must be checked when locating a peer socket.
 */
export function claudeSocksDirs() {
  return ['/tmp/cc-socks', claudeSocksDir()].filter((d, i, a) => a.indexOf(d) === i);
}

/**
 * CLI -> the Account field that holds its config dir. One table, so discovery, the
 * catalog and `launch.js` cannot drift apart.
 */
export const CLI_DIR_FIELD = Object.freeze({
  claude: 'claudeDir',
  codex: 'codexDir',
  agy: 'agyDir',
  cursor: 'cursorDir',
  kimi: 'kimiDir',
  grok: 'grokDir',
});

/**
 * CLI -> directory name under `~/.ai-account-<name>/`. Mirrors the user's own
 * `~/bin/ai-a`: claude/codex/grok plus cursor-agent (config+data) and kimi.
 */
export const ACCOUNT_CLI_DIRS = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  agy: 'gemini',
  cursor: 'cursor-agent',
  kimi: 'kimi',
  grok: 'grok',
});

/** CLI -> directory name under HOME, used by the 'default' account. */
export const DEFAULT_CLI_DIRS = Object.freeze({
  claude: '.claude',
  codex: '.codex',
  agy: '.gemini',
  cursor: '.cursor',
  kimi: '.kimi-code',
  grok: '.grok',
});

/**
 * Discover accounts: 'default' (the global dirs under HOME) plus every
 * ~/.ai-account-<name>. An account is listed when at least one CLI dir exists; the
 * Account carries only the dirs that are really there.
 * @returns {Account[]}
 */
export function discoverAccounts() {
  const home = homeDir();
  /** @type {Account[]} */
  const out = [];
  /** @param {string} baseDir @param {Record<string,string>} layout */
  const probe = (baseDir, layout) => {
    /** @type {Record<string,string>} */
    const found = {};
    for (const [cli, field] of Object.entries(CLI_DIR_FIELD)) {
      const dir = join(baseDir, layout[cli]);
      if (existsSync(dir)) found[field] = dir;
    }
    return found;
  };
  /** @param {string} name @param {string} baseDir @param {Record<string,string>} found */
  const push = (name, baseDir, found) => {
    if (Object.keys(found).length) out.push({ name, baseDir, ...found });
  };
  push('default', '', probe(home, DEFAULT_CLI_DIRS));
  let entries = [];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.ai-account-')) continue;
    const name = e.name.slice('.ai-account-'.length);
    if (!name) continue;
    const base = join(home, e.name);
    push(name, base, probe(base, ACCOUNT_CLI_DIRS));
  }
  return out;
}

/** @param {string} name */
export function accountByName(name) {
  const n = String(name).toLowerCase();
  return discoverAccounts().find((a) => a.name === n);
}

/** Normalise the tmux @ai_account tag ('A', 'B', '' or undefined) to an account name. */
export function accountFromPaneTag(tag) {
  const t = (tag ?? '').trim().toLowerCase();
  return t === '' ? 'default' : t;
}

/** @param {Account} account */
export function claudeSessionsDir(account) {
  return account.claudeDir ? join(account.claudeDir, 'sessions') : undefined;
}

/** Path of Usage Guard's SQLite history. */
export function usageGuardDb() {
  return join(homeDir(), 'Library', 'Application Support', 'com.eagerstudy.usage-guard', 'usage.sqlite');
}

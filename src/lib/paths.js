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
 * Discover accounts: 'default' (~/.claude, ~/.codex) plus every ~/.ai-account-<name>.
 * An account is listed when at least one of its claude/codex dirs exists.
 * @returns {Account[]}
 */
export function discoverAccounts() {
  const home = homeDir();
  /** @type {Account[]} */
  const out = [];
  const push = (name, baseDir, claudeDir, codexDir) => {
    const c = existsSync(claudeDir) ? claudeDir : undefined;
    const x = existsSync(codexDir) ? codexDir : undefined;
    if (c || x) out.push({ name, baseDir, claudeDir: c, codexDir: x });
  };
  push('default', '', join(home, '.claude'), join(home, '.codex'));
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
    push(name, base, join(base, 'claude'), join(base, 'codex'));
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

// Live Claude Code sessions, read from every account's <claudeDir>/sessions/.
// Read-only. A registry entry counts as live only when its pid is alive.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSessionsDir, discoverAccounts } from '../lib/paths.js';

/** @typedef {import('../types.js').ClaudeSession} ClaudeSession */
/** @typedef {import('../types.js').Account} Account */

/**
 * @param {number} pid
 * @returns {boolean} EPERM counts as alive (another user's process, same machine).
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * The <pid>.<64hex>.key file next to a session registry file.
 * @param {string} dir
 * @param {number} pid
 * @returns {string|undefined}
 */
export function findKeyFile(dir, pid) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const matches = files.filter((f) => f.startsWith(`${pid}.`) && f.endsWith('.key')).sort();
  return matches.length ? join(dir, matches[0]) : undefined;
}

/**
 * tmux match key for a pane: the session registry stores `session:@windowId.%paneId`.
 * @param {import('../types.js').Pane} pane
 */
export function paneTmuxKey(pane) {
  return `${pane.session}:${pane.windowId}.${pane.paneId}`;
}

/**
 * @param {Account[]} [accounts]
 * @returns {ClaudeSession[]}
 */
export function listClaudeSessions(accounts = discoverAccounts()) {
  /** @type {ClaudeSession[]} */
  const out = [];
  for (const account of accounts) {
    const dir = claudeSessionsDir(account);
    if (!dir || !existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue; // half-written registry file; it is not a session
      }
      const pid = Number(raw.pid ?? file.replace(/\.json$/, ''));
      if (!isAlive(pid)) continue;
      out.push({
        pid,
        sessionId: raw.sessionId,
        cwd: raw.cwd,
        name: raw.name,
        status: raw.status,
        tmux: raw.tmux,
        sock: raw.messagingSocketPath,
        keyFile: findKeyFile(dir, pid),
        peerProtocol: raw.peerProtocol,
        peerFeatures: Array.isArray(raw.peerFeatures) ? raw.peerFeatures : [],
        account: account.name,
        version: raw.version,
      });
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

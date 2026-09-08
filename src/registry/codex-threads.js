// Codex threads, read from every account's <codexDir>/state_5.sqlite.
// Opened read-only with node:sqlite; SBB never writes into a CODEX_HOME.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverAccounts } from '../lib/paths.js';

/** @typedef {import('../types.js').CodexThread} CodexThread */
/** @typedef {import('../types.js').Account} Account */

/** Raised when a CODEX_HOME state database cannot be read. Never silently ignored. */
export class CodexRegistryError extends Error {
  /**
   * @param {string} message
   * @param {{ account?: string, dbPath?: string, cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'CodexRegistryError';
    this.account = info.account;
    this.dbPath = info.dbPath;
    this.cause = info.cause;
  }
}

/** @param {Account} account @returns {string|undefined} */
export function codexStateDb(account) {
  return account.codexDir ? join(account.codexDir, 'state_5.sqlite') : undefined;
}

/** Epoch ms from the `_ms` column when present, else from the seconds column. */
function msOf(ms, seconds) {
  const value = Number(ms);
  if (Number.isFinite(value)) return value;
  const fromSeconds = Number(seconds) * 1000;
  return Number.isFinite(fromSeconds) ? fromSeconds : 0;
}

/**
 * @param {Account[]} [accounts]
 * @returns {CodexThread[]} newest first per account.
 * @throws {CodexRegistryError} when a state database exists but cannot be read.
 */
export function listCodexThreads(accounts = discoverAccounts()) {
  /** @type {CodexThread[]} */
  const out = [];
  for (const account of accounts) {
    const dbPath = codexStateDb(account);
    if (!dbPath || !existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      throw new CodexRegistryError(`cannot open ${dbPath}: ${err?.message ?? err}`, {
        account: account.name,
        dbPath,
        cause: err,
      });
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, name, cwd, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms
             FROM threads
            WHERE archived = 0
            ORDER BY updated_at DESC`,
        )
        .all();
      for (const row of rows) {
        const rolloutPath = String(row.rollout_path ?? '');
        out.push({
          id: String(row.id),
          name: row.name == null ? undefined : String(row.name),
          cwd: String(row.cwd ?? ''),
          rolloutPath,
          createdAtMs: msOf(row.created_at_ms, row.created_at),
          updatedAtMs: msOf(row.updated_at_ms, row.updated_at),
          account: account.name,
          hasRollout: rolloutPath !== '' && existsSync(rolloutPath),
        });
      }
    } catch (err) {
      throw new CodexRegistryError(`cannot read threads from ${dbPath}: ${err?.message ?? err}`, {
        account: account.name,
        dbPath,
        cause: err,
      });
    } finally {
      try {
        db.close();
      } catch {
        // closing a read-only handle cannot lose data
      }
    }
  }
  return out;
}

/** Rollout files are `rollout-<timestamp>-<uuid>.jsonl` under `sessions/YYYY/MM/DD/`. */
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * The newest rollout file written at or after `sinceMs` in one CODEX_HOME. Codex writes
 * the rollout before the `threads` row is visible, so this is the fallback evidence that
 * this CODEX_HOME started a thread.
 * @param {{ account?: string, sinceMs: number, accounts: Account[],
 *           readdir?: Function, stat?: Function }} input
 * @returns {{id: string, path: string, mtimeMs: number}|undefined}
 */
function newestRollout({ account, sinceMs, accounts, readdir = readdirSync, stat = statSync }) {
  /** @type {{id: string, path: string, mtimeMs: number}|undefined} */
  let best;
  for (const acc of accounts) {
    if (!acc.codexDir || (account && acc.name !== account)) continue;
    const dir = join(acc.codexDir, 'sessions');
    let entries;
    try {
      entries = readdir(dir, { recursive: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // this CODEX_HOME has no sessions yet
      throw new CodexRegistryError(`cannot scan ${dir}: ${err?.message ?? err}`, {
        account: acc.name,
        dbPath: dir,
        cause: err,
      });
    }
    for (const entry of entries) {
      const match = ROLLOUT_RE.exec(basename(String(entry)));
      if (!match) continue;
      const path = join(dir, String(entry));
      let info;
      try {
        info = stat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') continue; // deleted between readdir and stat
        throw new CodexRegistryError(`cannot stat ${path}: ${err?.message ?? err}`, {
          account: acc.name,
          dbPath: path,
          cause: err,
        });
      }
      if (info.mtimeMs < sinceMs) continue;
      if (!best || info.mtimeMs > best.mtimeMs) best = { id: match[1], path, mtimeMs: info.mtimeMs };
    }
  }
  return best;
}

/**
 * The codex thread one spawn created: the newest `threads` row for `cwd` whose
 * `created_at` is at or after `sinceMs`, else the newest rollout file written since then
 * (its name carries the thread uuid, and `threads.name` fills in the name when known).
 * `undefined` means neither exists; an older thread is never attributed to this spawn.
 * @param {{ account?: string, cwd?: string, sinceMs?: number, accounts?: Account[],
 *           readdir?: Function, stat?: Function }} [opts]
 * @returns {{id: string, name?: string, source: 'threads.created_at'|'rollout', rolloutPath?: string}|undefined}
 */
export function findSpawnedThread({ account, cwd, sinceMs = 0, accounts = discoverAccounts(), readdir, stat } = {}) {
  const norm = (path) => String(path ?? '').replace(/\/+$/, '');
  const fresh = listCodexThreads(accounts)
    .filter((t) => (!account || t.account === account) && norm(t.cwd) === norm(cwd) && t.createdAtMs >= sinceMs)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  if (fresh.length) return { id: fresh[0].id, name: fresh[0].name, source: 'threads.created_at' };

  const rollout = newestRollout({ account, sinceMs, accounts, readdir, stat });
  if (!rollout) return undefined;
  const known = listCodexThreads(accounts).find((t) => t.id === rollout.id);
  return { id: rollout.id, name: known?.name, source: 'rollout', rolloutPath: rollout.path };
}

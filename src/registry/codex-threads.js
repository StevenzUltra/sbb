// Codex threads, read from every account's <codexDir>/state_5.sqlite.
// Opened read-only with node:sqlite; SBB never writes into a CODEX_HOME.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
          `SELECT id, name, cwd, rollout_path, updated_at, updated_at_ms
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
          updatedAtMs: Number(row.updated_at_ms ?? Number(row.updated_at) * 1000),
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

// Quota reader for Usage Guard (docs/spec/protocols.md section 6).
// SBB only ever opens the SQLite read-only and never triggers redemption.
//
// Tables this module relies on (verified with `sqlite3 <db> .schema` on 2026-09-09):
//   usage_snapshot(id, provider, account_alias, captured_at, status,
//                  session_used, session_resets_at, weekly_used, weekly_resets_at,
//                  fable_used, fable_resets_at, credit_count,
//                  earliest_credit_expiry, error_code)
//     - one row per provider/account per poll; the newest id per pair is current.
//     - *_used columns hold PERCENT USED (0..100), *_resets_at are epoch seconds.
//     - status: 'fresh' | 'authenticationRequired' | 'unavailable' | ...
//   account_identity, redemption_attempt, notification_marker,
//   token_usage_daily, token_scan_file -- not used by SBB.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { run as defaultRun } from '../lib/exec.js';
import { usageGuardDb } from '../lib/paths.js';

/**
 * @typedef {Object} QuotaRow
 * @property {string} account      SBB account name ('default' for the Usage Guard alias 'root')
 * @property {string} alias        raw account_alias in the database
 * @property {string} provider     'claude' | 'codex' | 'cursor' | ...
 * @property {string} window       'session' | 'weekly' | 'fable' | 'unknown'
 * @property {number|null} usedPercent
 * @property {number|null} remaining
 * @property {number|null} resetsAt      epoch ms
 * @property {number|null} capturedAt    epoch ms
 * @property {string} status       Usage Guard status string
 * @property {string|null} note    machine-readable extra ('unknown', error code, ...)
 */

/** Windows stored in the generic columns. Providers fill the ones they have. */
const WINDOWS = [
  { name: 'session', used: 'session_used', resets: 'session_resets_at' },
  { name: 'weekly', used: 'weekly_used', resets: 'weekly_resets_at' },
  { name: 'fable', used: 'fable_used', resets: 'fable_resets_at' },
];

/** Usage Guard calls the primary account 'root'; SBB calls it 'default'. */
export function accountFromAlias(alias) {
  const a = String(alias ?? '').toLowerCase();
  return a === 'root' ? 'default' : a;
}

/** Candidate app binary paths. SBB_USAGE_GUARD_APP overrides the bundle location. */
export function usageGuardBinary(env = process.env) {
  const app = env.SBB_USAGE_GUARD_APP ?? join(homedir(), 'Applications', 'EagerStudy Usage Guard.app');
  return [
    join(app, 'Contents', 'MacOS', 'EagerStudyUsageGuard'),
    join(app, 'Contents', 'MacOS', 'Eager Study Usage Guard'),
  ].find((p) => existsSync(p));
}

/**
 * Read-only refresh: the app polls the official endpoints with each account's own
 * credentials. Never redeems. Returns what happened so callers can report it.
 * @param {{ run?: Function, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 */
export async function refreshQuota(opts = {}) {
  const run = opts.run ?? defaultRun;
  const binary = usageGuardBinary(opts.env ?? process.env);
  if (!binary) return { ran: false, reason: 'app_missing' };
  const result = await run(binary, ['--read-once', '--no-ui', '--no-redeem'], {
    timeoutMs: opts.timeoutMs ?? 90000,
  });
  return {
    ran: true,
    binary,
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    ok: result.code === 0 && !result.timedOut,
  };
}

/** @returns {QuotaRow} */
function unknownRow(note = 'unknown') {
  return {
    account: 'unknown',
    alias: '',
    provider: 'unknown',
    window: 'unknown',
    usedPercent: null,
    remaining: null,
    resetsAt: null,
    capturedAt: null,
    status: 'unknown',
    note,
  };
}

/**
 * @param {{ refresh?: boolean, dbPath?: string, run?: Function, env?: NodeJS.ProcessEnv,
 *           onRefresh?: (info: object) => void }} [opts]
 * @returns {Promise<QuotaRow[]>}
 */
export async function readQuota(opts = {}) {
  if (opts.refresh) {
    const info = await refreshQuota(opts);
    opts.onRefresh?.(info);
  }
  const dbPath = opts.dbPath ?? usageGuardDb();
  if (!existsSync(dbPath)) return [unknownRow('usage_guard_db_missing')];

  /** @type {DatabaseSync} */
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return [unknownRow(`usage_guard_db_unreadable: ${err?.message ?? err}`)];
  }
  try {
    const rows = db
      .prepare(
        `SELECT provider, account_alias, captured_at, status, error_code,
                session_used, session_resets_at,
                weekly_used, weekly_resets_at,
                fable_used, fable_resets_at
           FROM usage_snapshot
          WHERE id IN (SELECT MAX(id) FROM usage_snapshot GROUP BY provider, account_alias)
          ORDER BY provider, account_alias`,
      )
      .all();
    /** @type {QuotaRow[]} */
    const out = [];
    for (const row of rows) {
      const status = String(row.status ?? 'unknown');
      const note = row.error_code == null ? (status === 'fresh' ? null : status) : String(row.error_code);
      let emitted = false;
      for (const window of WINDOWS) {
        const used = row[window.used];
        if (used == null) continue;
        const usedPercent = Number(used);
        out.push({
          account: accountFromAlias(row.account_alias),
          alias: String(row.account_alias ?? ''),
          provider: String(row.provider ?? 'unknown'),
          window: window.name,
          usedPercent,
          remaining: Number.isFinite(usedPercent) ? Math.round((100 - usedPercent) * 10) / 10 : null,
          resetsAt: row[window.resets] == null ? null : Math.round(Number(row[window.resets]) * 1000),
          capturedAt: row.captured_at == null ? null : Math.round(Number(row.captured_at) * 1000),
          status,
          note,
        });
        emitted = true;
      }
      if (!emitted) {
        out.push({
          account: accountFromAlias(row.account_alias),
          alias: String(row.account_alias ?? ''),
          provider: String(row.provider ?? 'unknown'),
          window: 'unknown',
          usedPercent: null,
          remaining: null,
          resetsAt: null,
          capturedAt: row.captured_at == null ? null : Math.round(Number(row.captured_at) * 1000),
          status,
          note: note ?? 'unknown',
        });
      }
    }
    return out.length ? out : [unknownRow()];
  } catch (err) {
    return [unknownRow(`usage_guard_query_failed: ${err?.message ?? err}`)];
  } finally {
    try {
      db.close();
    } catch {
      // read-only handle
    }
  }
}

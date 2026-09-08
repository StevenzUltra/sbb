// Quota floors from ~/.sbb/config.json applied to outbound work.
// docs/spec/policy.md "quota". A missing or unknown reading never blocks.
import { DEFAULT_QUOTA } from './config.js';

/** @typedef {import('../quota/usage-guard.js').QuotaRow} QuotaRow */

/**
 * Weekly remaining percent for an account, or null when Usage Guard knows nothing.
 * @param {QuotaRow[]} rows @param {string} account
 * @returns {number|null}
 */
export function weeklyRemaining(rows, account) {
  const row = (rows ?? []).find((r) => r.account === account && r.window === 'weekly');
  return row && Number.isFinite(row.remaining) ? row.remaining : null;
}

/**
 * `quota.floorWeekly`: refuse outbound work to an account below the floor.
 * @param {{ account: string, config?: Record<string, any>, rows?: QuotaRow[] }} input
 * @returns {{ ok: true, remaining: number|null } | { ok: false, reason: 'quota', detail: string }}
 */
export function checkQuotaFloor({ account, config, rows }) {
  const floor = config?.quota?.floorWeekly ?? DEFAULT_QUOTA.floorWeekly;
  const remaining = weeklyRemaining(rows, account);
  if (remaining == null) return { ok: true, remaining };
  if (remaining < floor) {
    return {
      ok: false,
      reason: 'quota',
      detail: `account ${account} weekly remaining ${remaining}% < floor ${floor}%`,
    };
  }
  return { ok: true, remaining };
}

/**
 * `quota.mainReserve`: a sub brain must not spawn onto an account hosting a main brain
 * that is below the reserve.
 * @param {{ account: string, config?: Record<string, any>, rows?: QuotaRow[],
 *           brains?: import('../types.js').Brain[] }} input
 * @returns {{ ok: true } | { ok: false, reason: 'quota', detail: string }}
 */
export function checkMainReserve({ account, config, rows, brains = [] }) {
  const reserve = config?.quota?.mainReserve ?? DEFAULT_QUOTA.mainReserve;
  const main = brains.find((b) => b.role === 'main' && b.account === account);
  if (!main) return { ok: true };
  const remaining = weeklyRemaining(rows, account);
  if (remaining == null) return { ok: true };
  if (remaining < reserve) {
    return {
      ok: false,
      reason: 'quota',
      detail: `account ${account} weekly remaining ${remaining}% < mainReserve ${reserve}% (hosts main brain ${main.name}#${main.id})`,
    };
  }
  return { ok: true };
}

// Address resolution at send time. docs/spec/registry.md section "Addresses".
// Never guesses: an unknown or ambiguous address raises ResolveError.
import { discoverAccounts } from '../lib/paths.js';
import { resolvePaneId as defaultResolvePaneId } from '../lib/tmux.js';
import { duplicateIdentities, getBrain, normalizeBrainId } from './brains.js';
import { roster as defaultRoster } from './roster.js';

/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('./roster.js').RosterRow} RosterRow */

export const CLI_KINDS = ['claude', 'codex', 'agy', 'cursor', 'other'];

const PANE_ID_RE = /^%\d+$/;
const COORD_RE = /^[^:]+:\d+\.\d+$/;

/** Address could not be resolved. `reason` is `target_not_found` or `target_ambiguous`. */
export class ResolveError extends Error {
  /**
   * @param {'target_not_found'|'target_ambiguous'|'duplicate_identity'} reason
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(reason, message, detail) {
    super(message);
    this.name = 'ResolveError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** @param {RosterRow} row @param {string} address @returns {Target} */
function toTarget(row, address) {
  return {
    address,
    brain: row.brain ?? undefined,
    brainId: row.brainId ?? undefined,
    account: row.account,
    cli: row.cli,
    paneId: row.paneId,
    coord: row.coord,
    claude: row.claude,
    codex: row.codex,
  };
}

/**
 * A record whose id or uuid appears twice is a hard error: refuse to resolve it.
 * @param {import('../types.js').Brain} brain
 */
function assertUniqueIdentity(brain) {
  const { ids, uuids } = duplicateIdentities();
  if (ids.includes(brain.id) || (brain.uuid && uuids.includes(brain.uuid))) {
    throw new ResolveError(
      'duplicate_identity',
      `brain ${brain.name} (${brain.id}) has a duplicated id or uuid`,
      'run sbb doctor and fix ~/.sbb/brains before sending',
    );
  }
}

/**
 * Re-resolve a registered brain to its live pane.
 * @param {import('../types.js').Brain} brain
 * @param {string} address
 * @param {RosterRow[]} rows
 * @param {(target: string) => Promise<string>} resolvePaneId
 * @returns {Promise<Target>}
 */
async function resolveBrain(brain, address, rows, resolvePaneId) {
  assertUniqueIdentity(brain);
  let paneId;
  try {
    paneId = await resolvePaneId(brain.paneId);
  } catch (err) {
    throw new ResolveError('target_not_found', `brain "${brain.name}" pane ${brain.paneId} is gone`, String(err?.message ?? err));
  }
  if (!paneId) throw new ResolveError('target_not_found', `brain "${brain.name}" pane ${brain.paneId} is gone`);
  const row = rows.find((r) => r.paneId === paneId);
  if (!row) {
    throw new ResolveError('target_not_found', `brain "${brain.name}" pane ${paneId} is not a live CLI session`);
  }
  return { ...toTarget(row, address), brain: brain.name, brainId: brain.id };
}

/**
 * Resolve an address to a live target.
 * @param {string} address
 * @param {{ rows?: RosterRow[], roster?: Function, accounts?: import('../types.js').Account[],
 *           resolvePaneId?: (target: string) => Promise<string>,
 *           onWarn?: (message: string) => void }} [opts]
 * @returns {Promise<Target>}
 */
export async function resolve(address, opts = {}) {
  const raw = String(address ?? '').trim();
  if (!raw) throw new ResolveError('target_not_found', 'empty address');
  const accounts = opts.accounts ?? discoverAccounts();
  const resolvePaneId = opts.resolvePaneId ?? defaultResolvePaneId;
  const rows = opts.rows
    ?? (await (opts.roster ?? defaultRoster)({ withStatus: false, accounts, onWarn: opts.onWarn }));

  // 0. a brain id: #SMS-0012 (the # is optional, case-insensitive, exact)
  const asId = normalizeBrainId(raw);
  if (asId) {
    const brain = getBrain(asId);
    if (!brain) throw new ResolveError('target_not_found', `unknown brain id "${asId}"`, 'no brain record');
    return resolveBrain(brain, raw, rows, resolvePaneId);
  }

  // 4. a bare pane id or coordinate
  if (PANE_ID_RE.test(raw) || COORD_RE.test(raw)) {
    const row = PANE_ID_RE.test(raw) ? rows.find((r) => r.paneId === raw) : rows.find((r) => r.coord === raw);
    if (!row) throw new ResolveError('target_not_found', `no live CLI session at ${raw}`);
    return toTarget(row, raw);
  }

  // 1. a brain name
  if (!raw.includes('/') && !raw.includes(':')) {
    const brain = getBrain(raw);
    if (!brain) throw new ResolveError('target_not_found', `unknown brain "${raw}"`, 'no brain record');
    return resolveBrain(brain, raw, rows, resolvePaneId);
  }

  // 2. <account>/<cli>:<name|%pane|session:window.pane>
  const slash = raw.indexOf('/');
  const colon = raw.indexOf(':', slash + 1);
  if (slash < 0 || colon < 0) {
    throw new ResolveError('target_not_found', `cannot parse address "${raw}"`, 'expected <account>/<cli>:<target>');
  }
  const accountName = raw.slice(0, slash).toLowerCase();
  const cli = raw.slice(slash + 1, colon).toLowerCase();
  const target = raw.slice(colon + 1);
  if (!accounts.some((a) => a.name === accountName)) {
    throw new ResolveError('target_not_found', `unknown account "${accountName}"`);
  }
  if (!CLI_KINDS.includes(cli)) {
    throw new ResolveError('target_not_found', `unknown cli "${cli}"`, `expected one of ${CLI_KINDS.join(', ')}`);
  }

  if (PANE_ID_RE.test(target) || COORD_RE.test(target)) {
    const row = PANE_ID_RE.test(target)
      ? rows.find((r) => r.paneId === target)
      : rows.find((r) => r.coord === target);
    if (!row) throw new ResolveError('target_not_found', `no live CLI session at ${target}`);
    if (row.cli !== cli) {
      throw new ResolveError('target_not_found', `${target} is ${row.cli}, not ${cli}`);
    }
    if (row.account !== accountName) {
      throw new ResolveError('target_not_found', `${target} belongs to account ${row.account}, not ${accountName}`);
    }
    return toTarget(row, raw);
  }

  const named = rows.filter((r) => r.account === accountName && r.cli === cli && r.name === target);
  if (named.length === 0) {
    throw new ResolveError('target_not_found', `no live ${cli} session named "${target}" in account ${accountName}`);
  }
  if (named.length > 1) {
    throw new ResolveError(
      'target_ambiguous',
      `${named.length} live ${cli} sessions named "${target}" in account ${accountName}`,
      named.map((r) => r.coord).join(', '),
    );
  }
  return toTarget(named[0], raw);
}

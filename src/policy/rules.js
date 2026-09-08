// Who may talk to whom. `check(senderBrain|null, targetBrain|null, config)` is the single
// source of truth; docs/spec/policy.md section "Who may talk to whom" is the table.
import { getBrain as defaultGetBrain } from '../registry/brains.js';

/** @typedef {import('../types.js').Brain} Brain */

/**
 * A policy verdict.
 * @typedef {{ ok: true } | { ok: false, moderated?: boolean, reason: 'policy', detail: string }} Verdict
 */

/** @param {Brain|null|undefined} brain */
function isMain(brain) {
  return brain?.role === 'main';
}

/** @param {Brain|null|undefined} brain */
function identifiers(brain) {
  return new Set([brain?.id, brain?.name].filter((v) => typeof v === 'string' && v !== ''));
}

/**
 * `config.allow` pairs talk regardless of the table. A pair matches by id or by name,
 * either order.
 * @param {Brain} sender @param {Brain} target @param {Record<string, any>} config
 */
export function allowedPair(sender, target, config) {
  const s = identifiers(sender);
  const t = identifiers(target);
  for (const [a, b] of config?.allow ?? []) {
    if ((s.has(a) && t.has(b)) || (s.has(b) && t.has(a))) return true;
  }
  return false;
}

/**
 * Ancestor chain, self first.
 * @param {Brain} brain @param {(ref: string) => Brain|undefined} getBrain
 * @returns {string[]}
 */
export function ancestorIds(brain, getBrain = defaultGetBrain) {
  const out = [];
  const seen = new Set();
  let current = brain;
  while (current && current.id && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current.id);
    current = current.parent ? getBrain(current.parent) : undefined;
  }
  return out;
}

/**
 * The main brain at the top of a brain's chain (itself when it is a main).
 * @param {Brain} brain @param {(ref: string) => Brain|undefined} getBrain
 * @returns {Brain|null}
 */
export function rootMain(brain, getBrain = defaultGetBrain) {
  let current = brain;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    if (current.role === 'main') return current;
    seen.add(current.id);
    current = current.parent ? getBrain(current.parent) : undefined;
  }
  return null;
}

/** @param {string} detail @returns {Verdict} */
function blocked(detail) {
  return { ok: false, reason: 'policy', detail };
}

/**
 * The policy table. An unregistered sender counts as the user and may talk to anyone; an
 * unregistered target is always allowed. Pairs the table does not restrict are allowed.
 * @param {Brain|null|undefined} sender
 * @param {Brain|null|undefined} target
 * @param {Record<string, any>} config
 * @param {{ getBrain?: (ref: string) => Brain|undefined }} [opts]
 * @returns {Verdict}
 */
export function check(sender, target, config = {}, opts = {}) {
  const getBrain = opts.getBrain ?? defaultGetBrain;
  if (!sender || !target) return { ok: true };
  if (sender.id && sender.id === target.id) return { ok: true };
  if (allowedPair(sender, target, config)) return { ok: true };
  if (target.parent === sender.id || sender.parent === target.id) return { ok: true };

  if (isMain(sender) && isMain(target)) {
    const perSender = config?.brains?.[sender.id]?.peers;
    const perTarget = config?.brains?.[target.id]?.peers;
    if (perSender === 'off' || perTarget === 'off') return blocked('peers_off');
    const mode = config?.peers ?? 'on';
    if (mode === 'off') return blocked('peers_off');
    if (mode === 'moderated') return { ok: false, moderated: true, reason: 'policy', detail: 'peers_moderated' };
    return { ok: true };
  }

  if (!isMain(sender) && !isMain(target)) {
    const a = rootMain(sender, getBrain);
    const b = rootMain(target, getBrain);
    if (a && b && a.id === b.id) {
      if (config?.brains?.[a.id]?.autonomous === true) return { ok: true };
      return blocked('same_team_via_parent');
    }
    return blocked('cross_team');
  }

  return { ok: true };
}

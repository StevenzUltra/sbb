// Moderated messages: ~/.sbb/held/<msgId>.json. A moderated peer message is never sent;
// it is parked here until the user runs `sbb approve` or `sbb approve --deny`.
// docs/spec/policy.md "moderated".
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { shortId } from '../lib/ids.js';

/** @param {{ sbbDir?: string }} [opts] */
export function heldDir(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'held');
}

/** @param {string} msgId @param {{ sbbDir?: string }} [opts] */
export function heldPath(msgId, opts = {}) {
  return join(heldDir(opts), `${msgId}.json`);
}

/**
 * Park a moderated message. Returns the stored entry.
 * @param {{ msgId: string, message: Record<string, any>, target: Record<string, any>,
 *           sender: Record<string, any>, verdict?: Record<string, any>, now?: number,
 *           sbbDir?: string }} input
 */
export function writeHold(input) {
  const dir = heldDir(input);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry = {
    msgId: input.msgId,
    heldAt: input.now ?? Date.now(),
    reason: input.verdict?.detail ?? 'peers_moderated',
    sender: input.sender ?? null,
    target: input.target ?? null,
    message: input.message ?? null,
    text: input.message?.text ?? '',
  };
  const path = join(dir, `${input.msgId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return entry;
}

/**
 * Every parked message with its file path, oldest first.
 * @param {{ sbbDir?: string }} [opts]
 * @returns {{ file: string, entry: Record<string, any> }[]}
 */
export function listHeldFiles(opts = {}) {
  const dir = heldDir(opts);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push({ file: join(dir, name), entry: JSON.parse(readFileSync(join(dir, name), 'utf8')) });
    } catch {
      // a half-written hold is not worth failing the listing for
    }
  }
  return out.sort((a, b) => (a.entry.heldAt ?? 0) - (b.entry.heldAt ?? 0));
}

/**
 * Every parked message, oldest first.
 * @param {{ sbbDir?: string }} [opts]
 * @returns {Record<string, any>[]}
 */
export function listHeld(opts = {}) {
  return listHeldFiles(opts).map((h) => h.entry);
}

/** `pending` until a retire expires it. @param {Record<string, any>} entry */
export function heldStatus(entry) {
  return entry?.expiredAt ? 'expired' : 'pending';
}

/**
 * A hold is worth showing while both ends are alive: the brain record still exists and
 * still has a pane. An end without a brain id (the user, or a bare address) counts as
 * alive, and a caller with no `getBrainFn` hides nothing.
 * @param {Record<string, any>} entry
 * @param {{ getBrainFn?: (ref: string) => Record<string, any>|undefined }} [opts]
 */
export function holdAlive(entry, { getBrainFn } = {}) {
  if (!getBrainFn) return true;
  const alive = (id) => {
    if (!id) return true;
    const brain = getBrainFn(id);
    return Boolean(brain) && brain.paneId !== null;
  };
  return alive(entry?.sender?.id) && alive(entry?.target?.brainId);
}

/**
 * Expire every pending hold whose sender or target is this brain. Retiring a brain is
 * silent for the hold: nobody is notified (docs/spec/policy.md "Moderated holds").
 * @param {string} brainId
 * @param {{ now?: number, reason?: string, sbbDir?: string }} [opts]
 * @returns {number} how many holds were expired
 */
export function expireHoldsForBrain(brainId, opts = {}) {
  const id = String(brainId ?? '').trim();
  if (!id) return 0;
  let count = 0;
  for (const { file, entry } of listHeldFiles(opts)) {
    if (entry.expiredAt) continue;
    if (entry.sender?.id !== id && entry.target?.brainId !== id) continue;
    const next = {
      ...entry,
      expiredAt: opts.now ?? Date.now(),
      expiredReason: opts.reason ?? `brain ${id} retired`,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    count += 1;
  }
  return count;
}

/**
 * Find one hold by full msgId or 8-char prefix.
 * @param {string} ref @param {{ sbbDir?: string }} [opts]
 * @returns {{ file: string, entry: Record<string, any> } | undefined}
 */
export function findHeld(ref, opts = {}) {
  const prefix = String(ref ?? '').toLowerCase().replace(/^msg=/, '');
  if (!/^[0-9a-f]{4,32}$/.test(prefix)) return undefined;
  const dir = heldDir(opts);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const hit = names.find((n) => n.startsWith(prefix) && n.endsWith('.json'));
  if (!hit) return undefined;
  const file = join(dir, hit);
  try {
    return { file, entry: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return undefined;
  }
}

/** @param {string} file */
export function removeHold(file) {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} entry */
export function heldLine(entry) {
  const from = entry.sender?.name ?? entry.sender?.brain ?? 'user';
  const to = entry.target?.brain ?? entry.target?.address ?? '?';
  return `msg=${shortId(entry.msgId)}  ${from} -> ${to}  held=${new Date(entry.heldAt ?? 0).toISOString()}`;
}

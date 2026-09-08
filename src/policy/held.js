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
 * Every parked message, oldest first.
 * @param {{ sbbDir?: string }} [opts]
 * @returns {Record<string, any>[]}
 */
export function listHeld(opts = {}) {
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
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      // a half-written hold is not worth failing the listing for
    }
  }
  return out.sort((a, b) => (a.heldAt ?? 0) - (b.heldAt ?? 0));
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

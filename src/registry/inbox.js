// Inbox: ~/.sbb/inbox/<brain>/<t>-<msgId>.json, one file per received message.
// `sbb reply` writes here when the original sender was the user; the inbox server
// (task h1) writes replies and idle notices for a brain.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { BRAIN_NAME_RE } from './brains.js';
import { BRAIN_ID_RE } from './brain-id.js';

/** The user is a valid inbox owner next to the brains. */
export const USER_INBOX = 'user';

/** @param {string} owner */
/** A brain name, a brain id (`SMS-0012`, the delivery mirror) or `user`. */
export function assertInboxOwner(owner) {
  const value = String(owner);
  if (value !== USER_INBOX && !BRAIN_NAME_RE.test(value) && !BRAIN_ID_RE.test(value)) {
    throw new Error(`invalid inbox owner "${owner}"`);
  }
  return value;
}

export function inboxRoot() {
  return join(sbbDir(), 'inbox');
}

/** @param {string} owner */
export function inboxDirFor(owner) {
  return join(inboxRoot(), assertInboxOwner(owner));
}

export function userInboxDir() {
  return inboxDirFor(USER_INBOX);
}

/**
 * Write one inbox entry. The file name is `<t>-<msgId>.json` so a directory
 * listing is already in arrival order.
 * @param {{ owner: string, entry: { msgId: string, from?: string, fromId?: string|null,
 *           fromBrain?: string|null, fromAddress?: string|null, fromSock?: string|null,
 *           replyTo?: string|null, text: string, t?: number, read?: boolean } }} input
 */
export function writeInboxEntry({ owner, entry }) {
  const dir = inboxDirFor(owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = entry.t ?? Date.now();
  const record = { read: false, ...entry, t };
  const file = join(dir, `${t}-${record.msgId}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, entry: record };
}

/**
 * @param {string} owner
 * @param {{ unreadOnly?: boolean }} [opts]
 * @returns {{ file: string, entry: Record<string, any> }[]} oldest first.
 */
export function listInbox(owner, opts = {}) {
  const dir = inboxDirFor(owner);
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {{ file: string, entry: Record<string, any> }[]} */
  const out = [];
  for (const name of files.filter((f) => f.endsWith('.json')).sort()) {
    const file = join(dir, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // half-written entry
    }
    if (opts.unreadOnly && entry.read) continue;
    out.push({ file, entry });
  }
  return out;
}

/**
 * Mark one entry read by rewriting it. Never deletes.
 * @param {string} file
 * @param {Record<string, any>} entry
 */
export function markInboxRead(file, entry) {
  const record = { ...entry, read: true, readAt: Date.now() };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return record;
}

/** Find an unread/any entry whose replyTo matches a message id. */
export function findReply(owner, msgId) {
  return listInbox(owner).find(({ entry }) => entry.replyTo === msgId);
}

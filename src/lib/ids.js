// Message ids: 32 lowercase hex, printed short as the first 8 characters.
import { randomBytes } from 'node:crypto';

export function newMsgId() {
  return randomBytes(16).toString('hex');
}

/** @param {string} id */
export function shortId(id) {
  return String(id).slice(0, 8);
}

/** Accepts a full id or an 8-char prefix; returns a predicate for log lookup. */
export function idMatcher(idOrPrefix) {
  const p = String(idOrPrefix).toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(p)) throw new Error(`invalid message id: ${idOrPrefix}`);
  return (id) => String(id).startsWith(p);
}

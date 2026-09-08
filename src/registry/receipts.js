// Receipt log: one JSON line per send in ~/.sbb/log/receipts.jsonl.
// The human line format is defined in docs/spec/receipts.md.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { shortId } from '../lib/ids.js';

/** @typedef {import('../types.js').Receipt} Receipt */

export function logDir() {
  return join(sbbDir(), 'log');
}

export function receiptLogPath() {
  return join(logDir(), 'receipts.jsonl');
}

/**
 * Append one receipt entry. `t` is added when absent.
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
export function appendReceipt(entry) {
  const record = { t: Date.now(), ...entry };
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
  appendFileSync(receiptLogPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

/** @returns {Record<string, any>[]} malformed lines are skipped, never invented. */
export function readReceiptEntries() {
  let raw;
  try {
    raw = readFileSync(receiptLogPath(), 'utf8');
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partially written line is not a receipt
    }
  }
  return out;
}

/**
 * Find the most recent entry whose msgId matches an 8..32 char hex prefix.
 * @param {string} idOrPrefix
 * @returns {Record<string, any>|undefined}
 */
export function findReceipt(idOrPrefix) {
  const prefix = String(idOrPrefix).toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(prefix)) throw new Error(`invalid message id: ${idOrPrefix}`);
  const matches = readReceiptEntries().filter((e) => String(e.msgId ?? '').toLowerCase().startsWith(prefix));
  return matches.length ? matches[matches.length - 1] : undefined;
}

/** @param {Receipt} receipt */
export function formatReceiptLine(receipt) {
  const reason = receipt.reason ? `  reason=${receipt.reason}` : '';
  const detail = receipt.detail ? `  ${receipt.detail}` : '';
  return `${receipt.status.padEnd(10)} msg=${shortId(receipt.msgId)}  via=${receipt.via}  ${(receipt.elapsedMs / 1000).toFixed(1)}s${reason}${detail}`;
}

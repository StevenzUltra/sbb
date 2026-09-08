// Brain ids: <TAG>-<seq>, unique per machine and never reused.
// docs/spec/registry.md section "Brain id". The counter is a per-machine file that
// only ever grows; allocation is serialised by an O_EXCL lock so concurrent
// `sbb adopt` runs cannot hand out the same id.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { brainsDir, sbbDir } from '../lib/paths.js';
import { receiptLogPath } from './receipts.js';

/** `<TAG>-<seq>`, e.g. `SMS-0012`. Tag is 1..4 upper-case letters/digits. */
export const BRAIN_ID_RE = /^([A-Z][A-Z0-9]{0,3})-(\d{4,})$/;

/** Lock acquisition budget before allocation gives up (docs/spec/registry.md). */
export const LOCK_TIMEOUT_MS = 2000;

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} host @returns {string} upper-case initials of the hostname words, max 4 */
export function tagFromHostname(host) {
  const words = String(host ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const initials = words.map((word) => word[0].toUpperCase()).join('');
  return (initials || 'SBB').slice(0, 4);
}

/** @param {unknown} value @returns {string|undefined} */
export function sanitizeTag(value) {
  const tag = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4);
  return tag === '' ? undefined : tag;
}

/**
 * The machine tag: `~/.sbb/config.json` `machineTag`, else the hostname initials.
 * @param {{ sbbDir?: string, hostname?: string }} [opts]
 */
export function machineTag(opts = {}) {
  const dir = opts.sbbDir ?? sbbDir();
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    const configured = sanitizeTag(config?.machineTag);
    if (configured) return configured;
  } catch {
    // No config, or an unreadable one: the hostname default still applies.
  }
  return tagFromHostname(opts.hostname ?? hostname());
}

/** @param {{ sbbDir?: string }} [opts] */
export function counterPath(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'counter');
}

/** @param {{ sbbDir?: string }} [opts] */
export function lockPath(opts = {}) {
  return `${counterPath(opts)}.lock`;
}

/** @param {string} id @returns {number|undefined} */
export function seqOf(id) {
  const match = BRAIN_ID_RE.exec(String(id ?? '').trim().toUpperCase());
  return match ? Number(match[2]) : undefined;
}

/** @param {string} id @returns {string|undefined} the tag part */
export function tagOf(id) {
  const match = BRAIN_ID_RE.exec(String(id ?? '').trim().toUpperCase());
  return match ? match[1] : undefined;
}

/**
 * Highest seq already used for `tag` by live brains, retired brains or the receipt
 * log. Used when `~/.sbb/counter` is missing, so an id can never be reused on one
 * machine even after a counter loss.
 * @param {string} tag
 * @param {{ sbbDir?: string, logPath?: string }} [opts]
 * @returns {number}
 */
export function maxSeqFromState(tag, opts = {}) {
  let max = 0;
  for (const dir of [brainsDir(), join(brainsDir(), '_retired')]) {
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (tagOf(id) === tag) max = Math.max(max, seqOf(id) ?? 0);
    }
  }
  try {
    const raw = readFileSync(opts.logPath ?? receiptLogPath(), 'utf8');
    for (const match of raw.matchAll(new RegExp(`\\b${tag}-(\\d{4,})\\b`, 'g'))) {
      max = Math.max(max, Number(match[1]));
    }
  } catch {
    // No receipt log yet: the brain directories already answered.
  }
  return max;
}

/** @param {string} file @returns {number|undefined} */
function readCounter(file) {
  try {
    const value = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock with O_EXCL, retrying for LOCK_TIMEOUT_MS. A lock older than the
 * budget belonged to a crashed process and is broken rather than wedging the machine.
 * @param {string} path
 * @param {number} [timeoutMs]
 * @returns {number} the lock file descriptor
 */
function acquireLock(path, timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        try {
          if (Date.now() - statSync(path).mtimeMs > timeoutMs) {
            unlinkSync(path);
            continue;
          }
        } catch {
          continue; // the holder released it between open and stat
        }
        throw new Error(`could not lock ${path} within ${timeoutMs}ms`);
      }
      sleep(5);
    }
  }
}

/**
 * Allocate the next id for this machine. Serialised across processes.
 * @param {{ sbbDir?: string, tag?: string, hostname?: string }} [opts]
 * @returns {string} e.g. `SMS-0012`
 */
export function allocateId(opts = {}) {
  const dir = opts.sbbDir ?? sbbDir();
  const tag = opts.tag ?? machineTag({ sbbDir: dir, hostname: opts.hostname });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = counterPath({ sbbDir: dir });
  const fd = acquireLock(lockPath({ sbbDir: dir }));
  try {
    // The counter only ever grows: a hand-reset or lost counter must not reissue
    // an id that already exists in brains/, _retired/ or the receipt log.
    const next = Math.max(readCounter(file) ?? 0, maxSeqFromState(tag, { sbbDir: dir })) + 1;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return `${tag}-${String(next).padStart(4, '0')}`;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath({ sbbDir: dir }));
    } catch {
      // Someone else broke the stale lock; nothing to release.
    }
  }
}

/** Global identity for a record. UUID v7 is not in node:crypto, so randomUUID is used. */
export function newUuid() {
  return randomUUID();
}

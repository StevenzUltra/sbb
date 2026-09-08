// Brain records: ~/.sbb/brains/<name>.json, one file per brain.
// Writes are atomic (temp file + rename). Reads tolerate a missing directory.
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainsDir } from '../lib/paths.js';

/** @typedef {import('../types.js').Brain} Brain */

/** Names are unique: [a-z0-9][a-z0-9-]{0,39} (docs/spec/registry.md). */
export const BRAIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BRAIN_ROLES = ['main', 'sub'];
export const BRAIN_CLIS = ['claude', 'codex', 'agy', 'cursor', 'other'];
export const BRAIN_ORIGINS = ['spawned', 'adopted'];

/** Invalid brain record or name. `reason` is machine-readable. */
export class BrainError extends Error {
  /**
   * @param {string} message
   * @param {string} [reason]
   */
  constructor(message, reason = 'invalid_brain') {
    super(message);
    this.name = 'BrainError';
    this.reason = reason;
  }
}

/** @param {unknown} name */
export function isValidBrainName(name) {
  return typeof name === 'string' && BRAIN_NAME_RE.test(name);
}

/** @param {string} name @returns {string} */
export function assertBrainName(name) {
  if (!isValidBrainName(name)) {
    throw new BrainError(`invalid brain name "${name}": must match ${BRAIN_NAME_RE}`, 'invalid_name');
  }
  return name;
}

/** @param {string} name */
export function brainPath(name) {
  return join(brainsDir(), `${assertBrainName(name)}.json`);
}

/** @returns {Brain[]} sorted by name; [] when the directory does not exist. */
export function listBrains() {
  const dir = brainsDir();
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {Brain[]} */
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    } catch {
      // A corrupt record is not a brain. Skip it here; `sbb doctor` reports it.
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** @param {string} name @returns {Brain|undefined} */
export function getBrain(name) {
  if (!isValidBrainName(name)) return undefined;
  try {
    return JSON.parse(readFileSync(brainPath(name), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Validate a record before it is written. Throws BrainError with a reason.
 * `sub` brains need an existing parent; `main` brains have none.
 * @param {Brain} brain
 */
export function validateBrain(brain) {
  if (!brain || typeof brain !== 'object') throw new BrainError('brain must be an object', 'invalid_brain');
  assertBrainName(brain.name);
  if (!BRAIN_ROLES.includes(brain.role)) throw new BrainError(`invalid role "${brain.role}"`, 'invalid_role');
  if (!BRAIN_CLIS.includes(brain.cli)) throw new BrainError(`invalid cli "${brain.cli}"`, 'invalid_cli');
  if (typeof brain.account !== 'string' || brain.account === '') {
    throw new BrainError('brain.account must be a non-empty string', 'invalid_account');
  }
  if (typeof brain.cwd !== 'string' || brain.cwd === '') {
    throw new BrainError('brain.cwd must be a non-empty string', 'invalid_cwd');
  }
  if (typeof brain.paneId !== 'string' || !/^%\d+$/.test(brain.paneId)) {
    throw new BrainError(`invalid paneId "${brain.paneId}"`, 'invalid_pane');
  }
  if (!Number.isFinite(brain.createdAt)) throw new BrainError('brain.createdAt must be epoch ms', 'invalid_created_at');
  if (!BRAIN_ORIGINS.includes(brain.origin)) throw new BrainError(`invalid origin "${brain.origin}"`, 'invalid_origin');
  if (brain.role === 'main') {
    if (brain.parent !== null && brain.parent !== undefined) {
      throw new BrainError('main brains must have parent null', 'invalid_parent');
    }
  } else {
    if (!isValidBrainName(brain.parent)) throw new BrainError('sub brains need a parent brain name', 'invalid_parent');
    if (brain.parent === brain.name) throw new BrainError('a brain cannot be its own parent', 'invalid_parent');
    if (!getBrain(brain.parent)) throw new BrainError(`unknown parent brain "${brain.parent}"`, 'unknown_parent');
  }
  return brain;
}

/**
 * Write one brain record atomically.
 * @param {Brain} brain
 * @returns {Brain}
 */
export function saveBrain(brain) {
  validateBrain(brain);
  const dir = brainsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${brain.name}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(brain, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, brainPath(brain.name));
  return brain;
}

/**
 * @param {string} name
 * @returns {boolean} true when a record was removed, false when it did not exist.
 */
export function removeBrain(name) {
  try {
    unlinkSync(brainPath(name));
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
}

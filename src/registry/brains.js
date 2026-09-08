// Brain records: ~/.sbb/brains/<id>.json, retired ones under brains/_retired/<id>.json.
// Writes are atomic (temp file + rename). Reads tolerate a missing directory.
// docs/spec/registry.md sections "Brain id" and "Brain records".
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainsDir } from '../lib/paths.js';
import { BRAIN_ID_RE, newUuid } from './brain-id.js';

/** @typedef {import('../types.js').Brain} Brain */

/** Names are aliases: unique among live brains, [a-z0-9][a-z0-9-]{0,39}. */
export const BRAIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BRAIN_ROLES = ['main', 'sub'];
export const BRAIN_CLIS = ['claude', 'codex', 'agy', 'cursor', 'other'];
export const BRAIN_ORIGINS = ['spawned', 'adopted'];

/** Invalid brain record, id or name. `reason` is machine-readable. */
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

/** `#sms-0012`, `SMS-0012` -> `SMS-0012`. Case-insensitive, `#` optional. */
export function normalizeBrainId(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '').toUpperCase();
  return BRAIN_ID_RE.test(raw) ? raw : undefined;
}

/** @param {string} id @returns {string} */
export function assertBrainId(id) {
  const normalized = normalizeBrainId(id);
  if (!normalized) throw new BrainError(`invalid brain id "${id}": expected <TAG>-<seq>`, 'invalid_id');
  return normalized;
}

/** @param {string} id */
export function brainPath(id) {
  return join(brainsDir(), `${assertBrainId(id)}.json`);
}

export function retiredDir() {
  return join(brainsDir(), '_retired');
}

/** @param {string} id */
export function retiredPath(id) {
  return join(retiredDir(), `${assertBrainId(id)}.json`);
}

/** @param {string} file @returns {Brain|undefined} */
function readRecord(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record && typeof record === 'object' ? record : undefined;
  } catch {
    return undefined; // a corrupt record is not a brain; `sbb doctor` reports it
  }
}

/** @param {string} dir @returns {Brain[]} */
function listDir(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {Brain[]} */
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const record = readRecord(join(dir, file));
    if (record) out.push(record);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** @returns {Brain[]} live brains, sorted by id; [] when the directory does not exist. */
export function listBrains() {
  return listDir(brainsDir());
}

/** @returns {Brain[]} retired brains, sorted by id. */
export function listRetiredBrains() {
  return listDir(retiredDir());
}

/**
 * Look up a live brain by id (`#SMS-0012` or `SMS-0012`) or by name.
 * @param {string} idOrName
 * @returns {Brain|undefined}
 */
export function getBrain(idOrName) {
  const id = normalizeBrainId(idOrName);
  if (id) {
    const record = readRecord(brainPath(id));
    if (record) return record;
  }
  const name = String(idOrName ?? '').trim();
  if (!isValidBrainName(name)) return undefined;
  return listBrains().find((brain) => brain.name === name);
}

/** @param {string} ref brain id or name @returns {Brain|undefined} */
export function resolveBrainRef(ref) {
  return getBrain(ref);
}

/**
 * Ids and uuids that appear on more than one record (live or retired). Two records
 * sharing either is a hard error: doctor reports it and resolution refuses.
 * @returns {{ ids: string[], uuids: string[] }}
 */
export function duplicateIdentities() {
  const seenIds = new Map();
  const seenUuids = new Map();
  for (const brain of [...listBrains(), ...listRetiredBrains()]) {
    if (brain.id) seenIds.set(brain.id, (seenIds.get(brain.id) ?? 0) + 1);
    if (brain.uuid) seenUuids.set(brain.uuid, (seenUuids.get(brain.uuid) ?? 0) + 1);
  }
  return {
    ids: [...seenIds].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    uuids: [...seenUuids].filter(([, count]) => count > 1).map(([uuid]) => uuid).sort(),
  };
}

/**
 * Validate a record before it is written. Throws BrainError with a reason.
 * `sub` brains need an existing parent (by id); `main` brains have none.
 * @param {Brain} brain
 */
export function validateBrain(brain) {
  if (!brain || typeof brain !== 'object') throw new BrainError('brain must be an object', 'invalid_brain');
  const id = assertBrainId(brain.id);
  brain.id = id; // store the normalised form; ids are case-insensitive to look up
  if (typeof brain.uuid !== 'string' || brain.uuid.trim() === '') {
    throw new BrainError('brain.uuid must be a non-empty string', 'invalid_uuid');
  }
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
    const parentId = normalizeBrainId(brain.parent);
    if (!parentId) throw new BrainError('sub brains need a parent brain id', 'invalid_parent');
    brain.parent = parentId;
    if (parentId === id) throw new BrainError('a brain cannot be its own parent', 'invalid_parent');
    if (!getBrain(parentId)) throw new BrainError(`unknown parent brain "${brain.parent}"`, 'unknown_parent');
  }
  for (const other of listBrains()) {
    if (other.id !== id && other.name === brain.name) {
      throw new BrainError(`brain name "${brain.name}" is already used by ${other.id}`, 'duplicate_name');
    }
  }
  for (const other of [...listBrains(), ...listRetiredBrains()]) {
    if (other.id === id) {
      if (other.uuid !== brain.uuid) throw new BrainError(`brain id ${id} is already used by uuid ${other.uuid}`, 'duplicate_id');
      continue;
    }
    if (other.uuid === brain.uuid) {
      throw new BrainError(`brain uuid ${brain.uuid} is already used by ${other.id}`, 'duplicate_uuid');
    }
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
  const path = brainPath(brain.id);
  const tmp = join(dir, `.${brain.id}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(brain, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return brain;
}

/**
 * Retire a brain: the record moves to brains/_retired/<id>.json with `retiredAt`.
 * Ids are never reused, so the record is kept forever.
 * @param {string} idOrName
 * @returns {Brain|undefined} the retired record, or undefined when it did not exist.
 */
export function removeBrain(idOrName) {
  const brain = getBrain(idOrName);
  if (!brain?.id) return undefined;
  const target = retiredPath(brain.id);
  mkdirSync(retiredDir(), { recursive: true, mode: 0o700 });
  renameSync(brainPath(brain.id), target);
  const retired = { ...brain, retiredAt: Date.now() };
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(retired, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  try {
    unlinkSync(tmp);
  } catch {
    // rename already moved it
  }
  return retired;
}

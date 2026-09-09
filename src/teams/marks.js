// Read marks: ~/.sbb/teams/<mainId>.read/<callerId> holds the newest team-log timestamp
// that caller has read. `resetTeamMarks(brainId)` is the hook `sbb move` calls when a brain
// changes team (docs/spec/teams.md "Channels"); it lives here so move.js never writes these
// files itself.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTeamLog, teamsDir } from './log.js';

/** @param {string} mainId @param {string} callerId @param {{ sbbDir?: string }} [opts] */
export function readMarkPath(mainId, callerId, opts = {}) {
  return join(teamsDir(opts), `${mainId}.read`, String(callerId));
}

/**
 * The newest timestamp the caller has read in this team, 0 when there is no mark.
 * @param {string} mainId @param {string} callerId @param {{ sbbDir?: string }} [opts]
 */
export function readMark(mainId, callerId, opts = {}) {
  try {
    const value = Number(readFileSync(readMarkPath(mainId, callerId, opts), 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Store the newest read timestamp atomically.
 * @param {string} mainId @param {string} callerId @param {number} t @param {{ sbbDir?: string }} [opts]
 */
export function writeMark(mainId, callerId, t, opts = {}) {
  const path = readMarkPath(mainId, callerId, opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : 0;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return value;
}

/**
 * Team-log entries the caller has not read yet, oldest first.
 * @param {string} mainId @param {string} callerId @param {{ limit?: number, sbbDir?: string }} [opts]
 */
export function unreadTeamLog(mainId, callerId, opts = {}) {
  return readTeamLog(mainId, { ...opts, since: readMark(mainId, callerId, opts) });
}

/**
 * Forget every team read mark of one brain: `move` changes its team, so its unread marks
 * reset for the new team (docs/spec/teams.md "Channels"). Safe to call for a brain that
 * has no marks.
 * @param {string} brainId
 * @param {{ sbbDir?: string }} [opts]
 * @returns {number} how many marks were removed
 */
export function resetTeamMarks(brainId, opts = {}) {
  const id = String(brainId ?? '').trim();
  if (!id) return 0;
  let names;
  try {
    names = readdirSync(teamsDir(opts));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.read')) continue;
    try {
      rmSync(join(teamsDir(opts), name, id));
      removed += 1;
    } catch {
      // this team has no mark for that brain
    }
  }
  return removed;
}

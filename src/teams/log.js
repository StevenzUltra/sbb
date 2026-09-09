// The team log: ~/.sbb/teams/<mainId>.jsonl, one line per channel message.
// docs/spec/teams.md "Channels": the log is the memory of the members that cannot
// subscribe to anything (Codex, agy), so reads must tolerate a half-written line.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';

/** @param {{ sbbDir?: string }} [opts] */
export function teamsDir(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'teams');
}

/** @param {string} mainId @param {{ sbbDir?: string }} [opts] */
export function teamLogPath(mainId, opts = {}) {
  return join(teamsDir(opts), `${mainId}.jsonl`);
}

/**
 * Append one channel message.
 * @param {string} mainId
 * @param {Record<string, any>} entry `{ t, msgId, from, fromId, text, receipts }`
 * @param {{ sbbDir?: string }} [opts]
 */
export function appendTeamLog(mainId, entry, opts = {}) {
  const dir = teamsDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = { t: Date.now(), ...entry };
  const file = teamLogPath(mainId, opts);
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { file, entry: record };
}

/**
 * Entries oldest first. `since` keeps entries strictly newer than that timestamp; a
 * malformed (half-written) line is skipped, never invented.
 * @param {string} mainId
 * @param {{ since?: number, limit?: number, sbbDir?: string }} [opts]
 * @returns {Record<string, any>[]}
 */
export function readTeamLog(mainId, opts = {}) {
  let raw;
  try {
    raw = readFileSync(teamLogPath(mainId, opts), 'utf8');
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written is not an entry
    }
    if (opts.since !== undefined && (entry?.t ?? 0) <= opts.since) continue;
    out.push(entry);
  }
  return opts.limit ? out.slice(-opts.limit) : out;
}

/** Main ids that have a team log file. @param {{ sbbDir?: string }} [opts] */
export function listTeamLogIds(opts = {}) {
  let names;
  try {
    names = readdirSync(teamsDir(opts));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort();
}

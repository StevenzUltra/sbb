// ~/.sbb/config.json: machine tag, peer policy, allow pairs, quota floors.
// Reads merge defaults, writes are atomic (temp file + rename), 0600 under a 0700 dir.
// docs/spec/policy.md section "Config file".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { tagFromHostname } from '../registry/brain-id.js';

/** Peer modes the spec defines. */
export const PEER_MODES = Object.freeze(['on', 'off', 'moderated']);

/** Terminals `sbb ui` can open; `terminal` in the config file (docs/spec/ui-server.md). */
export const TERMINALS = Object.freeze(['ghostty', 'iterm2']);

/** Quota floors in percent of the weekly window. */
export const DEFAULT_QUOTA = Object.freeze({ floorWeekly: 10, mainReserve: 20 });

/** @param {{ sbbDir?: string }} [opts] */
export function configPath(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'config.json');
}

/**
 * @param {{ hostname?: string }} [opts]
 * @returns {import('./config.js').SbbConfig}
 */
export function defaultConfig(opts = {}) {
  return {
    machineTag: tagFromHostname(opts.hostname ?? osHostname()),
    peers: 'on',
    brains: {},
    teams: { subsDirect: true },
    allow: [],
    quota: { ...DEFAULT_QUOTA },
    spawn: { cliArgs: {} },
  };
}

/** @param {unknown} value @param {number} fallback */
function percent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

/**
 * Merge a raw config file over the defaults. Unknown keys are dropped, invalid
 * values fall back instead of failing a delivery. `terminal` is the one optional key: it is
 * kept when the file names a terminal this machine can open, and left absent otherwise, so
 * `sbb policy`'s write-back cannot wipe h1's choice and a missing value still means
 * "whichever is installed" (docs/spec/ui-server.md "Go to terminal").
 * @param {Record<string, any>} raw
 * @param {{ hostname?: string }} [opts]
 * @returns {import('./config.js').SbbConfig}
 */
export function mergeConfig(raw, opts = {}) {
  const base = defaultConfig(opts);
  const source = raw && typeof raw === 'object' ? raw : {};
  const brains = {};
  for (const [id, value] of Object.entries(source.brains && typeof source.brains === 'object' ? source.brains : {})) {
    if (!value || typeof value !== 'object') continue;
    /** @type {Record<string, any>} */
    const entry = {};
    if (PEER_MODES.includes(value.peers) && value.peers !== 'on') entry.peers = value.peers;
    if (value.autonomous === true) entry.autonomous = true;
    if (Object.keys(entry).length) brains[String(id).toUpperCase()] = entry;
  }
  const allow = (Array.isArray(source.allow) ? source.allow : [])
    .filter((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((x) => typeof x === 'string' && x.trim() !== ''))
    .map(([a, b]) => [String(a).trim(), String(b).trim()]);
  const quota = source.quota && typeof source.quota === 'object' ? source.quota : {};
  // Default CLI flags per CLI for `sbb spawn` (set with `sbb policy spawn-args`).
  // Blank or non-string values are dropped rather than passed to a spawn.
  const cliArgs = {};
  const rawArgs = source.spawn && typeof source.spawn === 'object' && source.spawn.cliArgs && typeof source.spawn.cliArgs === 'object'
    ? source.spawn.cliArgs
    : {};
  for (const [cli, value] of Object.entries(rawArgs)) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text !== '') cliArgs[String(cli)] = text;
  }
  return {
    machineTag: typeof source.machineTag === 'string' && source.machineTag.trim() !== ''
      ? source.machineTag.trim()
      : base.machineTag,
    peers: PEER_MODES.includes(source.peers) ? source.peers : 'on',
    brains,
    // M3 (docs/spec/teams.md): sub brains of one team talk directly unless switched off.
    teams: { subsDirect: source.teams?.subsDirect !== false },
    allow,
    quota: {
      floorWeekly: percent(quota.floorWeekly, base.quota.floorWeekly),
      mainReserve: percent(quota.mainReserve, base.quota.mainReserve),
    },
    spawn: { cliArgs },
    ...(TERMINALS.includes(String(source.terminal ?? '').toLowerCase())
      ? { terminal: String(source.terminal).toLowerCase() }
      : {}),
  };
}

/**
 * @param {{ sbbDir?: string, hostname?: string }} [opts]
 * @returns {import('./config.js').SbbConfig}
 */
export function readConfig(opts = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath(opts), 'utf8'));
  } catch {
    raw = {}; // missing or corrupt: defaults, never a failed delivery
  }
  return mergeConfig(raw, opts);
}

/**
 * @param {Record<string, any>} config
 * @param {{ sbbDir?: string }} [opts]
 */
export function writeConfig(config, opts = {}) {
  const path = configPath(opts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return config;
}

/**
 * Read, mutate, write in one step.
 * @param {(config: Record<string, any>) => Record<string, any>} mutate
 * @param {{ sbbDir?: string, hostname?: string }} [opts]
 */
export function updateConfig(mutate, opts = {}) {
  const next = mutate(readConfig(opts));
  return writeConfig(next, opts);
}

/** @typedef {{ machineTag: string, peers: 'on'|'off'|'moderated', brains: Record<string, { peers?: string, autonomous?: boolean }>, teams: { subsDirect: boolean }, allow: string[][], quota: { floorWeekly: number, mainReserve: number }, spawn: { cliArgs: Record<string, string> }, terminal?: 'ghostty'|'iterm2' }} SbbConfig */

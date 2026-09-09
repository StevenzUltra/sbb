// Wire shapes of POST /api/policy (docs/spec/ui-server.md). The console speaks the UI vocabulary
// 开 / 审核 / 关, the config file and the CLI speak on / moderated / off; every control goes
// through one of these builders so the translation lives in one place.

/** UI mode -> config.json `peers`. */
const WIRE = Object.freeze({ open: 'on', moderated: 'moderated', closed: 'off' });
/** config.json `peers` -> UI mode. */
const UI = Object.freeze({ on: 'open', moderated: 'moderated', off: 'closed' });

/** @param {string} peers @returns {'open'|'moderated'|'closed'} */
export function uiPeerMode(peers) {
  return UI[peers] ?? 'open';
}

/** @param {string} mode @returns {'on'|'moderated'|'off'} */
export function wirePeerMode(mode) {
  return WIRE[mode] ?? 'on';
}

/** @param {string} mode @returns {{ peers: string }} */
export function peersBody(mode) {
  return { peers: wirePeerMode(mode) };
}

/** @param {string} brainId @param {string} mode @param {boolean} [autonomous] */
export function brainPeersBody(brainId, mode, autonomous) {
  const set = { ref: brainId, peers: wirePeerMode(mode) };
  if (autonomous !== undefined) set.autonomous = Boolean(autonomous);
  return { set };
}

/** @param {[string, string]} pair */
export function allowBody(pair) {
  return { allow: [String(pair[0] ?? ''), String(pair[1] ?? '')] };
}

/** @param {[string, string]} pair */
export function denyBody(pair) {
  return { deny: [String(pair[0] ?? ''), String(pair[1] ?? '')] };
}

/** @param {{ floorWeekly?: number|string, mainReserve?: number|string }} floors */
export function quotaBody(floors) {
  const quota = {};
  if (floors?.floorWeekly !== undefined && floors.floorWeekly !== '') quota.floorWeekly = Number(floors.floorWeekly);
  if (floors?.mainReserve !== undefined && floors.mainReserve !== '') quota.mainReserve = Number(floors.mainReserve);
  return { quota };
}

/** @param {string} cli @param {string} args */
export function spawnArgsBody(cli, args) {
  return { spawnArgs: { cli, args } };
}

/** @param {string} cli @param {string} value */
export function spawnPreambleBody(cli, value) {
  return { spawnPreamble: { cli, value } };
}

/** @param {string} cli @param {string} value */
export function spawnCommandBody(cli, value) {
  return { spawnCommand: { cli, value } };
}

/** @param {string} value */
export function spawnShellBody(value) {
  return { spawnShell: value };
}

/** @param {'ghostty'|'iterm2'|null} value */
export function terminalBody(value) {
  return { terminal: value ?? null };
}

/** @param {boolean} value */
export function subsDirectBody(value) {
  return { subsDirect: Boolean(value) };
}

/** @param {Record<string, any>|null|undefined} policy @returns {{ peers?: string, autonomous?: boolean }[]} */
export function brainOverrides(policy) {
  return Object.entries(policy?.brains ?? {}).map(([id, entry]) => ({ id, ...entry }));
}

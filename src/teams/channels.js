// Team channels: `#<main name>` and `#all`. docs/spec/teams.md section "Channels".
// Resolution is pure over an injected registry so the CLI, the console data service and
// the tests share one definition of "who is in this channel".
import { getBrain as defaultGetBrain, isValidBrainName, listBrains as defaultListBrains, normalizeBrainId, sameName } from '../registry/brains.js';
import { ResolveError } from '../registry/resolve.js';
import { teamOf } from '../policy/rules.js';

/** @typedef {import('../types.js').Brain} Brain */

/** The channel of all main brains; the user only may post. */
export const ALL_CHANNEL = 'all';

/**
 * `#lead` -> `'lead'`, `#all` -> `'all'`; anything that is not a channel address (a brain
 * id like `#SMS-0001`, a plain name, an empty `#`) -> undefined.
 * @param {string} address
 * @returns {string|undefined}
 */
export function channelName(address) {
  const raw = String(address ?? '').trim();
  if (!raw.startsWith('#')) return undefined;
  const name = raw.slice(1).trim().toLowerCase();
  if (!name) return undefined;
  if (name === ALL_CHANNEL) return ALL_CHANNEL;
  if (normalizeBrainId(name)) return undefined; // a brain id, not a channel
  return isValidBrainName(name) ? name : undefined;
}

/** @param {string} address */
export function isChannelAddress(address) {
  return channelName(address) !== undefined;
}

/**
 * Every member of a main's team: the main itself plus all its descendants, sorted by id.
 * @param {Brain} main
 * @param {{ listBrains?: () => Brain[] }} [opts]
 * @returns {Brain[]}
 */
export function teamMembers(main, opts = {}) {
  const listBrains = opts.listBrains ?? defaultListBrains;
  /** @type {Map<string|null, Brain[]>} */
  const byParent = new Map();
  for (const brain of listBrains()) {
    const key = brain.parent ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), brain]);
  }
  /** @type {Brain[]} */
  const out = [];
  const seen = new Set();
  const queue = [main];
  while (queue.length) {
    const brain = queue.shift();
    if (!brain?.id || seen.has(brain.id)) continue;
    seen.add(brain.id);
    out.push(brain);
    for (const child of byParent.get(brain.id) ?? []) queue.push(child);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * @typedef {Object} Channel
 * @property {'team'|'all'} kind
 * @property {string} name        without the `#`
 * @property {string} id          `team:<mainId>` (or `team:all`)
 * @property {Brain|null} main    the owning main; null for `#all`
 * @property {Brain[]} members
 * @property {'member'|'user'} postable who may post
 */

/**
 * Resolve a channel address. Throws ResolveError `not_a_channel` for a malformed address
 * and `target_not_found` for an unknown main.
 * @param {string} address
 * @param {{ getBrain?: Function, listBrains?: () => Brain[] }} [opts]
 * @returns {Channel}
 */
export function resolveChannel(address, opts = {}) {
  const listBrains = opts.listBrains ?? defaultListBrains;
  const name = channelName(address);
  if (!name) {
    throw new ResolveError('not_a_channel', `"${address}" is not a channel address`, 'expected #<main name> or #all');
  }
  if (name === ALL_CHANNEL) {
    return {
      kind: 'all',
      name: ALL_CHANNEL,
      id: 'team:all',
      main: null,
      members: listBrains().filter((b) => b.role === 'main').sort((a, b) => String(a.id).localeCompare(String(b.id))),
      postable: 'user',
    };
  }
  const main = listBrains().find((brain) => brain.role === 'main' && sameName(brain.name, name));
  if (!main) throw new ResolveError('target_not_found', `no main brain named "${name}"`);
  return { kind: 'team', name, id: `team:${main.id}`, main, members: teamMembers(main, opts), postable: 'member' };
}

/**
 * The channel a brain belongs to (its own team), or null when it has no team.
 * @param {Brain|string} brainOrId
 * @param {{ getBrain?: Function, listBrains?: () => Brain[] }} [opts]
 * @returns {Channel|null}
 */
export function channelForBrain(brainOrId, opts = {}) {
  const getBrain = opts.getBrain ?? defaultGetBrain;
  const teamId = teamOf(brainOrId, getBrain);
  const main = teamId ? getBrain(teamId) : undefined;
  if (!main) return null;
  return { kind: 'team', name: main.name, id: `team:${main.id}`, main, members: teamMembers(main, opts), postable: 'member' };
}

/**
 * One channel per main brain, sorted by main id, for `sbb ls --teams`.
 * @param {{ listBrains?: () => Brain[] }} [opts]
 * @returns {Channel[]}
 */
export function allChannels(opts = {}) {
  const listBrains = opts.listBrains ?? defaultListBrains;
  return listBrains()
    .filter((brain) => brain.role === 'main')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((main) => ({ kind: 'team', name: main.name, id: `team:${main.id}`, main, members: teamMembers(main, opts), postable: 'member' }));
}

/**
 * The membership verdict for one sender, before any delivery happens.
 * @param {Channel} channel
 * @param {{ brain?: string|null, id?: string|null }} identity
 * @returns {{ ok: true } | { ok: false, detail: string }}
 */
export function checkChannel(channel, identity) {
  const senderId = identity?.id ?? null;
  if (!senderId) {
    // The user (a human at a pane, a script) may post to any channel.
    return { ok: true };
  }
  if (channel.postable === 'user') return { ok: false, detail: 'channel_user_only' };
  if (channel.members.some((member) => member.id === senderId)) return { ok: true };
  return { ok: false, detail: 'not_a_member' };
}

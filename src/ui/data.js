// The console's data service: one state snapshot and one fs watcher.
// docs/spec/ui-server.md defines /api/state and the SSE event names; docs/spec/teams.md the
// channel part. Readers here are read-only and tolerate partial writes (a malformed trailing
// line is skipped, never fatal).
import { readFileSync, readdirSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { accountList } from '../account/account.js';
import { listBrains, listRetiredBrains } from '../registry/brains.js';
import { catalog as defaultCatalog } from '../quota/catalog.js';
import { readReceiptEntries, receiptLogPath } from '../registry/receipts.js';
import { inboxRoot, listInbox } from '../registry/inbox.js';
import { listHeld } from '../policy/held.js';
import { listPlans } from '../policy/plans.js';
import { listAllClaims } from '../policy/claims.js';
import { readConfig } from '../policy/config.js';
import { readQuota } from '../quota/usage-guard.js';
import { allChannels, listTeamLogIds, readTeamLog, teamLogPath } from '../teams/index.js';
import { sbbDir } from '../lib/paths.js';
import { messagesFor } from './history.js';

export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/** `/api/state` carries the newest this-many receipt-log lines (docs/spec/ui-server.md). */
export const RECEIPTS_LIMIT = 500;

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Every complete JSON line of `file` after `offset`. The offset only advances past the last
 * newline, so a line still being written is read again next time instead of being lost.
 * @param {string} file
 * @param {number} offset
 * @returns {{ lines: Record<string, any>[], offset: number }}
 */
function readCompleteLines(file, offset) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { lines: [], offset };
  }
  const end = raw.lastIndexOf('\n');
  if (end < offset) return { lines: [], offset };
  /** @type {Record<string, any>[]} */
  const lines = [];
  for (const line of raw.slice(offset, end + 1).split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // a complete but corrupt line is skipped, like the receipt reader does
    }
  }
  return { lines, offset: end + 1 };
}

/** @param {Record<string, any>[]} list @param {(item: Record<string, any>) => string} key */
function byKey(list, key) {
  return new Map(list.map((item) => [key(item), item]));
}

/** @param {Record<string, any>[]} brains */
function buildTree(brains) {
  const nodes = new Map(brains.map((b) => [b.id, {
    id: b.id, name: b.name, role: b.role, parent: b.parent ?? null,
    account: b.account, cli: b.cli, children: [],
  }]));
  /** @type {Record<string, any>[]} */
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list) => {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * TPS is owned by `src/metrics/tps.js` (h1). It may not exist yet and its export name is not
 * fixed, so probe the plausible readers and return null when the module is absent.
 * @param {Record<string, any>} opts
 */
async function readTps(opts) {
  if (opts.tps !== undefined) return opts.tps;
  if (opts.readTps) return opts.readTps();
  try {
    const mod = await import('../metrics/tps.js');
    for (const name of ['current', 'snapshot', 'read', 'get']) {
      if (typeof mod[name] === 'function') return (await mod[name]()) ?? null;
    }
    return mod.tps ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- console messages

const ENVELOPE_RE = /^(?:\[[^\]\n]*\]\s*)+/;
const TRAILER_RE = /\s*\(sbb:[0-9a-f]{8}\)\s*$/;
const NAMED_ID_RE = /^(.*?)#([A-Z]+-\d+)$/;

/**
 * The body of an envelope (docs/spec/receipts.md): drop the leading `[name#id@account/cli:coord][role]`
 * groups and the `(sbb:xxxxxxxx)` trailer. Plain text passes through.
 * @param {string} text
 */
export function messageBody(text) {
  return String(text ?? '').replace(ENVELOPE_RE, '').replace(TRAILER_RE, '').trim();
}

/** @param {number} t */
function clock(t) {
  const d = new Date(Number(t) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** @param {any[]|undefined} receipts one summary for a fan-out's per-member receipts */
function receiptSummary(receipts) {
  const list = (receipts ?? []).filter(Boolean);
  if (list.length === 0) return null;
  const statuses = list.map((r) => r.status);
  const status = statuses.every((s) => s === 'delivered') ? 'delivered'
    : statuses.some((s) => s === 'delivered' || s === 'queued') ? 'queued'
      : statuses.includes('unverified') ? 'unverified' : 'blocked';
  if (list.length === 1) return { status, via: list[0].via ?? null, elapsedMs: list[0].elapsedMs ?? null };
  return { status, via: 'channel', elapsedMs: null, count: list.length };
}

/**
 * One console message (docs/spec/web-console.md) from a team-log line, a receipt-log line or
 * an inbox mirror entry: `from` is the sender's brain id when known (else its name, or
 * `user`), `fromName` the display name, `text` the envelope body, `receipt` one summary.
 * `team` (main id) and `thread` (brain id) say which console conversation it belongs to.
 * @param {Record<string, any>} entry
 * @param {{ team?: string|null, thread?: string|null }} [place]
 */
export function consoleMessage(entry, place = {}) {
  const rawFrom = String(entry.from ?? '');
  const isUser = rawFrom === 'user' || (rawFrom === '' && !entry.fromId);
  const named = NAMED_ID_RE.exec(rawFrom);
  const name = isUser ? '你' : named ? named[1] || named[2] : rawFrom;
  const id = isUser ? 'user' : entry.fromId ?? (named ? named[2] : null) ?? name;
  const receipt = Array.isArray(entry.receipts)
    ? receiptSummary(entry.receipts)
    : entry.status ? { status: entry.status, via: entry.via ?? null, elapsedMs: entry.elapsedMs ?? null } : null;
  return {
    msgId: entry.msgId ?? null,
    t: Number(entry.t) || 0,
    at: clock(entry.t),
    from: id,
    fromName: name,
    to: entry.channel ?? entry.toId ?? entry.to ?? null,
    text: messageBody(entry.text ?? entry.textPreview ?? ''),
    replyTo: entry.replyTo ?? null,
    receipt,
    ...(Array.isArray(entry.receipts) ? { receipts: entry.receipts } : {}),
    ...(place.team ? { team: place.team } : {}),
    ...(place.thread ? { thread: place.thread } : {}),
  };
}

/** The console shows this many lines per team channel and per private thread from cold. */
export const CHANNEL_LIMIT = 300;

/** @param {Record<string, any>} opts */
function safeCatalog(opts) {
  try {
    return (opts.catalog ?? defaultCatalog)();
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, any>[]} accounts @param {{ account: string, cli: string }[]} rows
 */
function withClis(accounts, rows) {
  return accounts.map((account) => {
    const known = new Set(Array.isArray(account.clis) ? account.clis : []);
    for (const row of rows) if (row.account === account.name && row.cli) known.add(row.cli);
    return { ...account, clis: [...known] };
  });
}

/**
 * Working directories used before, newest first and unique: what the spawn dialog offers as
 * quick picks (docs/spec/ui-server.md).
 * @param {Record<string, any>[]} brains @param {Record<string, any>[]} retired
 * @returns {string[]}
 */
export function recentCwds(brains, retired, limit = 10) {
  const seen = new Set();
  const out = [];
  const all = [...brains, ...retired]
    .filter((b) => typeof b?.cwd === 'string' && b.cwd.trim() !== '')
    .sort((a, b) => (b.retiredAt ?? b.createdAt ?? 0) - (a.retiredAt ?? a.createdAt ?? 0));
  for (const brain of all) {
    if (seen.has(brain.cwd)) continue;
    seen.add(brain.cwd);
    out.push(brain.cwd);
    if (out.length >= limit) break;
  }
  return out;
}

/** @param {{ sbbDir: string }} where @param {Record<string, any>} opts */
function teamsState(where, opts) {
  const channels = (opts.allChannels ?? allChannels)({ listBrains: opts.listBrains ?? listBrains });
  return channels.map((channel) => {
    const mainId = channel.main?.id ?? null;
    const lines = mainId ? (opts.readTeamLog ?? readTeamLog)(mainId, { ...where, limit: CHANNEL_LIMIT }) : [];
    return {
      id: channel.id,
      name: `#${channel.name}`,
      mainId,
      count: channel.members.length,
      members: channel.members.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      messages: lines.map((line) => consoleMessage(line, { team: mainId })),
    };
  });
}

/**
 * One private thread per brain: what the user and that brain exchanged, from the receipt log
 * (outbound), the brain's inbox mirror (what it received) and the user's inbox (its replies).
 * @param {Record<string, any>} opts @param {Record<string, any>[]} brains @param {Record<string, any>[]} receipts
 */
function threadsState(opts, brains, receipts, teams = []) {
  const inbox = opts.listInbox ?? listInbox;
  const userInbox = inbox('user').map(({ entry }) => entry);
  // A brain's reply to a channel message belongs in the channel too, so the group reads
  // like a conversation and not like a list of announcements.
  const channelOf = new Map();
  for (const team of teams) for (const message of team.messages) if (message.msgId) channelOf.set(message.msgId, team);
  for (const entry of userInbox) {
    const team = entry.replyTo ? channelOf.get(entry.replyTo) : undefined;
    if (team && !team.messages.some((m) => m.msgId === entry.msgId)) {
      team.messages.push(consoleMessage({ ...entry, to: 'user' }, { team: team.mainId, thread: entry.fromId ?? entry.from ?? null }));
    }
  }
  for (const team of teams) team.messages.sort((a, b) => a.t - b.t);
  return brains.map((brain) => {
    const ids = new Set([brain.id, brain.name].filter(Boolean));
    const seen = new Set();
    const merged = [];
    const add = (entry) => {
      const key = entry.msgId ?? `${entry.t}:${entry.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(entry);
    };
    for (const entry of (opts.messagesFor ?? messagesFor)({ brainId: brain.id, brainName: brain.name, limit: CHANNEL_LIMIT, receipts, inbox })) add(entry);
    for (const entry of userInbox) if (ids.has(entry.fromId) || ids.has(entry.from)) add({ ...entry, to: 'user' });
    merged.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    return {
      id: brain.id,
      with: brain.id,
      title: brain.name,
      messages: merged.slice(-CHANNEL_LIMIT).map((entry) => consoleMessage(entry, { thread: brain.id })),
    };
  });
}

/**
 * The `/api/state` object: everything the console needs to render from cold. `receipts` is the
 * newest `RECEIPTS_LIMIT` receipt-log lines, newest first, with the log's own fields.
 * @param {Record<string, any>} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function snapshot(opts = {}) {
  const dir = opts.sbbDir ?? sbbDir();
  const where = { sbbDir: dir };
  const brains = (opts.listBrains ?? listBrains)();
  /** @type {Record<string, any>[]} */
  let quota = [];
  try {
    quota = await (opts.readQuota ?? readQuota)({ dbPath: opts.quotaDbPath, env: opts.env });
  } catch {
    quota = [];
  }
  const receipts = (opts.readReceipts ?? readReceiptEntries)();
  const teams = teamsState(where, opts);
  const catalogRows = safeCatalog(opts);
  return {
    brains,
    tree: buildTree(brains),
    // Every CLI the catalog knows for the account (claude, codex, agy, cursor, ...), so the
    // spawn dialog offers what can actually be launched there, not just claude/codex.
    accounts: withClis((opts.accountList ?? accountList)({ ...where, brains }), catalogRows),
    recentCwds: recentCwds(brains, (opts.listRetiredBrains ?? listRetiredBrains)()),
    quota,
    policy: (opts.readConfig ?? readConfig)(where),
    held: (opts.listHeld ?? listHeld)(where),
    plans: (opts.listPlans ?? listPlans)(where),
    claims: (opts.listAllClaims ?? listAllClaims)(where),
    tps: await readTps(opts),
    teams,
    threads: threadsState(opts, brains, receipts, teams),
    receipts: receipts.slice(-RECEIPTS_LIMIT).reverse(),
    version: VERSION,
  };
}

/** @param {string} [root] */
function inboxFiles(root = inboxRoot()) {
  let owners;
  try {
    owners = readdirSync(root);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const owner of owners.sort()) {
    let files;
    try {
      files = readdirSync(join(root, owner));
    } catch {
      continue;
    }
    for (const name of files) if (name.endsWith('.json')) out.push(join(root, owner, name));
  }
  return out;
}

/**
 * Watch SBB's state and call `onEvent(kind, object)` with the full updated object for every
 * change. `kind` is one of the ui-server.md event names: `brain`, `receipt`, `message`,
 * `held`, `plan`, `claim`, `quota`, `tps`, `policy`. A 30 s re-snapshot emits `quota` and
 * `tps` when they moved and covers fs events that were missed.
 * @param {(kind: string, object: Record<string, any>) => void} onEvent
 * @param {Record<string, any>} [opts]
 * @returns {{ close: () => void, flush: () => void, refresh: () => Promise<Record<string, any>> }}
 */
export function watch(onEvent, opts = {}) {
  const dir = opts.sbbDir ?? sbbDir();
  const where = { sbbDir: dir };
  const debounceMs = opts.debounceMs ?? 150;
  const resnapshotMs = opts.resnapshotMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  let closed = false;

  const emit = (kind, object) => {
    if (closed) return;
    try {
      onEvent(kind, object);
    } catch {
      // a throwing listener must not stop the watcher
    }
  };

  /** @type {Map<string, number>} */
  const teamOffsets = new Map();
  /** msgId -> main id of the channel it was posted to, so replies can be filed under it. */
  const channelByMsgId = new Map();
  for (const id of listTeamLogIds(where)) {
    for (const entry of readTeamLog(id, { ...where })) if (entry?.msgId) channelByMsgId.set(entry.msgId, id);
  }
  let receiptOffset = 0;
  const seenInbox = new Set();
  const cache = {
    brains: new Map(),
    held: new Map(),
    plans: new Map(),
    claims: new Map(),
    policy: null,
    quota: null,
    tps: null,
  };

  const brainKey = (b) => b.id;
  const heldKey = (h) => String(h.msgId ?? '');
  const planKey = (p) => String(p.planId ?? '');
  const claimKey = (c) => `${c.brain}:${c.resource}`;

  function prime() {
    receiptOffset = readCompleteLines(receiptLogPath(), 0).offset;
    for (const id of listTeamLogIds(where)) {
      teamOffsets.set(id, readCompleteLines(teamLogPath(id, where), 0).offset);
    }
    for (const file of inboxFiles()) seenInbox.add(file);
    cache.brains = byKey(listBrains(), brainKey);
    cache.held = byKey((opts.listHeld ?? listHeld)(where), heldKey);
    cache.plans = byKey((opts.listPlans ?? listPlans)(where), planKey);
    cache.claims = byKey((opts.listAllClaims ?? listAllClaims)(where), claimKey);
    cache.policy = (opts.readConfig ?? readConfig)(where);
  }

  /** @param {string} kind @param {Map<string, any>} next @param {Map<string, any>} before */
  function emitDiff(kind, next, before) {
    for (const [key, value] of next) {
      const previous = before.get(key);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(value)) emit(kind, value);
    }
    for (const [key, value] of before) {
      if (!next.has(key)) emit(kind, { ...value, removed: true });
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (closed) return;

    const receipts = readCompleteLines(receiptLogPath(), receiptOffset);
    receiptOffset = receipts.offset;
    for (const entry of receipts.lines) emit('receipt', entry);

    const root = inboxRoot();
    for (const file of inboxFiles(root)) {
      if (seenInbox.has(file)) continue;
      seenInbox.add(file);
      const entry = readJson(file);
      if (!entry) continue;
      // The mirror's owner is who received it: a brain's own inbox belongs to that brain's
      // thread; the user's inbox holds replies, filed under the sender's thread.
      const owner = file.slice(root.length + 1).split('/')[0];
      const thread = owner === 'user' ? entry.fromId ?? entry.from ?? null : owner;
      const team = entry.team ?? (entry.replyTo ? channelByMsgId.get(entry.replyTo) : null) ?? null;
      emit('message', consoleMessage(entry, { thread, team }));
    }

    for (const id of listTeamLogIds(where)) {
      const from = teamOffsets.get(id) ?? 0;
      const tail = readCompleteLines(teamLogPath(id, where), from);
      teamOffsets.set(id, tail.offset);
      for (const entry of tail.lines) {
        if (entry.msgId) channelByMsgId.set(entry.msgId, id);
        emit('message', consoleMessage(entry, { team: id }));
      }
    }

    const brains = byKey(listBrains(), brainKey);
    emitDiff('brain', brains, cache.brains);
    cache.brains = brains;

    const held = byKey((opts.listHeld ?? listHeld)(where), heldKey);
    emitDiff('held', held, cache.held);
    cache.held = held;

    const plans = byKey((opts.listPlans ?? listPlans)(where), planKey);
    emitDiff('plan', plans, cache.plans);
    cache.plans = plans;

    const claims = byKey((opts.listAllClaims ?? listAllClaims)(where), claimKey);
    emitDiff('claim', claims, cache.claims);
    cache.claims = claims;

    const policy = (opts.readConfig ?? readConfig)(where);
    if (JSON.stringify(policy) !== JSON.stringify(cache.policy)) {
      cache.policy = policy;
      emit('policy', policy);
    }
  }

  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  prime();

  /** @type {import('node:fs').FSWatcher[]} */
  const watchers = [];
  const targets = [
    { path: join(dir, 'brains'), recursive: true },
    { path: join(dir, 'log'), recursive: true },
    { path: join(dir, 'inbox'), recursive: true },
    { path: join(dir, 'held'), recursive: true },
    { path: join(dir, 'plans'), recursive: true },
    { path: join(dir, 'claims'), recursive: true },
    { path: join(dir, 'teams'), recursive: true },
    { path: join(dir, 'config.json'), recursive: false },
  ];
  for (const target of targets) {
    try {
      const watcher = fsWatch(target.path, { recursive: target.recursive }, () => schedule());
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // not created yet; the 30 s re-snapshot covers it
    }
  }
  if (watchers.length === 0) {
    try {
      const watcher = fsWatch(dir, { recursive: true }, () => schedule());
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // nothing to watch
    }
  }

  const refresh = () => snapshot({ ...opts, sbbDir: dir });

  void (async () => {
    const state = await refresh();
    cache.quota = state.quota;
    cache.tps = state.tps;
  })();

  const resnapshotTimer = setInterval(() => {
    if (closed) return;
    flush();
    void (async () => {
      const state = await refresh();
      if (closed) return;
      if (JSON.stringify(state.quota) !== JSON.stringify(cache.quota)) {
        cache.quota = state.quota;
        emit('quota', state.quota);
      }
      if (JSON.stringify(state.tps) !== JSON.stringify(cache.tps)) {
        cache.tps = state.tps;
        emit('tps', state.tps);
      }
    })();
  }, resnapshotMs);
  resnapshotTimer.unref?.();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(resnapshotTimer);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // already gone
        }
      }
    },
    flush,
    refresh,
  };
}

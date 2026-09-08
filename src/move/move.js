// sbb move: re-parent a brain and its whole subtree without touching its process, so its
// conversation context survives. docs/spec/move.md.
//
// Planning is pure over an injected registry (`getBrain` / `listBrains` / `rows`), so the
// cycle, liveness and no-op decisions are testable without tmux, sockets or a real ~/.sbb.
// Nothing here touches tmux layout: `move` never moves a pane.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as defaultRun } from '../lib/exec.js';
import { sbbDir } from '../lib/paths.js';
import * as tmuxLib from '../lib/tmux.js';
import { ROLE_LABELS } from '../registry/envelope.js';
import { getBrain, listBrains, saveBrain as defaultSaveBrain } from '../registry/brains.js';
import { formatReceiptLine } from '../registry/receipts.js';
import { ResolveError, resolve as defaultResolve } from '../registry/resolve.js';
import { profileFor } from '../transports/cli-profiles.js';
import { readClaudeStatus } from '../transports/confirm.js';
import {
  deliver as defaultDeliver,
  openDeliveryInbox as defaultOpenInbox,
} from '../cli/util.js';

/** @typedef {import('../types.js').Brain} Brain */
/** @typedef {import('../types.js').Target} Target */

/** `--to root` makes the brain a main brain again. */
export const ROOT = 'root';
/** Default `--wait`: 30 minutes (docs/spec/move.md). */
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
/** Poll interval while waiting for the brain to go idle. */
export const POLL_MS = 5000;
const CAPTURE_LINES = 60;
const HANDOFF_WAIT = '10m';
/** The child `sbb ask` waits up to 10m; give it a minute of slack before killing it. */
const HANDOFF_TIMEOUT_MS = 11 * 60 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `name#id` of a brain record, or 用户 when there is none (root / the user). */
function display(brain) {
  return brain ? `${brain.name}#${brain.id}` : ROLE_LABELS.user;
}

/**
 * Every descendant of `id`, breadth first, by `parent` links. Brains whose parent is
 * unknown stay out (they are not part of this subtree). A malformed parent cycle cannot
 * loop: an id is collected once.
 * @param {string} id
 * @param {Brain[]} brains
 * @returns {Brain[]}
 */
export function subtreeOf(id, brains) {
  /** @type {Brain[]} */
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const brain of brains) {
      if (seen.has(brain.id) || !frontier.includes(brain.parent)) continue;
      seen.add(brain.id);
      out.push(brain);
      next.push(brain.id);
    }
    frontier = next;
  }
  return out;
}

/**
 * Decide what a move would do, without changing anything.
 *
 * Throws ResolveError (exit 4) when the brain or the new parent does not exist: an
 * address that cannot be resolved is not a plan. Everything else that stops a move is a
 * failed entry in `checks`, so the caller can print it and pick the exit code:
 *  - `not_already_there` (reason `nothing_to_do`) -> exit 0
 *  - `no_cycle` (reason `policy`, detail `would create a cycle`) -> exit 4
 *  - `target_live` (reason `target_not_found`) -> exit 4; only checked when `rows` is given
 *
 * @param {string} brainRef brain id or name
 * @param {string} targetRef brain id, name, or `root`
 * @param {{ getBrain?: (ref: string) => Brain|undefined, listBrains?: () => Brain[],
 *           rows?: import('../registry/roster.js').RosterRow[] }} [opts]
 * @returns {{ brain: Brain, from: {parent: string|null, parentName: string|null, role: string},
 *            to: {parent: string|null, parentName: string|null, role: 'main'|'sub', ref: string},
 *            subtree: {id: string, name: string, role: string, parent: string|null}[],
 *            roleAfter: 'main'|'sub',
 *            checks: {name: string, ok: boolean, reason?: string, detail?: string}[] }}
 */
export function planMove(brainRef, targetRef, { getBrain: lookup = getBrain, listBrains: list = listBrains, rows } = {}) {
  const brain = lookup(brainRef);
  if (!brain) throw new ResolveError('target_not_found', `unknown brain "${brainRef}"`, 'no brain record');
  const raw = String(targetRef ?? '').trim();
  if (!raw) throw new ResolveError('target_not_found', 'move needs --to <id|name|root>');

  let parent = null;
  if (raw !== ROOT) {
    parent = lookup(raw);
    if (!parent) throw new ResolveError('target_not_found', `unknown brain "${raw}"`, 'no brain record');
  }
  const brains = list();
  const subtree = subtreeOf(brain.id, brains);
  const toParent = parent ? parent.id : null;
  const roleAfter = toParent ? 'sub' : 'main';

  const alreadyThere = brain.parent === toParent;
  const cycle = toParent !== null && (toParent === brain.id || subtree.some((b) => b.id === toParent));
  const live = !parent || !Array.isArray(rows)
    ? true
    : rows.some((r) => r.brainId === parent.id && r.paneId !== null && r.status !== 'stale');

  /** @type {{name: string, ok: boolean, reason?: string, detail?: string}[]} */
  const checks = [
    {
      name: 'not_already_there',
      ok: !alreadyThere,
      reason: alreadyThere ? 'nothing_to_do' : undefined,
      detail: alreadyThere
        ? (toParent ? `${display(brain)} is already under ${display(parent)}` : `${display(brain)} is already a main brain`)
        : undefined,
    },
    {
      name: 'no_cycle',
      ok: !cycle,
      reason: cycle ? 'policy' : undefined,
      detail: cycle ? 'would create a cycle' : undefined,
    },
    {
      name: 'target_live',
      ok: live,
      reason: live ? undefined : 'target_not_found',
      detail: live ? undefined : `${display(parent)} has no live pane`,
    },
  ];

  const oldParent = brain.parent ? lookup(brain.parent) : undefined;
  return {
    brain,
    from: { parent: brain.parent ?? null, parentName: oldParent?.name ?? null, role: brain.role },
    to: { parent: toParent, parentName: parent?.name ?? null, role: roleAfter, ref: raw },
    subtree: subtree.map((b) => ({ id: b.id, name: b.name, role: b.role, parent: b.parent })),
    roleAfter,
    checks,
  };
}

/** @param {ReturnType<typeof planMove>} plan */
export function firstFailure(plan) {
  return plan.checks.find((check) => !check.ok);
}

/**
 * Re-parent the record: `parent` and `role` follow the plan, `pendingMove` is cleared.
 * Children are untouched, so the subtree moves with it. One atomic write (saveBrain).
 * @param {ReturnType<typeof planMove>} plan
 * @param {{ saveBrain?: (brain: Brain) => Brain }} [opts]
 * @returns {Brain} the stored record
 */
export function applyMove(plan, { saveBrain = defaultSaveBrain } = {}) {
  const updated = { ...plan.brain, parent: plan.to.parent, role: plan.roleAfter };
  delete updated.pendingMove;
  return saveBrain(updated);
}

/**
 * Is the brain idle right now? Claude answers from its session registry (the spec's
 * source); every other CLI is judged from its pane through the shared idle fingerprint.
 * A missing record, a dead pane or an unreadable screen is "not idle", never a guess.
 * @param {Brain} brain
 * @param {{ readStatus?: (target: Target) => Promise<string|undefined>, tmuxApi?: typeof tmuxLib }} opts
 */
export async function isIdle(brain, { readStatus = readClaudeStatus, tmuxApi = tmuxLib } = {}) {
  if (brain.cli === 'claude' && brain.pid) {
    try {
      const status = await readStatus({
        address: brain.name,
        account: brain.account,
        cli: 'claude',
        paneId: brain.paneId,
        coord: brain.coord ?? null,
        claude: { pid: brain.pid },
      });
      return status === 'idle';
    } catch {
      return false;
    }
  }
  if (!brain.paneId) return false;
  try {
    const screen = await tmuxApi.capturePane(brain.paneId, CAPTURE_LINES);
    return screen !== undefined && profileFor(brain.cli).idle(screen);
  } catch {
    return false;
  }
}

/**
 * Wait until the brain is idle, polling every `pollMs` (spec: 5 s) up to `timeoutMs`.
 *
 * `pendingMove` is written to the record before the first poll and cleared again as soon
 * as the brain is idle, so `sbb ls` shows the intended destination while the wait lasts.
 * On timeout the marker stays: the CLI prints how to finish with `--now` (exit 5).
 *
 * @param {Brain} brain
 * @param {{ timeoutMs?: number, pollMs?: number,
 *           pendingMove?: {to: string, requestedAt: number, handoff: string|null},
 *           readStatus?: (target: Target) => Promise<string|undefined>,
 *           tmuxApi?: typeof tmuxLib, saveBrain?: (brain: Brain) => Brain,
 *           sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts]
 * @returns {Promise<{status: 'idle'|'timeout', polls: number, elapsedMs: number}>}
 */
export async function waitIdle(brain, {
  timeoutMs = DEFAULT_WAIT_MS,
  pollMs = POLL_MS,
  pendingMove,
  readStatus = readClaudeStatus,
  tmuxApi = tmuxLib,
  saveBrain = defaultSaveBrain,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const started = now();
  if (pendingMove !== undefined) saveBrain({ ...brain, pendingMove });
  const deadline = started + Math.max(0, Number(timeoutMs) || 0);
  let polls = 0;
  for (;;) {
    polls += 1;
    if (await isIdle(brain, { readStatus, tmuxApi })) {
      if (pendingMove !== undefined) {
        const cleared = { ...brain };
        delete cleared.pendingMove;
        saveBrain(cleared);
      }
      return { status: 'idle', polls, elapsedMs: now() - started };
    }
    if (now() >= deadline) return { status: 'timeout', polls, elapsedMs: now() - started };
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/** `~/.sbb/handoff/<id>-<YYYYMMDD-HHMMSS>.md` (honours SBB_DIR). */
export function handoffPath(id, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return join(sbbDir(), 'handoff', `${id}-${stamp}.md`);
}

/** The exact question docs/spec/move.md puts to the brain. */
export function handoffQuestion(path) {
  return `请把当前任务、进度、未决项和相关文件写成交接摘要到 ${path}，写完回复 done`;
}

/** Non-empty summary file? A zero-byte file means the brain created it and wrote nothing. */
function defaultFileHasContent(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * Ask the brain for a handoff summary: `sbb ask <brain> "<question>" --wait 10m`, spawned
 * as a child process with the same environment (injectable for tests).
 *
 * `ok` is the ask's own verdict: the brain replied through sbb. `wrote` is the file check,
 * and it is the stronger signal in practice: measured 2026-09-09, a real Claude brain
 * writes the summary and answers in its own pane without ever replying through sbb, so the
 * ask sits out its full 10m and exits 5 while a complete summary is already on disk.
 * Callers use `ok || wrote` to decide whether a summary exists; a genuine timeout (neither)
 * is not an error, the caller records `handoff: null` and moves on (docs/spec/move.md step 1).
 * @param {Brain} brain
 * @param {{ path?: string, wait?: string, run?: typeof defaultRun,
 *           binPath?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number,
 *           mkdir?: boolean, fileHasContent?: (file: string) => boolean|Promise<boolean> }} [opts]
 * @returns {Promise<{path: string, ok: boolean, wrote: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export async function requestHandoff(brain, {
  path,
  wait = HANDOFF_WAIT,
  run = defaultRun,
  binPath = fileURLToPath(new URL('../../bin/sbb.js', import.meta.url)),
  env = process.env,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  mkdir = true,
  fileHasContent = defaultFileHasContent,
} = {}) {
  const file = path ?? handoffPath(brain.id);
  if (mkdir) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const result = await run(process.execPath, [binPath, 'ask', brain.name, handoffQuestion(file), '--wait', wait], {
    env,
    timeoutMs,
  });
  const ok = result?.code === 0;
  return {
    path: file,
    ok,
    wrote: ok ? true : await fileHasContent(file),
    code: result?.code ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    timedOut: Boolean(result?.timedOut),
  };
}

/**
 * Tell the three parties, in the spec's order, through the normal delivery path:
 * the old parent, the new parent (unless it is the user), then the brain itself.
 * A blocked notification is reported and never rolls the move back.
 *
 * The envelope is built by `deliver`, so callers pass only the body. When the caller is
 * not a registered brain the role is 用户, exactly as the spec words it.
 *
 * @param {ReturnType<typeof planMove>} plan
 * @param {string|null} handoffPath resolved handoff summary, or null when none was made
 * @param {{ resolve?: typeof defaultResolve, deliver?: typeof defaultDeliver,
 *           openInbox?: typeof defaultOpenInbox, closeInboxes?: () => Promise<void>|void,
 *           identity?: Record<string, any>, deps?: Record<string, any>,
 *           print?: (line: string) => void }} [opts]
 * @returns {Promise<{to: string, status: string, reason?: string, receipt?: any}[]>}
 */
export async function notify(plan, handoffPath, {
  resolve = defaultResolve,
  deliver: send = defaultDeliver,
  openInbox = defaultOpenInbox,
  closeInboxes,
  identity = {},
  deps = {},
  print = (line) => console.log(line),
} = {}) {
  const who = { ...identity, role: identity.brain ? identity.role : ROLE_LABELS.user };
  const me = `${plan.brain.name}#${plan.brain.id}`;
  const newParent = plan.to.parent ? `${plan.to.parentName}#${plan.to.parent}` : ROLE_LABELS.user;
  const oldParent = plan.from.parent ? `${plan.from.parentName}#${plan.from.parent}` : ROLE_LABELS.user;
  const summary = handoffPath ?? '无';

  /** @type {{address: string, text: string}[]} */
  const messages = [];
  if (plan.from.parent) messages.push({ address: plan.from.parent, text: `${me} 已划归 ${newParent} 名下` });
  if (plan.to.parent) messages.push({ address: plan.to.parent, text: `${me} 已加入你的名下，原上级 ${oldParent}，交接摘要 ${summary}` });
  messages.push({ address: plan.brain.id, text: `你的上级现在是 ${newParent}，回执与上报改发给它` });

  /** @type {{to: string, status: string, reason?: string, receipt?: any}[]} */
  const out = [];
  for (const item of messages) {
    let target;
    try {
      target = await resolve(item.address, { rows: deps.rows, accounts: deps.accounts, onWarn: deps.onWarn });
    } catch (err) {
      const reason = err?.reason ?? 'target_not_found';
      print(`blocked    ${item.address}  reason=${reason}  ${err?.message ?? err}`);
      out.push({ to: item.address, status: 'blocked', reason });
      continue;
    }
    const inbox = await openInbox({ target, owner: who.brain ?? 'user', deps });
    try {
      const { receipt } = await send({ target, body: item.text, identity: who, deps, send: deps.send, inbox });
      print(`${item.address.padEnd(10)} ${formatReceiptLine(receipt)}`);
      out.push({ to: item.address, status: receipt.status, receipt });
    } finally {
      await inbox?.close?.();
    }
  }
  if (closeInboxes) await closeInboxes();
  return out;
}

// sbb kill. docs/spec/lifecycle.md section "sbb kill".
// Graceful CLI exit first (typed transport rules: only into an idle composer), then
// kill-pane, then retire the records, release claims and notify the parent.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import * as tmuxLib from '../lib/tmux.js';
import { getBrain, listBrains, removeBrain, saveBrain } from '../registry/brains.js';
import { ROLE_LABELS } from '../registry/envelope.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { profileFor } from '../transports/cli-profiles.js';
import { deliver as defaultDeliver } from '../cli/util.js';
import { EXIT_COMMANDS } from './launch.js';

export const EXIT_WAIT_MS = 3000;
export const EXIT_POLL_MS = 250;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `~/.sbb/claims/<id>.json` (docs/spec/policy.md section "Claims"). */
export function claimsPath(id, { dir } = {}) {
  return join(dir ?? sbbDir(), 'claims', `${id}.json`);
}

/**
 * The subtree a kill touches. Children come before their parent so a record never
 * disappears while a live child still names it. `--keep-children` leaves the direct
 * children alive and re-parents them to the killed brain's parent instead.
 * @param {string|import('../types.js').Brain} ref
 * @param {{ keepChildren?: boolean, brains?: import('../types.js').Brain[],
 *           getBrainFn?: (ref: string) => import('../types.js').Brain|undefined }} [opts]
 * @returns {{ root: import('../types.js').Brain, victims: import('../types.js').Brain[],
 *             keep: import('../types.js').Brain[] }|undefined}
 */
export function killPlan(ref, { keepChildren = false, brains, getBrainFn = getBrain } = {}) {
  const all = brains ?? listBrains();
  const root = typeof ref === 'object' && ref ? ref : (getBrainFn(ref) ?? all.find((b) => b.id === ref || b.name === ref));
  if (!root) return undefined;
  /** @type {Map<string, import('../types.js').Brain[]>} */
  const byParent = new Map();
  for (const brain of all) {
    if (!brain.parent) continue;
    byParent.set(brain.parent, [...(byParent.get(brain.parent) ?? []), brain]);
  }
  /** @type {import('../types.js').Brain[]} */
  const victims = [];
  /** @type {import('../types.js').Brain[]} */
  const keep = [];
  const walk = (brain) => {
    for (const child of byParent.get(brain.id) ?? []) {
      if (keepChildren) keep.push(child);
      else walk(child);
    }
    victims.push(brain);
  };
  walk(root);
  return { root, victims, keep };
}

/**
 * Re-parent one surviving child. The killed brain's parent becomes the new parent; a
 * main brain with no parent makes its children main too (a sub brain must have a parent).
 * @param {import('../types.js').Brain} child
 * @param {import('../types.js').Brain} root
 * @param {{ saveBrainFn?: typeof saveBrain }} [opts]
 */
export function reparentChild(child, root, { saveBrainFn = saveBrain } = {}) {
  const record = root.parent
    ? { ...child, parent: root.parent }
    : { ...child, role: 'main', parent: null };
  return saveBrainFn(record);
}

/** @param {typeof tmuxLib} tmuxApi @param {string} paneId */
async function paneAlive(tmuxApi, paneId) {
  try {
    const panes = await tmuxApi.listPanes();
    return panes.some((p) => p.paneId === paneId);
  } catch {
    // Cannot tell: the caller's kill-pane reports its own failure, so assume alive.
    return true;
  }
}

/** @param {typeof tmuxLib} tmuxApi @param {string} paneId */
async function killPane(tmuxApi, paneId) {
  await tmuxApi.tmux(['kill-pane', '-t', paneId]);
}

/**
 * Stop one brain's CLI. Types the CLI's own exit command only into an idle composer,
 * waits EXIT_WAIT_MS for the pane to disappear, and falls back to kill-pane.
 * @param {import('../types.js').Brain} brain
 * @param {{ tmuxApi?: typeof tmuxLib, force?: boolean, waitMs?: number, pollMs?: number,
 *           sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function gracefulExit(brain, deps = {}) {
  const tmuxApi = deps.tmuxApi ?? tmuxLib;
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = deps.waitMs ?? EXIT_WAIT_MS;
  const pollMs = deps.pollMs ?? EXIT_POLL_MS;
  const exitCommand = EXIT_COMMANDS[brain.cli];

  let paneId = null;
  try {
    paneId = await tmuxApi.resolvePaneId(brain.paneId);
  } catch {
    paneId = null;
  }
  if (!paneId) return { paneId: null, typed: false, killed: false, detail: 'pane already gone' };

  if (!deps.force && exitCommand) {
    let screen;
    try {
      screen = await tmuxApi.capturePane(paneId, 60);
    } catch (err) {
      return { paneId, typed: false, killed: false, detail: `cannot read the pane: ${err?.message ?? err}` };
    }
    const profile = profileFor(brain.cli);
    if (profile.idle(screen)) {
      await tmuxApi.sendLiteral(paneId, exitCommand);
      await tmuxApi.sendKey(paneId, 'Enter');
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        if (!(await paneAlive(tmuxApi, paneId))) {
          return { paneId, typed: true, killed: false, detail: `exited after ${exitCommand}` };
        }
      }
      await killPane(tmuxApi, paneId);
      return { paneId, typed: true, killed: true, detail: `alive ${waitMs}ms after ${exitCommand}; kill-pane` };
    }
    await killPane(tmuxApi, paneId);
    return { paneId, typed: false, killed: true, detail: 'pane was not idle; kill-pane' };
  }

  await killPane(tmuxApi, paneId);
  return {
    paneId,
    typed: false,
    killed: true,
    detail: deps.force ? 'forced kill-pane' : `no exit command for cli ${brain.cli}; kill-pane`,
  };
}

/**
 * Release every claim a brain holds (docs/spec/policy.md: killing releases them).
 * @param {string} id
 * @param {{ dir?: string }} [opts]
 * @returns {'released'|'none'}
 */
export function releaseClaims(id, opts = {}) {
  const path = claimsPath(id, opts);
  if (!existsSync(path)) return 'none';
  rmSync(path);
  return 'released';
}

/**
 * Notify a killed brain's parent with one line. A failure is reported, never hidden.
 * @param {import('../types.js').Brain} brain
 * @param {Record<string, any>} deps
 */
async function notifyParent(brain, deps) {
  const parentBrain = (deps.getBrain ?? getBrain)(brain.parent);
  if (!parentBrain) {
    return { status: 'blocked', reason: 'target_not_found', detail: `parent ${brain.parent} is not a live brain` };
  }
  const identity = {
    sender: brain.name,
    id: brain.id,
    account: brain.account,
    cli: brain.cli,
    coord: brain.coord ?? null,
    role: brain.role === 'sub' ? ROLE_LABELS.sub : ROLE_LABELS.main,
  };
  try {
    const target = await (deps.resolve ?? defaultResolve)(parentBrain.name, {
      accounts: deps.accounts,
      rows: deps.rows,
      onWarn: deps.onWarn,
    });
    const { receipt } = await (deps.deliver ?? defaultDeliver)({
      target,
      body: '已下线',
      identity,
      deps,
      send: deps.send,
    });
    return { status: receipt.status, via: receipt.via, reason: receipt.reason, detail: receipt.detail };
  } catch (err) {
    return { status: 'blocked', reason: 'notify_failed', detail: String(err?.message ?? err) };
  }
}

/**
 * Execute a kill plan: re-parent survivors, stop and retire every victim, release claims
 * and notify the root's parent once.
 * @param {ReturnType<typeof killPlan>} plan
 * @param {{ force?: boolean, tmuxApi?: typeof tmuxLib, sleep?: Function } & Record<string, any>} [deps]
 */
export async function killBrains(plan, deps = {}) {
  if (!plan) throw new Error('killBrains: no plan');
  /** @type {{ id: string, name: string, parent: string|null, role: string }[]} */
  const reparented = [];
  for (const child of plan.keep) {
    const record = reparentChild(child, plan.root, { saveBrainFn: deps.saveBrain ?? saveBrain });
    reparented.push({ id: record.id, name: record.name, parent: record.parent, role: record.role });
  }

  /** @type {Record<string, any>[]} */
  const results = [];
  for (const brain of plan.victims) {
    const exit = await (deps.gracefulExit ?? gracefulExit)(brain, {
      tmuxApi: deps.tmuxApi,
      force: deps.force,
      waitMs: deps.waitMs,
      pollMs: deps.pollMs,
      sleep: deps.sleep,
    });
    const retired = (deps.removeBrain ?? removeBrain)(brain.id);
    const claims = (deps.releaseClaims ?? releaseClaims)(brain.id, { dir: deps.claimsDir });
    results.push({ brain, exit, retired, claims });
  }

  let notification;
  if (plan.root.parent) notification = await notifyParent(plan.root, deps);
  return { results, reparented, notification };
}

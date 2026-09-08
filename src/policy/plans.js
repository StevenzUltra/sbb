// Team plans: ~/.sbb/plans/<planId>.json. A parent proposes the sub brains it wants; the user
// (or the parent, when autonomous) approves, and approve spawns them one by one.
// docs/spec/policy.md "Plans".
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sbbDir } from '../lib/paths.js';
import { run as runCommand } from '../lib/exec.js';
import { getBrain as defaultGetBrain, BRAIN_CLIS, isValidBrainName } from '../registry/brains.js';
import { checkMainReserve, checkQuotaFloor } from './quota.js';
import { ancestorIds } from './rules.js';

/** @typedef {import('../types.js').Brain} Brain */

/** Invalid plan input or plan state. */
export class PlanError extends Error {
  /** @param {string} message @param {string} [reason] */
  constructor(message, reason = 'invalid_plan') {
    super(message);
    this.name = 'PlanError';
    this.reason = reason;
  }
}

const SBB_BIN = fileURLToPath(new URL('../../bin/sbb.js', import.meta.url));

/** @param {{ sbbDir?: string }} [opts] */
export function plansDir(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'plans');
}

/** @param {string} planId @param {{ sbbDir?: string }} [opts] */
export function planPath(planId, opts = {}) {
  return join(plansDir(opts), `${planId}.json`);
}

/** @param {string} planId @param {{ sbbDir?: string }} [opts] */
export function resultPath(planId, opts = {}) {
  return join(plansDir(opts), `${planId}.result.json`);
}

/** @param {number} [now] */
export function newPlanId(now = Date.now()) {
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `PL-${now.toString(36).toUpperCase()}-${rand}`;
}

/** @param {string} path @param {Record<string, any>} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return value;
}

/**
 * Validate and normalize `{parent, reason, brains:[...]}`.
 * @param {Record<string, any>} input
 * @param {{ getBrain?: (ref: string) => Brain|undefined, accounts?: { name: string }[] }} [opts]
 * @returns {{ parent: string, reason: string, brains: Record<string, any>[] }}
 */
export function normalizePlan(input, opts = {}) {
  const getBrain = opts.getBrain ?? defaultGetBrain;
  if (!input || typeof input !== 'object') throw new PlanError('plan must be a JSON object');
  const parentRef = String(input.parent ?? '').trim();
  if (!parentRef) throw new PlanError('plan.parent is required');
  const parent = getBrain(parentRef);
  if (!parent) throw new PlanError(`unknown parent brain "${parentRef}"`, 'unknown_parent');
  if (!Array.isArray(input.brains) || input.brains.length === 0) {
    throw new PlanError('plan.brains must be a non-empty array');
  }
  const seen = new Set();
  const nodes = input.brains.map((node, i) => {
    const name = String(node?.name ?? '').trim();
    if (!isValidBrainName(name)) throw new PlanError(`brains[${i}]: invalid brain name "${name ?? ''}"`);
    if (seen.has(name)) throw new PlanError(`brains[${i}]: duplicate brain name "${name}"`, 'duplicate_name');
    seen.add(name);
    if (getBrain(name)) throw new PlanError(`brains[${i}]: brain name "${name}" is already in use`, 'duplicate_name');
    const role = node.role ?? 'sub';
    if (role !== 'main' && role !== 'sub') throw new PlanError(`brains[${i}]: role must be main|sub`);
    const cli = node.cli ?? 'claude';
    if (!BRAIN_CLIS.includes(cli)) throw new PlanError(`brains[${i}]: unknown cli "${cli}"`);
    const account = String(node.account ?? '').trim();
    if (!account) throw new PlanError(`brains[${i}]: account is required`);
    if (opts.accounts?.length && !opts.accounts.some((a) => a.name === account)) {
      throw new PlanError(`brains[${i}]: unknown account "${account}"`, 'unknown_account');
    }
    // Optional extra CLI flags for this node (e.g. --permission-mode bypassPermissions).
    // Kept as one string: `sbb spawn --cli-args` owns the splitting and quoting rules.
    if (node.cliArgs !== undefined && node.cliArgs !== null && typeof node.cliArgs !== 'string') {
      throw new PlanError(`brains[${i}]: cliArgs must be a string`);
    }
    const cliArgs = typeof node.cliArgs === 'string' && node.cliArgs.trim() !== '' ? node.cliArgs.trim() : undefined;
    return {
      name,
      role,
      account,
      cli,
      cliArgs,
      model: node.model ?? undefined,
      cwd: String(node.cwd ?? parent.cwd ?? ''),
      reason: String(node.reason ?? ''),
      load: node.load ?? undefined,
    };
  });
  return { parent: parent.id, reason: String(input.reason ?? ''), brains: nodes };
}

/**
 * Proposer must be the plan's parent or one of its ancestors; the user may always propose.
 * @param {{ parent: string }} plan @param {Brain|null|undefined} proposer
 * @param {{ getBrain?: (ref: string) => Brain|undefined }} [opts]
 */
export function mayPropose(plan, proposer, opts = {}) {
  if (!proposer) return true;
  const getBrain = opts.getBrain ?? defaultGetBrain;
  if (proposer.id === plan.parent) return true;
  const parent = getBrain(plan.parent);
  if (!parent) return false;
  return ancestorIds(parent, getBrain).includes(proposer.id);
}

/**
 * The user approves anything; the parent or an ancestor approves; an autonomous parent may
 * approve its own plan.
 * @param {{ parent: string }} plan @param {Brain|null|undefined} approver
 * @param {{ getBrain?: (ref: string) => Brain|undefined, config?: Record<string, any> }} [opts]
 */
export function mayApprove(plan, approver, opts = {}) {
  if (!approver) return true;
  const getBrain = opts.getBrain ?? defaultGetBrain;
  if (approver.id === plan.parent) {
    // a parent may only approve its own plan when it is marked autonomous
    return opts.config?.brains?.[plan.parent]?.autonomous === true;
  }
  const parent = getBrain(plan.parent);
  if (!parent) return false;
  return ancestorIds(parent, getBrain).includes(approver.id);
}

/**
 * @param {Record<string, any>} input @param {{ proposer?: Brain|null, getBrain?: Function,
 *   accounts?: { name: string }[], now?: number, sbbDir?: string }} [opts]
 */
export function createPlan(input, opts = {}) {
  const normalized = normalizePlan(input, opts);
  if (!mayPropose(normalized, opts.proposer, opts)) {
    throw new PlanError(`brain ${opts.proposer?.id} may not propose for parent ${normalized.parent}`, 'not_proposer');
  }
  const now = opts.now ?? Date.now();
  const plan = {
    planId: newPlanId(now),
    status: 'pending',
    proposedBy: opts.proposer?.id ?? 'user',
    proposedAt: now,
    ...normalized,
  };
  return writeJson(planPath(plan.planId, opts), plan);
}

/** @param {{ sbbDir?: string }} [opts] @returns {Record<string, any>[]} */
export function listPlans(opts = {}) {
  const dir = plansDir(opts);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.result.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      // skip unreadable plan files
    }
  }
  return out.sort((a, b) => (b.proposedAt ?? 0) - (a.proposedAt ?? 0));
}

/**
 * @param {string} ref plan id or prefix
 * @param {{ sbbDir?: string }} [opts]
 * @returns {{ plan: Record<string, any>, file: string } | undefined}
 */
export function getPlan(ref, opts = {}) {
  const prefix = String(ref ?? '').trim().toUpperCase();
  if (!prefix) return undefined;
  const hit = listPlans(opts).find((p) => String(p.planId).toUpperCase().startsWith(prefix));
  if (!hit) return undefined;
  return { plan: hit, file: planPath(hit.planId, opts) };
}

/** @param {Record<string, any>} plan @param {{ sbbDir?: string }} [opts] */
export function savePlan(plan, opts = {}) {
  return writeJson(planPath(plan.planId, opts), plan);
}

/** @param {Record<string, any>} plan @param {string} reason @param {{ sbbDir?: string }} [opts] */
export function rejectPlan(plan, reason, opts = {}) {
  plan.status = 'rejected';
  plan.rejectionReason = String(reason ?? '');
  plan.decidedAt = opts.now ?? Date.now();
  plan.decidedBy = opts.decidedBy ?? 'user';
  savePlan(plan, opts);
  return plan;
}

/**
 * `sbb spawn` argv for one plan node. Exported so tests can pin the flag mapping without
 * launching a child process.
 * @param {Record<string, any>} node
 * @returns {string[]}
 */
export function spawnArgs(node) {
  const args = [
    SBB_BIN,
    'spawn',
    '--name', node.name,
    '--role', node.role,
    '--account', node.account,
    '--cli', node.cli,
    '--json',
  ];
  if (node.role === 'sub') args.push('--parent', node.parent);
  if (node.model) args.push('--model', node.model);
  if (node.cwd) args.push('--cwd', node.cwd);
  if (node.briefFile) args.push('--brief-file', node.briefFile);
  // Extra flags carried by the plan node; `sbb spawn --cli-args` does the splitting.
  // The `=` form is required: `--cli-args --permission-mode ...` is ambiguous to parseArgs.
  if (node.cliArgs) args.push(`--cli-args=${node.cliArgs}`);
  return args;
}

/**
 * Default node runner: one `sbb spawn` child process per plan node.
 * @param {Record<string, any>} node
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function defaultSpawn(node) {
  const result = await runCommand(process.execPath, spawnArgs(node), { timeoutMs: 300_000 });
  return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `spawned <id> <name> <coord>` or a JSON object with `id`. */
export function parseSpawnOutput(stdout) {
  const text = String(stdout ?? '').trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (parsed?.id) return { id: parsed.id, name: parsed.name, coord: parsed.coord };
    } catch {
      // fall through to the text form
    }
  }
  const m = text.match(/^spawned\s+(\S+)\s+(\S+)\s+(\S+)/m);
  return m ? { id: m[1], name: m[2], coord: m[3] } : null;
}

/**
 * Approve a plan and spawn its nodes in order. Quota floors are checked per node before its
 * spawn runs; a blocked node is recorded and the rest still run.
 * @param {Record<string, any>} plan
 * @param {{ approver?: Brain|null, edit?: Record<string, any>, config?: Record<string, any>,
 *   rows?: import('../quota/usage-guard.js').QuotaRow[], brains?: Brain[],
 *   spawn?: (node: Record<string, any>) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   getBrain?: Function, accounts?: { name: string }[], now?: number, sbbDir?: string }} [opts]
 */
export async function approvePlan(plan, opts = {}) {
  if (plan.status !== 'pending') {
    throw new PlanError(`plan ${plan.planId} is ${plan.status}, not pending`, 'not_pending');
  }
  if (!mayApprove(plan, opts.approver, opts)) {
    throw new PlanError(`brain ${opts.approver?.id} may not approve plan ${plan.planId}`, 'not_approver');
  }
  const nodes = opts.edit ? normalizePlan(opts.edit, opts).brains : plan.brains;
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? Date.now();
  /** @type {Record<string, any>[]} */
  const results = [];

  for (const node of nodes) {
    const quota = checkQuotaFloor({ account: node.account, config: opts.config, rows: opts.rows });
    const reserve = quota.ok && node.role === 'sub'
      ? checkMainReserve({ account: node.account, config: opts.config, rows: opts.rows, brains: opts.brains ?? [] })
      : { ok: true };
    const verdict = quota.ok ? reserve : quota;
    if (!verdict.ok) {
      results.push({ name: node.name, account: node.account, status: 'blocked', reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    try {
      const out = await spawn({ ...node, parent: plan.parent });
      const parsed = out.code === 0 ? parseSpawnOutput(out.stdout) : null;
      if (out.code === 0 && parsed) {
        results.push({ name: node.name, account: node.account, status: 'spawned', id: parsed.id, coord: parsed.coord });
      } else {
        results.push({
          name: node.name,
          account: node.account,
          status: 'failed',
          exitCode: out.code,
          detail: (out.stderr || out.stdout || '').trim().split('\n').slice(-3).join(' | '),
        });
      }
    } catch (err) {
      results.push({ name: node.name, account: node.account, status: 'failed', detail: err?.message ?? String(err) });
    }
  }

  const failed = results.filter((r) => r.status !== 'spawned');
  plan.status = failed.length ? 'approved_with_errors' : 'approved';
  plan.decidedAt = now;
  plan.decidedBy = opts.approver?.id ?? 'user';
  plan.brains = nodes;
  savePlan(plan, opts);
  const result = {
    planId: plan.planId,
    parent: plan.parent,
    approvedAt: now,
    approvedBy: plan.decidedBy,
    results,
  };
  writeJson(resultPath(plan.planId, opts), result);
  return { plan, result, results };
}

/** One line describing an approve/reject outcome. */
export function planSummary(plan, results = []) {
  const spawned = results.filter((r) => r.status === 'spawned').length;
  const failed = results.length - spawned;
  return `${plan.planId} ${plan.status}  spawned=${spawned} failed=${failed}  result=${plan.planId}.result.json`;
}

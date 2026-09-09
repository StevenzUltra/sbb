// sbb spawn. docs/spec/lifecycle.md section "sbb spawn".
// Validation -> id -> pane -> CLI -> readiness -> record -> parent notification.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as defaultRun } from '../lib/exec.js';
import { discoverAccounts, sbbDir } from '../lib/paths.js';
import * as tmuxLib from '../lib/tmux.js';
import { allocateId, newUuid } from '../registry/brain-id.js';
import { BRAIN_NAME_RE, getBrain, isValidBrainName, listBrains, removeBrain, saveBrain } from '../registry/brains.js';
import { expireHoldsForBrain } from '../policy/held.js';
import { ROLE_LABELS } from '../registry/envelope.js';
import { readConfig as readPolicyConfig } from '../policy/config.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { findSpawnedThread } from '../registry/codex-threads.js';
import { readQuota } from '../quota/usage-guard.js';
import { deliver as defaultDeliver, openDeliveryInbox } from '../cli/util.js';
import { CLI_BINARIES, awaitReady as defaultAwaitReady, buildCommand, prepareBrief, readCodexDefaultModel, readCodexTrust, splitArgs } from './launch.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { renderBrief } from './briefing.js';

/** docs/spec/policy.md: refuse an account below this weekly remaining percent. */
export const DEFAULT_QUOTA_FLOOR = 10;

/**
 * `~/.sbb/config.json` as an object. A missing file means defaults; an unreadable or
 * malformed one is reported and then treated as defaults, never as a silent block.
 * @param {{ dir?: string, onWarn?: (message: string) => void }} [opts]
 */
export function readConfig({ dir, onWarn = (m) => process.stderr.write(`sbb: warning: ${m}\n`) } = {}) {
  const path = join(dir ?? sbbDir(), 'config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    onWarn(`cannot read ${path}: ${err?.message ?? err}`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    onWarn(`cannot parse ${path}: ${err?.message ?? err}`);
    return {};
  }
}

/**
 * Default `--cli-args` for one CLI, from `~/.sbb/config.json` `spawn.cliArgs[<cli>]`
 * (written by `sbb policy spawn-args`). Goes through `policy/config.js` so the value is
 * merged and validated like every other config read; a missing or corrupt file means no
 * default rather than a failed spawn.
 * @param {string} cli
 * @param {{ dir?: string,
 *           readConfig?: (opts: { sbbDir?: string }) => import('../policy/config.js').SbbConfig,
 *           onWarn?: (message: string) => void }} [opts]
 * @returns {string|undefined}
 */
export function spawnCliArgs(cli, { dir, readConfig = readPolicyConfig, onWarn } = {}) {
  const value = readConfig({ sbbDir: dir, onWarn })?.spawn?.cliArgs?.[cli];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Launcher settings for one CLI from `spawn.preamble[<cli>]`, `spawn.command[<cli>]` and
 * `spawn.shell` (docs/spec/lifecycle.md "Launcher"; written by `sbb policy spawn-*`).
 * @param {string} cli
 * @param {{ dir?: string,
 *           readConfig?: (opts: { sbbDir?: string }) => import('../policy/config.js').SbbConfig,
 *           onWarn?: (message: string) => void }} [opts]
 * @returns {{ preamble?: string, command?: string, shell?: string }}
 */
export function spawnLauncher(cli, { dir, readConfig = readPolicyConfig, onWarn } = {}) {
  const spawn = readConfig({ sbbDir: dir, onWarn })?.spawn ?? {};
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  return { preamble: pick(spawn.preamble?.[cli]), command: pick(spawn.command?.[cli]), shell: pick(spawn.shell) };
}

/**
 * Effective extra CLI args, in order: config defaults, explicit `--cli-args`, plan-node
 * args. Every source is whitespace-split with quotes honoured.
 * @param {(string|string[]|undefined|null)[]} sources
 * @returns {string[]}
 */
export function mergeCliArgs(sources) {
  return sources.flatMap((source) => splitArgs(source));
}

/** @param {Record<string, any>} config */
export function quotaFloor(config) {
  const value = Number(config?.quota?.floorWeekly);
  return Number.isFinite(value) ? value : DEFAULT_QUOTA_FLOOR;
}

/**
 * The quota floor for one account. `unknown` (no row, or no weekly window) never blocks:
 * SBB must not invent a number it could not read.
 * @param {{ account: string, floor: number, rows: import('../quota/usage-guard.js').QuotaRow[] }} input
 * @returns {{ ok: boolean, note: string, detail?: string }}
 */
export function checkQuotaFloor({ account, floor, rows }) {
  const row = rows.find((r) => r.account === account && r.window === 'weekly');
  if (!row) return { ok: true, note: 'unknown' };
  if (row.remaining === null || row.remaining === undefined) {
    return { ok: true, note: `unknown (${row.note ?? row.status})` };
  }
  if (row.remaining < floor) {
    return {
      ok: false,
      note: `${row.remaining}% left`,
      detail: `account ${account} weekly remaining ${row.remaining}% is below floor ${floor}%`,
    };
  }
  return { ok: true, note: `${row.remaining}% left` };
}

/** @param {string} reason @param {string} detail */
function blocked(reason, detail) {
  return { blocked: { reason, detail } };
}

/**
 * Spawn one brain. Returns `{ brain, notification, retiredDuplicates }` on success, or
 * `{ blocked, paneId?, screen? }`. `retiredDuplicates` lists same-pane records the spawn
 * superseded (a brain that registered itself with `sbb adopt` despite the brief).
 * @param {{ name: string, role?: 'main'|'sub', parent?: string, account: string,
 *           cli: import('../types.js').CliKind, model?: string, cwd?: string,
 *           brief?: string, briefFile?: string, extraArgs?: string|string[],
 *           cliArgs?: string|string[], split?: boolean, force?: boolean, user?: string }} input
 * @param {Record<string, any>} [deps]
 */
export async function spawnBrain(input = {}, deps = {}) {
  const accounts = deps.accounts ?? discoverAccounts();
  const name = String(input.name ?? '').trim();
  if (!isValidBrainName(name)) {
    return blocked('invalid_name', `invalid brain name "${name}": must match ${BRAIN_NAME_RE}`);
  }
  const live = (deps.listBrains ?? listBrains)();
  const taken = live.find((b) => b.name === name);
  if (taken) return blocked('duplicate_name', `brain name "${name}" is already used by ${taken.id}`);

  const role = input.role ?? 'main';
  if (role !== 'main' && role !== 'sub') return blocked('invalid_role', `invalid role "${role}"`);
  const get = deps.getBrain ?? getBrain;
  /** @type {import('../types.js').Brain|undefined} */
  let parentBrain;
  let parent = null;
  if (role === 'sub') {
    parentBrain = get(String(input.parent ?? ''));
    if (!parentBrain) return blocked('unknown_parent', `unknown parent brain "${input.parent}"`);
    parent = parentBrain.id;
  } else if (input.parent) {
    return blocked('invalid_parent', 'main brains have no parent');
  }

  const cli = input.cli;
  if (!CLI_BINARIES[cli]) {
    return blocked('invalid_cli', `unknown cli "${cli}": expected ${Object.keys(CLI_BINARIES).join(', ')}`);
  }
  const accountName = String(input.account ?? '').toLowerCase();
  const account = accounts.find((a) => a.name === accountName);
  if (!account) return blocked('unknown_account', `unknown account "${input.account}"`);

  const run = deps.run ?? defaultRun;
  const which = deps.which ?? (async (bin) => (await run('which', [bin], { timeoutMs: 5000 })).code === 0);
  if (!(await which(CLI_BINARIES[cli]))) {
    return blocked('cli_missing', `${CLI_BINARIES[cli]} is not on PATH`);
  }

  // Everything a codex thread does from here on belongs to this spawn.
  const startedAt = Date.now();
  const cwd = input.cwd ?? process.cwd();
  if (cli === 'codex') {
    // docs/spec/lifecycle.md: Codex refuses to run in an untrusted directory, and its
    // trust is per exact path. Blocking here keeps the failure explainable instead of a
    // pane that sits on a trust prompt until the readiness timeout.
    const trust = (deps.readCodexTrust ?? readCodexTrust)({ dir: account.codexDir, cwd });
    if (!trust.trusted) {
      const level = trust.level ?? (trust.found ? 'missing' : 'no entry');
      return blocked(
        'codex_untrusted_cwd',
        `codex 未信任 ${cwd}（${trust.configPath ?? 'CODEX_HOME'} 中 trust_level=${level}${trust.detail ? `; ${trust.detail}` : ''}）；先在该账户的 codex 里手动信任此目录再 spawn`,
      );
    }
  }

  // Codex merges the project's `.codex/config.toml` over the account's config, so a spawn
  // without --model would run whatever the cwd asks for (2026-09-09: account c was refused
  // by its endpoint for a project-level gpt-6-astra). Pass the account's own top-level
  // model explicitly, and record the model that actually runs.
  let model = input.model;
  let modelSource = input.model ? 'flag' : undefined;
  if (cli === 'codex' && !model) {
    const accountModel = (deps.readCodexDefaultModel ?? readCodexDefaultModel)({ dir: account.codexDir });
    if (accountModel.detail) {
      (deps.onWarn ?? ((message) => process.stderr.write(`sbb: warning: ${message}\n`)))(accountModel.detail);
    }
    if (accountModel.model) {
      model = accountModel.model;
      modelSource = 'codex-config';
    }
  }

  let quotaNote = 'skipped (--force)';
  if (!input.force) {
    const floor = quotaFloor(deps.config ?? readConfig({ onWarn: deps.onWarn }));
    const rows = await (deps.readQuota ?? readQuota)({ dbPath: deps.usageDbPath, refresh: false });
    const verdict = checkQuotaFloor({ account: accountName, floor, rows });
    if (!verdict.ok) return blocked('quota', verdict.detail);
    quotaNote = verdict.note;
  }

  const id = (deps.allocateId ?? allocateId)();
  const uuid = (deps.newUuid ?? newUuid)();
  let briefSource = input.brief;
  if (briefSource === undefined && input.briefFile) briefSource = readFileSync(input.briefFile, 'utf8');
  if (briefSource === undefined) {
    briefSource = renderBrief({
      brain: { id, name, role, account: accountName, cli, model },
      parent: parentBrain,
      user: input.user,
    });
  }
  const prepared = (deps.prepareBrief ?? prepareBrief)({ id, brief: briefSource });
  const cliArgs = mergeCliArgs([
    (deps.spawnCliArgs ?? spawnCliArgs)(cli, { dir: deps.configDir, onWarn: deps.onWarn }),
    input.extraArgs,
    input.cliArgs,
  ]);
  const launcher = (deps.spawnLauncher ?? spawnLauncher)(cli, { dir: deps.configDir, onWarn: deps.onWarn });
  const command = buildCommand({
    cli,
    model,
    briefFile: prepared.file,
    extraArgs: cliArgs,
    account,
    name,
    accounts,
    ...launcher,
  });

  const tmuxApi = deps.tmuxApi ?? tmuxLib;
  let paneId;
  try {
    // The CLI is the pane command: nothing is typed into an interactive shell, so a
    // multi-kilobyte brief cannot stall behind the shell's completion or paste handling.
    if (!input.split) await tmuxApi.ensureServer?.();
    paneId = input.split
      ? await tmuxApi.tmux(['split-window', '-c', cwd, '-P', '-F', '#{pane_id}', ...command.paneCommand])
      : await tmuxApi.tmux(['new-window', '-n', `ai-${accountName}`, '-c', cwd, '-P', '-F', '#{pane_id}', ...command.paneCommand]);
  } catch (err) {
    return blocked('tmux_failed', `cannot create a pane: ${err?.message ?? err}`);
  }
  if (!/^%\d+$/.test(String(paneId ?? ''))) {
    return blocked('tmux_failed', `tmux returned no pane id (got "${paneId}")`);
  }

  try {
    const options = [['@ai_account', accountName], ['@sbb_brain', id]];
    if (account.codexDir) options.push(['@codex_home', account.codexDir]);
    for (const [key, value] of options) await tmuxApi.tmux(['set-option', '-p', '-t', paneId, key, value]);
  } catch (err) {
    const cleanup = await killPane(tmuxApi, paneId);
    return { ...blocked('tmux_failed', `cannot configure the pane: ${err?.message ?? err}${cleanup}`), paneId };
  }

  const ready = await (deps.awaitReady ?? defaultAwaitReady)(
    { cli, paneId, account: accountName, name, cwd, brief: prepared.brief },
    { accounts, ...(deps.readyDeps ?? {}) },
  );
  if (!ready.ready) {
    const cleanup = await killPane(tmuxApi, paneId);
    return {
      ...blocked(ready.reason ?? 'not_ready', `${ready.detail ?? 'CLI did not become ready'}${cleanup}`),
      paneId,
      screen: ready.screen,
    };
  }

  let coord = null;
  try {
    coord = await tmuxApi.tmux(['display-message', '-p', '-t', paneId, '#{session_name}:#{window_index}.#{pane_index}']);
  } catch {
    coord = null; // the record tolerates a missing coord; the pane id is the truth
  }

  // Codex creates its thread during the brief turn; record which one, so the roster can
  // address the session by thread instead of guessing from cwd. Never guessed: no thread
  // means no field, and a failed lookup is reported, not hidden.
  let thread;
  let threadError;
  if (cli === 'codex') {
    try {
      thread = (deps.findSpawnedThread ?? findSpawnedThread)({
        account: accountName,
        cwd,
        sinceMs: startedAt,
        accounts,
      });
    } catch (err) {
      threadError = String(err?.message ?? err);
    }
  }

  const brain = {
    id,
    uuid,
    name,
    role,
    parent,
    account: accountName,
    cli,
    model,
    cwd,
    paneId,
    coord: coord ?? undefined,
    pid: ready.session?.pid,
    threadId: thread?.id,
    threadName: thread?.name,
    createdAt: Date.now(),
    origin: 'spawned',
  };
  (deps.saveBrain ?? saveBrain)(brain);

  // A brain that ran `sbb adopt` during its first turn would leave a second record for
  // this pane. The spawn's own record wins; the extra one is retired, never deleted.
  const retiredDuplicates = [];
  for (const other of (deps.listBrains ?? listBrains)()) {
    if (!other?.id || other.id === id || other.paneId !== paneId) continue;
    (deps.removeBrain ?? removeBrain)(other.id);
    (deps.expireHolds ?? expireHoldsForBrain)(other.id, {});
    retiredDuplicates.push({ id: other.id, name: other.name });
  }

  let notification;
  if (parentBrain) {
    const identity = {
      sender: brain.name,
      id: brain.id,
      account: brain.account,
      cli: brain.cli,
      coord: brain.coord ?? null,
      role: role === 'sub' ? ROLE_LABELS.sub : ROLE_LABELS.main,
    };
    let target;
    try {
      target = await (deps.resolve ?? defaultResolve)(parentBrain.name, {
        accounts,
        rows: deps.rows,
        onWarn: deps.onWarn,
      });
    } catch (err) {
      notification = { status: 'blocked', reason: 'target_not_found', detail: String(err?.message ?? err) };
    }
    if (target) {
      // Same delivery path as `sbb tell`: without an inbox the envelope has no fromSock,
      // peers cannot reply to it and the transport reports `content not wrapped`
      // (measured 2026-09-09 on a scratch spawn).
      const inbox = await (deps.openInbox ?? openDeliveryInbox)({ target, owner: brain.name, deps });
      try {
        const { receipt } = await (deps.deliver ?? defaultDeliver)({
          target,
          body: `已上线，上级 ${parentBrain.name}`,
          identity,
          deps,
          send: deps.send,
          inbox,
        });
        notification = { status: receipt.status, via: receipt.via, reason: receipt.reason, detail: receipt.detail };
      } catch (err) {
        notification = { status: 'blocked', reason: 'notify_failed', detail: String(err?.message ?? err) };
      } finally {
        await inbox?.close?.();
        await (deps.closeInboxes ?? closeInboxes)();
      }
    }
  }

  return { brain, notification, quota: quotaNote, briefFile: prepared.file, cliArgs, model: model ?? null, modelSource, thread: thread ?? null, threadError, retiredDuplicates };
}

/**
 * Remove the pane a failed spawn left behind. Returns a note to append to the detail.
 * @param {typeof tmuxLib} tmuxApi
 * @param {string} paneId
 */
async function killPane(tmuxApi, paneId) {
  try {
    await tmuxApi.tmux(['kill-pane', '-t', paneId]);
    return '';
  } catch (err) {
    return `; kill-pane failed: ${err?.message ?? err}`;
  }
}

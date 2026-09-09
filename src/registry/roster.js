// Roster: the union of tmux panes, Claude sessions and Codex threads, with brain
// records overlaid. See docs/spec/registry.md. Every row is a live CLI session.
import { capturePane as defaultCapturePane, listPanes as defaultListPanes } from '../lib/tmux.js';
import { run as defaultRun } from '../lib/exec.js';
import { accountFromPaneTag, discoverAccounts } from '../lib/paths.js';
import { listBrains, saveBrain as defaultSaveBrain } from './brains.js';
import { listClaudeSessions, paneTmuxKey } from './claude-sessions.js';
import { listCodexThreads } from './codex-threads.js';

/** @typedef {import('../types.js').Pane} Pane */
/** @typedef {import('../types.js').Brain} Brain */

/** Shells are not sessions; they only appear when a brain is registered on them. */
export const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'nu', 'tmux', 'login']);

/** Claude prints its version as pane_current_command, e.g. '2.1.263'. */
export const CLAUDE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Process tree walk bounds. The Codex TUI runs as a grandchild of the pane shell
 * (measured 2026-09-09: pane shell -> zsh -l -> node /opt/homebrew/bin/codex), so a
 * single-level `pgrep -P <pane_pid>` misses every Codex pane. registry.md section 1
 * describes only the single level; this bounded walk is the correction.
 */
export const TREE_MAX_DEPTH = 4;
export const TREE_MAX_PROCS = 64;

/**
 * @typedef {Object} RosterRow
 * @property {string|null} brain
 * @property {string|null} brainId
 * @property {string|null} role
 * @property {string|null} parent
 * @property {string} account
 * @property {import('../types.js').CliKind} cli
 * @property {string|null} model
 * @property {string} status        'busy' | 'idle' | '?' | 'stale'
 * @property {string} where         coordinate or '-'
 * @property {string|null} name     session or thread name
 * @property {string} cwd
 * @property {string|null} paneId
 * @property {string|null} coord
 * @property {number|null} pid
 * @property {string|null} threadId
 * @property {boolean|null} hasRollout
 * @property {boolean} threadUncertain
 * @property {string|null} sock
 * @property {string|null} keyFile
 * @property {'pane'|'brain'} source
 * @property {import('../types.js').ClaudeSession|undefined} claude
 * @property {import('../types.js').CodexThread|undefined} codex
 */

/**
 * Infer the CLI from pane_current_command alone (no process tree).
 * @param {string|undefined} command
 * @returns {import('../types.js').CliKind|undefined} undefined means "not a session".
 */
export function inferCliFromCommand(command) {
  const cmd = String(command ?? '').trim();
  if (cmd === '') return undefined;
  if (CLAUDE_VERSION_RE.test(cmd)) return 'claude';
  if (cmd === 'agy' || cmd.startsWith('agy-')) return 'agy';
  if (cmd === 'cursor-agent' || cmd.startsWith('cursor-agent-')) return 'cursor';
  if (cmd === 'codex' || cmd.startsWith('codex-')) return 'codex';
  if (cmd === 'kimi' || cmd.startsWith('kimi-')) return 'kimi';
  // grok sets pane_current_command to its versioned binary, e.g. 'grok-1.0.13-mac'
  if (cmd === 'grok' || cmd.startsWith('grok-')) return 'grok';
  if (SHELL_COMMANDS.has(cmd)) return undefined;
  return 'other';
}

/**
 * Walk the pane's process tree (bounded) and look for a known CLI binary.
 * @param {Pane} pane
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{code: number|null, stdout: string, stderr: string}>} exec
 * @returns {Promise<import('../types.js').CliKind>}
 */
export async function inferCliFromProcessTree(pane, exec = defaultRun) {
  /** @type {{pid: string, depth: number}[]} */
  let frontier = [{ pid: String(pane.pid), depth: 0 }];
  let seen = 0;
  while (frontier.length && seen < TREE_MAX_PROCS) {
    const { pid, depth } = frontier.shift();
    seen += 1;
    const ps = await exec('ps', ['-o', 'command=', '-p', pid], { timeoutMs: 5000 });
    const command = ps.stdout.trim();
    if (/\bcodex\b/.test(command)) return 'codex';
    if (/\bcursor-agent\b/.test(command)) return 'cursor';
    if (/\bkimi\b/.test(command)) return 'kimi';
    if (/\bgrok\b/.test(command)) return 'grok';
    if (depth >= TREE_MAX_DEPTH) continue;
    const children = await exec('pgrep', ['-P', pid], { timeoutMs: 5000 });
    if (children.code !== 0) continue;
    for (const child of children.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      frontier.push({ pid: child, depth: depth + 1 });
    }
  }
  return 'other';
}

/** Screen fingerprints live in src/transports/cli-profiles.js (task h2). */
async function loadCliProfiles() {
  try {
    const mod = await import('../transports/cli-profiles.js');
    return mod.profiles ?? mod.default ?? mod;
  } catch {
    return undefined;
  }
}

/**
 * Status for a non-Claude session from the visible screen. Returns '?' when the
 * profile module is absent or the screen is ambiguous. Never guesses 'idle'.
 * @param {import('../types.js').CliKind} cli
 * @param {string} screen
 * @param {Record<string, any>|undefined} profiles
 */
export function screenStatus(cli, screen, profiles) {
  const profile = profiles?.[cli];
  if (!profile || typeof profile.busy !== 'function' || typeof profile.idle !== 'function') return '?';
  try {
    if (profile.busy(screen)) return 'busy';
    if (profile.idle(screen)) return 'idle';
  } catch {
    return '?';
  }
  return '?';
}

/** @param {string|undefined} p */
function normCwd(p) {
  return String(p ?? '').replace(/\/+$/, '');
}

/**
 * Build the roster.
 * @param {{
 *   accounts?: import('../types.js').Account[],
 *   listPanes?: () => Promise<Pane[]>,
 *   capturePane?: (paneId: string, lines?: number) => Promise<string>,
 *   exec?: (cmd: string, args: string[], opts?: object) => Promise<any>,
 *   withStatus?: boolean,
 *   includeStaleBrains?: boolean,
 *   cliProfiles?: Record<string, any>,
 *   onWarn?: (message: string) => void,
 * }} [opts]
 * @returns {Promise<RosterRow[]>} sorted by account then coordinate.
 */
export async function roster(opts = {}) {
  const listPanes = opts.listPanes ?? defaultListPanes;
  const capturePane = opts.capturePane ?? defaultCapturePane;
  const exec = opts.exec ?? defaultRun;
  const withStatus = opts.withStatus !== false;
  const onWarn = opts.onWarn ?? ((message) => process.stderr.write(`sbb: warning: ${message}\n`));
  const accounts = opts.accounts ?? discoverAccounts();

  const panes = await listPanes();

  /** @type {import('../types.js').ClaudeSession[]} */
  let sessions = [];
  try {
    sessions = listClaudeSessions(accounts);
  } catch (err) {
    onWarn(`claude session registry unavailable: ${err?.message ?? err}`);
  }
  /** @type {import('../types.js').CodexThread[]} */
  let threads = [];
  try {
    threads = listCodexThreads(accounts);
  } catch (err) {
    onWarn(`codex thread registry unavailable: ${err?.message ?? err}`);
  }
  const brains = listBrains();
  const profiles = opts.cliProfiles ?? (withStatus ? await loadCliProfiles() : undefined);

  // Live Codex panes per cwd decide whether a thread match is certain.
  /** @type {Map<string, Pane[]>} */
  const codexPanesByCwd = new Map();
  /** @type {{pane: Pane, cli: import('../types.js').CliKind}[]} */
  const classified = [];
  for (const pane of panes) {
    let cli = inferCliFromCommand(pane.command);
    if (cli === undefined) {
      const brainOnPane = brains.find((b) => b.paneId === pane.paneId);
      if (!brainOnPane) continue; // a plain shell is not a session
      cli = brainOnPane.cli;
    } else if (cli === 'other' && String(pane.command).trim() === 'node') {
      cli = await inferCliFromProcessTree(pane, exec);
    }
    classified.push({ pane, cli });
    if (cli === 'codex') {
      const key = normCwd(pane.path);
      codexPanesByCwd.set(key, [...(codexPanesByCwd.get(key) ?? []), pane]);
    }
  }

  /** @type {RosterRow[]} */
  const rows = [];
  for (const { pane, cli } of classified) {
    const account = accountFromPaneTag(pane.account);
    /** @type {import('../types.js').ClaudeSession|undefined} */
    let session;
    /** @type {import('../types.js').CodexThread|undefined} */
    let thread;
    let threadUncertain = false;
    let status = '?';

    if (cli === 'claude') {
      session = sessions.find((s) => s.tmux === paneTmuxKey(pane) && s.account === account)
        ?? sessions.find((s) => s.tmux === paneTmuxKey(pane));
      // The registry can report values outside busy/idle (e.g. 'shell'); never
      // pass those through as if they were a known state.
      status = session?.status === 'busy' || session?.status === 'idle' ? session.status : '?';
    } else if (cli === 'codex') {
      // Resolved after `brain` below: a recorded threadId outranks the cwd guess.
    } else if (withStatus) {
      status = screenStatus(cli, await capturePane(pane.paneId), profiles);
    }

    const brain = brains.find((b) => b.paneId === pane.paneId)
      ?? (cli === 'claude' && session ? brains.find((b) => b.pid === session?.pid) : undefined);

    /** A guessed thread is shown by name but never handed to codex-queue unless it is certain. */
    let guessedName = null;
    if (cli === 'codex') {
      // A brain record that names its thread wins: guessing by cwd once matched an
      // unrelated older thread in the same account (rehearsal 2026-09-09). When the record
      // names a thread, do not fall back to guessing even if that thread is gone.
      const key = normCwd(pane.path);
      if (typeof brain?.threadId === 'string' && brain.threadId !== '') {
        thread = threads.find((t) => t.id === brain.threadId);
      } else if (brain?.origin === 'spawned') {
        // The thread was not known at spawn time (Codex writes the row after the first turn).
        // Attribute only a thread this account created in this cwd at or after the spawn,
        // oldest such first, and remember it in the record. Never "most recently updated":
        // in a CODEX_HOME shared with the user's own sessions that guess pointed a delivery
        // at the user's thread (2026-09-09).
        const fresh = threads
          .filter((t) => t.account === account && normCwd(t.cwd) === key && t.createdAtMs >= (brain.createdAt ?? 0))
          .sort((a, b) => a.createdAtMs - b.createdAtMs);
        threadUncertain = fresh.length > 1;
        if (fresh.length === 1) {
          thread = fresh[0];
          try {
            (opts.saveBrain ?? defaultSaveBrain)({ ...brain, threadId: thread.id, ...(thread.name ? { threadName: thread.name } : {}) });
          } catch (err) {
            onWarn(`could not remember thread for ${brain.id}: ${err?.message ?? err}`);
          }
        } else if (fresh.length > 1) {
          guessedName = fresh[0].name ?? null;
        }
      } else {
        // An unregistered pane: the newest thread in this cwd is a display guess. With more
        // than one live Codex pane in the cwd it stays a guess and no thread is attached.
        const candidates = threads.filter((t) => t.account === account && normCwd(t.cwd) === key);
        const newest = candidates.reduce(
          (best, t) => (best === undefined || t.updatedAtMs > best.updatedAtMs ? t : best),
          /** @type {import('../types.js').CodexThread|undefined} */ (undefined),
        );
        threadUncertain = (codexPanesByCwd.get(key)?.length ?? 0) > 1;
        if (threadUncertain) guessedName = newest?.name ?? null;
        else thread = newest;
      }
      if (withStatus) status = screenStatus('codex', await capturePane(pane.paneId), profiles);
    }

    rows.push({
      brain: brain?.name ?? null,
      brainId: brain?.id ?? null,
      role: brain?.role ?? null,
      parent: brain?.parent ?? null,
      account,
      cli,
      model: brain?.model ?? null,
      status,
      where: pane.coord,
      name: session?.name ?? thread?.name ?? guessedName ?? null,
      cwd: pane.path,
      paneId: pane.paneId,
      coord: pane.coord,
      pid: session?.pid ?? pane.pid,
      threadId: thread?.id ?? null,
      hasRollout: thread ? thread.hasRollout : null,
      threadUncertain,
      sock: session?.sock ?? null,
      keyFile: session?.keyFile ?? null,
      source: 'pane',
      claude: session,
      codex: thread,
    });
  }

  if (opts.includeStaleBrains) {
    const livePanes = new Set(rows.map((r) => r.paneId));
    for (const brain of brains) {
      if (livePanes.has(brain.paneId)) continue;
      rows.push({
        brain: brain.name,
        brainId: brain.id,
        role: brain.role,
        parent: brain.parent,
        account: brain.account,
        cli: brain.cli,
        model: brain.model ?? null,
        status: 'stale',
        where: brain.coord ?? '-',
        name: null,
        cwd: brain.cwd,
        paneId: null,
        coord: null,
        pid: brain.pid ?? null,
        threadId: null,
        hasRollout: null,
        threadUncertain: false,
        sock: null,
        keyFile: null,
        source: 'brain',
        claude: undefined,
        codex: undefined,
      });
    }
  }

  return rows.sort((a, b) => (a.account === b.account ? String(a.coord ?? '~').localeCompare(String(b.coord ?? '~')) : a.account.localeCompare(b.account)));
}

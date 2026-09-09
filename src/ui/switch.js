// "Go to terminal" (docs/spec/ui-server.md). The console asks for a brain; the user's own
// tmux client is moved to it, or a fresh terminal window is opened when there is none.
// A client this rule does not pick is never touched.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { host as defaultHost } from '../host/index.js';
import { run as defaultRun } from '../lib/exec.js';
import { sbbDir } from '../lib/paths.js';

/** Terminals this module can open, in preference order. */
export const TERMINALS = Object.freeze(['ghostty', 'iterm2']);

/** Installed application name per terminal id. */
export const TERMINAL_APPS = Object.freeze({ ghostty: 'Ghostty', iterm2: 'iTerm2' });

/** Process command lines that belong to SBB itself, never to a human client. */
export const SBB_PROCESS_RE = /(?:^|[\s/])sbb(?:\.js)?(?:\s|$)|bin\/sbb\.js/;

/** @param {string} text */
export function shellQuote(text) {
  const value = String(text ?? '');
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell line a fresh terminal must run to attach to the brain's session. `SBB_TMUX_ARGS`
 * is kept so a UI server on a private server (`tmux -L sbb-h1`) attaches to that one.
 * @param {{ session: string, args?: string[] }} input
 */
export function attachCommand({ session, args = [] }) {
  const extra = args.filter(Boolean).map(shellQuote).join(' ');
  return ['tmux', extra, 'attach', '-t', shellQuote(session)].filter(Boolean).join(' ');
}

/** `~/.sbb/config.json` `terminal`, read raw: policy/config.js drops unknown keys. */
export function readTerminalPreference({ dir, readFile = readFileSync } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFile(join(dir ?? sbbDir(), 'config.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const value = String(raw?.terminal ?? '').toLowerCase();
  return TERMINALS.includes(value) ? value : undefined;
}

/**
 * tmux clients that belong to a human. Control-mode clients (empty tty) and any tty running
 * an sbb process are ignored, exactly as the spec requires.
 * @param {{ listClients?: Function, ps?: Function, host?: typeof defaultHost }} [deps]
 * @returns {Promise<{tty: string, session: string}[]>}
 */
export async function humanClients(deps = {}) {
  const host = deps.host ?? defaultHost;
  const clients = await (deps.listClients ?? (() => host.listClients()))();
  const candidates = clients.filter((c) => c.tty && !c.controlMode);
  if (!candidates.length) return [];
  const ps = deps.ps ?? (() => defaultRun('ps', ['-ax', '-o', 'tty=,command='], { timeoutMs: 5000 }));
  const { stdout } = await ps();
  /** @type {Map<string, string[]>} */
  const byTty = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const tty = match[1].replace(/^\/dev\//, '');
    if (!byTty.has(tty)) byTty.set(tty, []);
    byTty.get(tty).push(match[2]);
  }
  return candidates.filter((c) => {
    const commands = byTty.get(String(c.tty).replace(/^\/dev\//, '')) ?? [];
    return !commands.some((command) => SBB_PROCESS_RE.test(command));
  });
}

/**
 * Open a terminal window that attaches to `session`.
 * @param {{ session: string, terminal: string, deps?: Record<string, any> }} input
 */
export async function openTerminal({ session, terminal, deps = {} }) {
  const id = String(terminal ?? '').toLowerCase();
  if (!TERMINALS.includes(id)) return { opened: false, terminal: id, detail: `unknown terminal "${terminal}"` };
  const app = TERMINAL_APPS[id];
  const installed = deps.installed ?? ((name) => existsSync(`/Applications/${name}.app`));
  if (!installed(app)) return { opened: false, terminal: id, detail: `${app}.app is not installed` };
  const command = attachCommand({ session, args: deps.tmuxArgs ?? defaultHost.baseArgs() });
  const lines = id === 'ghostty'
    ? [
        `tell application "${app}"`,
        'activate',
        'set w to new window',
        'set t to focused terminal of selected tab of w',
        `input text "${escapeAppleScript(command)}" to t`,
        'send key "enter" to t',
        'end tell',
      ]
    : [
        `tell application "${app}"`,
        'activate',
        'set w to (create window with default profile)',
        `tell current session of w to write text "${escapeAppleScript(command)}"`,
        'end tell',
      ];
  const run = deps.run ?? defaultRun;
  const args = lines.flatMap((line) => ['-e', line]);
  const result = await run('osascript', args, { timeoutMs: deps.timeoutMs ?? 15000 });
  if (result.code !== 0) {
    return { opened: false, terminal: id, detail: String(result.stderr || result.stdout || 'osascript failed').trim() };
  }
  return { opened: true, terminal: id, command };
}

/** @param {string} text */
function escapeAppleScript(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Focus a brain's pane for the user, or open a terminal when no human client exists.
 * @param {{ brain: import('../types.js').Brain, deps?: Record<string, any> }} input
 * @returns {Promise<{switched: boolean, client?: Record<string, any>, clients?: Record<string, any>[],
 *   opened?: string, command?: string, reason?: string, detail?: string}>}
 */
export async function goToTerminal({ brain, deps = {} }) {
  const host = deps.host ?? defaultHost;
  if (!brain) return { switched: false, reason: 'target_not_found', detail: 'unknown brain' };
  let paneId;
  try {
    paneId = await host.resolvePaneId(brain.paneId);
  } catch (err) {
    return { switched: false, reason: 'pane_gone', detail: `pane ${brain.paneId} is gone (${err?.message ?? err})` };
  }
  const panes = await host.listPanes();
  const pane = panes.find((p) => p.paneId === paneId);
  if (!pane) return { switched: false, reason: 'pane_gone', detail: `pane ${brain.paneId} is gone` };

  let clients;
  try {
    clients = await humanClients(deps);
  } catch (err) {
    return { switched: false, reason: 'tmux_failed', detail: `cannot list clients: ${err?.message ?? err}` };
  }
  if (clients.length === 1) {
    const client = clients[0];
    try {
      if (client.session !== pane.session) await host.switchClient(client.tty, pane.session);
      await host.selectPane(paneId);
    } catch (err) {
      return { switched: false, reason: 'tmux_failed', detail: `cannot move client ${client.tty}: ${err?.message ?? err}` };
    }
    return { switched: true, client, session: pane.session, paneId };
  }
  if (clients.length > 1) return { switched: false, clients };

  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { switched: false, reason: 'no_client', detail: 'no human tmux client and not macOS' };
  }
  const terminal = (deps.terminal ?? readTerminalPreference({ dir: deps.sbbDir, readFile: deps.readFile }))
    ?? TERMINALS.find((id) => (deps.installed ?? ((name) => existsSync(`/Applications/${name}.app`)))(TERMINAL_APPS[id]));
  if (!terminal) return { switched: false, reason: 'no_terminal', detail: 'neither Ghostty nor iTerm2 is installed' };
  const opened = await openTerminal({ session: pane.session, terminal, deps });
  if (!opened.opened) return { switched: false, reason: 'open_failed', detail: opened.detail, terminal };
  return { switched: false, opened: opened.terminal, command: opened.command, session: pane.session };
}

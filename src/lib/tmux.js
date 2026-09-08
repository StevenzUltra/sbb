// Thin tmux wrapper. Every call shells out to the tmux server the current process can reach
// (respects $TMUX / -L / -S via SBB_TMUX_ARGS). No state is kept here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** @typedef {import('../types.js').Pane} Pane */

function baseArgs() {
  const extra = process.env.SBB_TMUX_ARGS ? process.env.SBB_TMUX_ARGS.split(' ').filter(Boolean) : [];
  return extra;
}

/**
 * Run a tmux command. Returns trimmed stdout. Throws with stderr on failure.
 * @param {string[]} args
 */
export async function tmux(args) {
  const { stdout } = await execFileP('tmux', [...baseArgs(), ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

const PANE_FORMAT = [
  '#{pane_id}', '#{window_id}', '#{session_name}', '#{window_index}', '#{pane_index}',
  '#{pane_current_command}', '#{pane_title}', '#{pane_current_path}', '#{pane_in_mode}',
  '#{pane_pid}', '#{@ai_account}', '#{@codex_home}',
].join('\t');

/**
 * All panes on the server.
 * @returns {Promise<Pane[]>}
 */
export async function listPanes() {
  const out = await tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [paneId, windowId, session, windowIndex, paneIndex, command, title, path, inMode, pid, account, codexHome] = line.split('\t');
    return {
      paneId,
      windowId,
      session,
      windowIndex: Number(windowIndex),
      paneIndex: Number(paneIndex),
      coord: `${session}:${windowIndex}.${paneIndex}`,
      command,
      title,
      path,
      inMode: inMode === '1',
      pid: Number(pid),
      account: account || undefined,
      codexHome: codexHome || undefined,
    };
  });
}

/**
 * Resolve any tmux target ('%30', '24:3.3', 'session:@16.%30') to the current pane id.
 * @param {string} target
 */
export async function resolvePaneId(target) {
  const t = target.includes(':@') ? target.split('.').pop() : target;
  return tmux(['display-message', '-p', '-t', t, '#{pane_id}']);
}

/** @param {string} paneId */
export async function paneInMode(paneId) {
  return (await tmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])) === '1';
}

/**
 * A pane's user option, or null when unset or the server is unreachable. `@sbb_brain` is
 * written at spawn (src/lifecycle/spawn.js) and stays on the pane after the brain record is
 * gone, so `sbb approve` can still recognise a brain whose record was retired.
 * @param {string} paneId @param {string} name
 */
export async function paneOption(paneId, name) {
  try {
    return (await tmux(['display-message', '-p', '-t', paneId, `#{@${name}}`])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Visible screen of a pane, bottom `lines` lines, without trailing blank lines.
 * @param {string} paneId
 * @param {number} [lines]
 */
export async function capturePane(paneId, lines = 40) {
  const out = await tmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
  return out.replace(/\s+$/, '');
}

/**
 * Type literal text into a pane. Never interprets key names; never appends Enter.
 * @param {string} paneId
 * @param {string} text  single line; callers must strip newlines
 */
export async function sendLiteral(paneId, text) {
  if (/[\r\n]/.test(text)) throw new Error('sendLiteral: text must be a single line');
  await tmux(['send-keys', '-t', paneId, '-l', '--', text]);
}

/** @param {string} paneId @param {string} key  e.g. 'Enter', 'C-u' */
export async function sendKey(paneId, key) {
  await tmux(['send-keys', '-t', paneId, key]);
}

/** Coordinates of the pane this process runs in, or undefined outside tmux. */
export async function selfPane() {
  const id = process.env.TMUX_PANE;
  if (!id) return undefined;
  const line = await tmux(['display-message', '-p', '-t', id, PANE_FORMAT]);
  const panes = await listPanes();
  return panes.find((p) => p.paneId === id) ?? (line ? undefined : undefined);
}

/**
 * Socket path of the tmux server this process talks to, or null outside tmux. `$TMUX` already
 * names it as `<socket path>,<server pid>,<session id>` and costs no child process; only
 * `SBB_TMUX_ARGS` (which may point at another server) forces a tmux query. Cached per env so
 * repeated sends do not spawn tmux again.
 * @returns {Promise<string|null>}
 */
let serverPathCache = { key: null, path: null };
export async function serverSocketPath() {
  const key = `${process.env.TMUX ?? ''}|${process.env.SBB_TMUX_ARGS ?? ''}`;
  if (serverPathCache.key === key) return serverPathCache.path;
  let path = (process.env.TMUX ?? '').split(',')[0] || null;
  if (process.env.SBB_TMUX_ARGS) {
    try {
      path = (await tmux(['display-message', '-p', '#{socket_path}'])) || null;
    } catch {
      path = null;
    }
  }
  serverPathCache = { key, path };
  return path;
}

const CLIENT_FORMAT = ['#{client_tty}', '#{client_session}'].join('\t');

/**
 * Every attached tmux client. `sbb switch` uses this to move only the caller's own
 * client, never whatever client was most recently active.
 * @returns {Promise<{tty: string, session: string}[]>}
 */
export async function listClients() {
  const out = await tmux(['list-clients', '-F', CLIENT_FORMAT]);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [tty, session] = line.split('\t');
    return { tty, session };
  });
}

/** @param {string} paneId */
export async function selectPane(paneId) {
  await tmux(['select-window', '-t', paneId]);
  await tmux(['select-pane', '-t', paneId]);
}

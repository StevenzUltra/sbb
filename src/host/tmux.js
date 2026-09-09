// Host interface: every tmux call SBB makes goes through here (docs/spec/ui-server.md
// "Host interface"). No state is kept; each call shells out to the tmux server the current
// process can reach (respects $TMUX / -L / -S via SBB_TMUX_ARGS). The control-mode client
// is the one long-lived exception: the UI server owns it and drives it line by line.
import { execFile, spawn as defaultSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** @typedef {import('../types.js').Pane} Pane */

export function baseArgs(env = process.env) {
  const extra = env.SBB_TMUX_ARGS ? env.SBB_TMUX_ARGS.split(' ').filter(Boolean) : [];
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
 * Visible screen of a pane with escape sequences kept (`-e`), so the UI can replay it into
 * a terminal that understands colour and cursor moves.
 * @param {string} paneId
 * @param {number} [lines]
 */
export async function capturePaneEscaped(paneId, lines = 40) {
  const out = await tmux(['capture-pane', '-p', '-e', '-t', paneId, '-S', `-${lines}`]);
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

/** @param {string} paneId */
export async function killPane(paneId) {
  await tmux(['kill-pane', '-t', paneId]);
}

/**
 * Move one named client to a session. A bare `switch-client` picks the most recently active
 * client, which is usually the user's own terminal, so the tty is always explicit.
 * @param {string} tty @param {string} session
 */
export async function switchClient(tty, session) {
  await tmux(['switch-client', '-c', tty, '-t', session]);
}

/**
 * Create a window and return its pane id.
 * @param {{ name?: string, cwd?: string, command?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function newWindow({ name, cwd, command = [] } = {}) {
  const args = ['new-window'];
  if (name) args.push('-n', name);
  if (cwd) args.push('-c', cwd);
  args.push('-P', '-F', '#{pane_id}', ...command);
  return assertPaneId(await tmux(args), 'newWindow');
}

/**
 * Split the current window and return the new pane id.
 * @param {{ cwd?: string, command?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function splitWindow({ cwd, command = [] } = {}) {
  const args = ['split-window'];
  if (cwd) args.push('-c', cwd);
  args.push('-P', '-F', '#{pane_id}', ...command);
  return assertPaneId(await tmux(args), 'splitWindow');
}

/**
 * Resize a pane. The UI only ever calls this for a pane no human client is attached to.
 * @param {string} paneId @param {{ cols: number, rows: number }} size
 */
export async function resizePane(paneId, { cols, rows }) {
  await tmux(['resize-pane', '-t', paneId, '-x', String(cols), '-y', String(rows)]);
  // `resize-pane` alone is a no-op for the only pane of a window in a detached session
  // (measured on tmux 3.7c, 2026-09-09: a 200x49 pane stayed 200x49). A single-pane
  // window therefore also gets `resize-window`, which is what actually moves it. With a
  // client attached the window keeps following that client, so this stays harmless.
  const panes = await listPanes();
  const pane = panes.find((p) => p.paneId === paneId);
  if (pane && panes.filter((p) => p.windowId === pane.windowId).length === 1) {
    await tmux(['resize-window', '-t', pane.windowId, '-x', String(cols), '-y', String(rows)]);
  }
}

/** @param {string} value @param {string} who */
function assertPaneId(value, who) {
  const paneId = String(value ?? '').trim();
  if (!/^%\d+$/.test(paneId)) throw new Error(`${who}: tmux returned no pane id (got "${value}")`);
  return paneId;
}

/**
 * @typedef {Object} ControlClient
 * @property {number|undefined} pid
 * @property {string} session
 * @property {(line: string) => void} write   one tmux command per call; the newline is added
 * @property {(event: 'data'|'error'|'exit'|'close', fn: Function) => ControlClient} on
 * @property {(signal?: NodeJS.Signals) => void} kill
 * @property {() => Promise<void>} close
 */

/**
 * ONE long-lived tmux control-mode client for a session. Its stdout is the `%output` stream
 * that `src/ui/pane-stream.js` parses; nothing else in SBB keeps a tmux process alive.
 * @param {{ session: string, env?: NodeJS.ProcessEnv, spawn?: Function }} opts
 * @returns {ControlClient}
 */
export function controlClient({ session, env = process.env, spawn: spawnFn = defaultSpawn } = {}) {
  const name = String(session ?? '').trim();
  if (!name) throw new Error('controlClient: session is required');
  const child = spawnFn('tmux', [...baseArgs(env), '-C', 'attach-session', '-t', name], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.stdout?.setEncoding) child.stdout.setEncoding('utf8');
  /** @type {ControlClient} */
  const api = {
    pid: child.pid,
    session: name,
    write(line) {
      const text = String(line ?? '').replace(/\r?\n$/, '');
      if (text) child.stdin.write(`${text}\n`);
    },
    on(event, fn) {
      child.on(event, fn);
      return api;
    },
    kill(signal = 'SIGTERM') {
      try {
        child.kill(signal);
      } catch {
        // already gone: nothing to signal
      }
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        api.kill();
      });
    },
  };
  return api;
}

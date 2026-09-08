// sbb switch. docs/spec/lifecycle.md section "sbb switch".
// Focuses the brain's current pane; the record's paneId is only a hint and is re-resolved.
// Only the caller's own tmux client is ever moved: a bare `switch-client` picks the most
// recently active client, which is usually the user's own terminal (2026-09-09 incident).
import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { isatty } from 'node:tty';
import { promisify } from 'node:util';
import * as tmuxLib from '../lib/tmux.js';
import { getBrain } from '../registry/brains.js';

const execFileP = promisify(execFile);

/**
 * The tty this process talks to its user on, so `sbb switch` can match it against
 * `tmux list-clients`. Order: the stdin/stdout tty (isatty + `/dev/fd/<n>` symlink),
 * `$SSH_TTY` for a remote shell, then the `tty` command. `undefined` means the caller
 * has no client of its own; the caller then must not move anybody's client.
 * @param {{ isatty?: (fd: number) => boolean, readlink?: (path: string) => string,
 *           env?: Record<string, string|undefined>, exec?: (file: string, args: string[]) => Promise<{ stdout: string }> }} [deps]
 * @returns {Promise<string|undefined>}
 */
export async function callerTty({ isatty: isattyFn = isatty, readlink = readlinkSync, env = process.env, exec = execFileP } = {}) {
  for (const fd of [1, 0]) {
    if (!isattyFn(fd)) continue;
    try {
      const path = readlink(`/dev/fd/${fd}`);
      if (typeof path === 'string' && path.startsWith('/dev/')) return path;
    } catch {
      // fall through to the next source
    }
  }
  if (typeof env.SSH_TTY === 'string' && env.SSH_TTY !== '') return env.SSH_TTY;
  try {
    const { stdout } = await exec('tty', []);
    const path = String(stdout).trim();
    if (path.startsWith('/dev/')) return path;
  } catch {
    // no tty at all: the caller is not attached to any client
  }
  return undefined;
}

/**
 * Focus a brain's pane. Returns `{ brain, paneId, coord, session, client, attach }` where
 * `client` is the caller's own tty (null when it has none) and `attach` is the hint to
 * print when no client could be moved; or `{ gone: true, brain }` when the pane is gone.
 * @param {string|import('../types.js').Brain} ref
 * @param {{ tmuxApi?: typeof tmuxLib, getBrainFn?: (ref: string) => import('../types.js').Brain|undefined,
 *           callerTty?: (deps?: any) => Promise<string|undefined>, ttyDeps?: any }} [deps]
 */
export async function switchTo(ref, deps = {}) {
  const tmuxApi = deps.tmuxApi ?? tmuxLib;
  const brain = typeof ref === 'object' && ref ? ref : (deps.getBrainFn ?? getBrain)(ref);
  if (!brain) return { blocked: { reason: 'target_not_found', detail: `unknown brain "${ref}"` } };

  let paneId = null;
  try {
    paneId = await tmuxApi.resolvePaneId(brain.paneId);
  } catch {
    paneId = null;
  }
  let panes;
  if (paneId) {
    try {
      panes = await tmuxApi.listPanes();
    } catch (err) {
      return { blocked: { reason: 'tmux_failed', detail: `cannot list panes: ${err?.message ?? err}` } };
    }
    if (!panes.some((p) => p.paneId === paneId)) paneId = null;
  }
  if (!paneId) {
    return { gone: true, brain, detail: `pane ${brain.paneId} is gone` };
  }

  const pane = panes.find((p) => p.paneId === paneId);
  const tty = await (deps.callerTty ?? callerTty)(deps.ttyDeps);
  let client = null;
  if (tty) {
    let clients;
    try {
      clients = await tmuxApi.listClients();
    } catch (err) {
      return { blocked: { reason: 'tmux_failed', detail: `cannot list clients: ${err?.message ?? err}` } };
    }
    client = clients.find((c) => c.tty === tty) ?? null;
  }
  // Only this process's own client may move; a client on the target session is left alone.
  if (client && client.session !== pane.session) {
    await tmuxApi.tmux(['switch-client', '-c', client.tty, '-t', pane.session]);
  }
  await tmuxApi.selectPane(paneId);
  return {
    brain,
    paneId,
    coord: pane.coord,
    session: pane.session,
    client: client?.tty ?? null,
    attach: client ? undefined : `attach: tmux switch-client -t ${pane.session}`,
  };
}

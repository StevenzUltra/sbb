// sbb switch. docs/spec/lifecycle.md section "sbb switch".
// Focuses the brain's current pane; the record's paneId is only a hint and is re-resolved.
import * as tmuxLib from '../lib/tmux.js';
import { getBrain } from '../registry/brains.js';

/**
 * @param {typeof tmuxLib} tmuxApi
 * @returns {Promise<string|undefined>} the session this process's tmux client shows
 */
async function clientSession(tmuxApi) {
  try {
    const name = await tmuxApi.tmux(['display-message', '-p', '#{client_session}']);
    return name || undefined;
  } catch {
    return undefined; // outside tmux: there is no client to switch
  }
}

/**
 * Focus a brain's pane. Returns `{ brain, paneId, coord }`, or `{ gone: true, brain }`
 * when the pane no longer exists (the caller exits 4).
 * @param {string|import('../types.js').Brain} ref
 * @param {{ tmuxApi?: typeof tmuxLib, getBrainFn?: (ref: string) => import('../types.js').Brain|undefined }} [deps]
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
  const client = await clientSession(tmuxApi);
  if (client && client !== pane.session) await tmuxApi.tmux(['switch-client', '-t', pane.session]);
  await tmuxApi.selectPane(paneId);
  return { brain, paneId, coord: pane.coord, session: pane.session, client: client ?? null };
}

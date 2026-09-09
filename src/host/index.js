// The active host. tmux is the only one for now; a desktop shell can add a second host
// later without touching messaging (docs/spec/ui-server.md "Host interface").
import * as tmux from './tmux.js';

/** @typedef {'tmux'} HostKind */

/** @type {HostKind} */
export const kind = 'tmux';

/** The module every tmux call goes through. */
export const host = tmux;

/** @returns {typeof tmux} */
export function activeHost() {
  return tmux;
}

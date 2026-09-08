// Transport router. Picks the best transport for a target and falls back down the chain.
// Owned by the lead. Transports are implemented in the sibling files (see docs/tasks/).
import { claudeUds } from './claude-uds.js';
import { codexQueue } from './codex-queue.js';
import { tmuxKeys } from './tmux-keys.js';

/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').OutboundMessage} OutboundMessage */
/** @typedef {import('../types.js').Receipt} Receipt */
/** @typedef {import('../types.js').SendOptions} SendOptions */
/** @typedef {import('../types.js').Transport} Transport */

export const STATUS = Object.freeze({
  DELIVERED: 'delivered',
  QUEUED: 'queued',
  UNVERIFIED: 'unverified',
  BLOCKED: 'blocked',
});

/**
 * Preferred order per CLI. The last entry is always the typed fallback.
 * @type {Record<string, Transport[]>}
 */
const CHAIN = {
  claude: [claudeUds, tmuxKeys],
  codex: [codexQueue, tmuxKeys],
  agy: [tmuxKeys],
  cursor: [tmuxKeys],
  other: [tmuxKeys],
};

/**
 * Reasons after which trying the next transport makes sense. Anything else is final:
 * a `held` or `denied` receipt from Claude must not be retried by typing into the pane.
 */
const FALLBACK_REASONS = new Set([
  'transport_unavailable', // socket missing, key unreadable, codex binary missing
  'no_rollout',            // codex thread not queueable yet
  'thread_not_found',
  'socket_connect_failed',
  'auth_rejected',
]);

/**
 * @param {Target} target
 * @param {OutboundMessage} message
 * @param {SendOptions} [opts]
 * @returns {Promise<Receipt>}
 */
export async function send(target, message, opts = {}) {
  const chain = CHAIN[target.cli] ?? CHAIN.other;
  /** @type {Receipt|undefined} */
  let last;
  for (const transport of chain) {
    if (!transport.supports(target)) continue;
    const receipt = await transport.send(target, message, opts);
    if (receipt.status !== STATUS.BLOCKED || !FALLBACK_REASONS.has(receipt.reason ?? '')) {
      return receipt;
    }
    last = receipt;
  }
  return last ?? {
    status: STATUS.BLOCKED,
    via: 'none',
    msgId: message.msgId,
    elapsedMs: 0,
    reason: 'no_transport',
    detail: `no transport supports ${target.cli} target ${target.address}`,
  };
}

export const transports = { claudeUds, codexQueue, tmuxKeys };

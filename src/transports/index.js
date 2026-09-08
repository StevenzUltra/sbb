// Transport router. Picks the best transport for a target, falls back down the chain, and
// upgrades a `queued` receipt to `delivered` when the target's screen shows the message.
// Owned by the lead. Transports live in the sibling files (see docs/tasks/).
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
export const DEFAULT_CHAIN = {
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
export const FALLBACK_REASONS = new Set([
  'transport_unavailable', // socket missing, key unreadable, codex binary missing
  'no_rollout',            // codex thread not queueable yet
  'thread_not_found',
  'socket_connect_failed',
  'auth_rejected',
]);

/** Transports whose `queued` means "accepted, not observed" and can be confirmed on screen. */
const SCREEN_CONFIRMABLE = new Set(['uds', 'codex-queue']);

let confirmModule;
/** Lazy import so the router works before src/transports/confirm.js exists. */
async function defaultLoadConfirm() {
  if (confirmModule === undefined) {
    confirmModule = await import('./confirm.js').then((m) => m.confirmOnScreen ?? null, () => null);
  }
  return confirmModule;
}

/**
 * @param {{ chain?: Record<string, Transport[]>, loadConfirm?: () => Promise<Function|null> }} [deps]
 */
export function createRouter({ chain = DEFAULT_CHAIN, loadConfirm = defaultLoadConfirm } = {}) {
  /**
   * @param {Target} target
   * @param {OutboundMessage} message
   * @param {SendOptions & { confirm?: boolean }} [opts]
   * @returns {Promise<Receipt>}
   */
  async function send(target, message, opts = {}) {
    const candidates = chain[target.cli] ?? chain.other;
    /** @type {Receipt|undefined} */
    let last;
    for (const transport of candidates) {
      if (!transport.supports(target)) continue;
      const receipt = await transport.send(target, message, opts);
      if (receipt.status === STATUS.BLOCKED && FALLBACK_REASONS.has(receipt.reason ?? '')) {
        last = receipt;
        continue;
      }
      return maybeConfirm(target, message, receipt, opts);
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

  /**
   * A `queued` uds / codex-queue receipt is only "accepted by the socket". If the target pane
   * is known and the confirm module is available, watch the screen for the message.
   */
  async function maybeConfirm(target, message, receipt, opts) {
    if (receipt.status !== STATUS.QUEUED || !SCREEN_CONFIRMABLE.has(receipt.via)) return receipt;
    if (opts.confirm === false || !target.paneId) return receipt;
    const confirmOnScreen = await loadConfirm();
    if (typeof confirmOnScreen !== 'function') return receipt;
    const started = Date.now();
    let verdict;
    try {
      verdict = await confirmOnScreen(
        target,
        { text: message.text, fromName: message.fromName },
        { timeoutMs: opts.verifyTimeoutMs ?? 4000 },
      );
    } catch (err) {
      return { ...receipt, detail: joinDetail(receipt.detail, `screen confirm failed: ${err?.message ?? err}`) };
    }
    if (verdict !== 'delivered') return receipt;
    return {
      ...receipt,
      status: STATUS.DELIVERED,
      via: `${receipt.via}+screen`,
      elapsedMs: receipt.elapsedMs + (Date.now() - started),
      detail: joinDetail(receipt.detail, 'confirmed on screen'),
    };
  }

  return { send };
}

function joinDetail(a, b) {
  return a ? `${a}; ${b}` : b;
}

const defaultRouter = createRouter();
export const send = defaultRouter.send;
export const transports = { claudeUds, codexQueue, tmuxKeys };

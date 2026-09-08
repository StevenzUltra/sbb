// tmux-keys transport: typed delivery with screen verification.
// Every tmux call goes through src/lib/tmux.js (injectable for tests). See
// docs/spec/protocols.md section 3 and docs/tasks/h2-tmux-codex.md.
import * as tmuxLib from '../lib/tmux.js';
import { profileFor } from './cli-profiles.js';

/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').OutboundMessage} OutboundMessage */
/** @typedef {import('../types.js').Receipt} Receipt */
/** @typedef {import('../types.js').SendOptions} SendOptions */

/** Composer text longer than this is refused instead of typed. */
export const MAX_TEXT_CHARS = 4000;
/** Wait after Enter before reading the screen (spec: 2 s). */
export const SETTLE_MS = 2000;
const CAPTURE_LINES = 60;

// pane_current_command values that mean something other than a CLI owns the keyboard.
// 'node' is deliberately absent: live Codex panes report `node` as their command.
const FOREGROUND_PROGRAMS = new Set([
  'zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh',
  'vim', 'nvim', 'vi', 'emacs', 'nano', 'pico', 'less', 'more', 'man',
  'tmux', 'ssh', 'mosh', 'top', 'htop', 'lesskey', 'gdb', 'lldb',
  'psql', 'sqlite3', 'irb', 'python', 'python3',
]);

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One-line normalisation: the envelope is single-line by contract. */
export function toSingleLine(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * @param {Object} [deps]
 * @param {typeof tmuxLib} [deps.tmuxApi]  any object with the src/lib/tmux.js surface
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.settleMs]
 * @param {number} [deps.captureLines]
 * @returns {import('../types.js').Transport}
 */
export function createTmuxKeys({ tmuxApi = tmuxLib, sleep = defaultSleep, settleMs = SETTLE_MS, captureLines = CAPTURE_LINES } = {}) {
  /** @param {Target} target */
  function supports(target) {
    return Boolean(target && target.paneId);
  }

  /** @param {string} reason @param {number} started @param {string} msgId @param {string} [detail] */
  function blocked(reason, started, msgId, detail) {
    return { status: 'blocked', via: 'send-keys', msgId, elapsedMs: Date.now() - started, reason, detail };
  }

  /**
   * @param {Target} target
   * @param {OutboundMessage} message
   * @param {SendOptions} [opts]
   * @returns {Promise<Receipt>}
   */
  async function send(target, message, opts = {}) {
    const started = Date.now();
    const msgId = message.msgId;
    const paneId = target?.paneId;
    if (!paneId) return blocked('target_not_found', started, msgId, 'target has no paneId');

    const text = toSingleLine(message.text);
    if (!text.trim()) return blocked('policy', started, msgId, 'empty message text');
    if (text.length > MAX_TEXT_CHARS) {
      return blocked('too_long', started, msgId, `${text.length} chars > ${MAX_TEXT_CHARS}`);
    }

    let pane;
    try {
      if (await tmuxApi.paneInMode(paneId)) {
        return blocked('pane_in_copy_mode', started, msgId, `${paneId} is in copy-mode`);
      }
      const panes = await tmuxApi.listPanes();
      pane = panes.find((p) => p.paneId === paneId);
      if (!pane) return blocked('target_not_found', started, msgId, `${paneId} is not a live pane`);
    } catch (err) {
      return blocked('transport_unavailable', started, msgId, String(err?.message ?? err));
    }

    if (FOREGROUND_PROGRAMS.has(pane.command)) {
      return blocked('foreground_program', started, msgId, `${paneId} runs ${pane.command}`);
    }

    const profile = profileFor(target.cli);
    let before;
    try {
      before = await tmuxApi.capturePane(paneId, captureLines);
    } catch (err) {
      return blocked('transport_unavailable', started, msgId, String(err?.message ?? err));
    }

    if (profile.prompting(before)) return blocked('target_prompting', started, msgId, 'permission dialog is open');
    if (!profile.acceptsInput(before)) {
      const detail = profile.busy(before) ? 'a turn is running' : 'screen is not a known idle composer';
      return blocked('target_busy', started, msgId, detail);
    }

    if (opts.dryRun) {
      return blocked('policy', started, msgId, `dry run: would type ${text.length} chars into ${paneId}`);
    }

    let typed = false;
    try {
      await tmuxApi.sendLiteral(paneId, text);
      typed = true;
      for (let i = 0; i < profile.enters; i += 1) await tmuxApi.sendKey(paneId, 'Enter');
      await sleep(settleMs);

      let screen = await tmuxApi.capturePane(paneId, captureLines);
      let verdict = profile.submitted(before, screen, text);
      if (verdict !== 'pending') {
        return {
          status: verdict === 'queued' ? 'queued' : 'delivered',
          via: 'send-keys',
          msgId,
          elapsedMs: Date.now() - started,
          detail: verdict === 'queued' ? 'accepted as a follow-up behind the running task' : undefined,
        };
      }

      // The text is still on the composer: one extra Enter, never a resend, never Esc.
      await tmuxApi.sendKey(paneId, 'Enter');
      await sleep(settleMs);
      screen = await tmuxApi.capturePane(paneId, captureLines);
      verdict = profile.submitted(before, screen, text);
      if (verdict === 'pending') {
        return {
          status: 'unverified',
          via: 'send-keys',
          msgId,
          elapsedMs: Date.now() - started,
          reason: 'enter_swallowed_twice',
          detail: 'text stayed on the composer after two Enters; not resent',
        };
      }
      return {
        status: verdict === 'queued' ? 'queued' : 'delivered',
        via: 'send-keys',
        msgId,
        elapsedMs: Date.now() - started,
        reason: verdict === 'queued' ? 'queued_follow_up' : undefined,
        detail: verdict === 'queued' ? 'accepted as a follow-up after the retry Enter' : undefined,
      };
    } catch (err) {
      // After sendLiteral the text may already be in the pane: report unverified, not blocked.
      return typed
        ? { status: 'unverified', via: 'send-keys', msgId, elapsedMs: Date.now() - started, reason: 'transport_unavailable', detail: String(err?.message ?? err) }
        : blocked('transport_unavailable', started, msgId, String(err?.message ?? err));
    }
  }

  return { id: 'send-keys', supports, send };
}

/** @type {import('../types.js').Transport} */
export const tmuxKeys = createTmuxKeys();

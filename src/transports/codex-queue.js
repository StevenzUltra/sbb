// codex-queue transport: hand the message to `codex queue` for a live Codex thread.
// The command is injected (src/lib/exec.js by default) and the screen check goes through
// src/lib/tmux.js, so tests run without a Codex binary or a tmux server.
// See docs/spec/protocols.md section 2.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run as execRun } from '../lib/exec.js';
import * as tmuxLib from '../lib/tmux.js';
import { accountByName } from '../lib/paths.js';
import { collapse } from './cli-profiles.js';

/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').OutboundMessage} OutboundMessage */
/** @typedef {import('../types.js').Receipt} Receipt */
/** @typedef {import('../types.js').SendOptions} SendOptions */

/** `codex queue` is given this long to return. */
export const QUEUE_TIMEOUT_MS = 25000;
const VERIFY_POLL_MS = 500;
const VERIFY_LINES = 60;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** @param {string} cmd @param {string} [pathEnv] */
export function hasBinaryOnPath(cmd, pathEnv = process.env.PATH ?? '') {
  for (const dir of String(pathEnv).split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** One-line normalisation: `codex queue --message` carries the rendered envelope. */
function toSingleLine(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * @param {Object} [deps]
 * @param {typeof execRun} [deps.run]
 * @param {typeof tmuxLib} [deps.tmuxApi]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(account: string) => string|undefined} [deps.codexHomeFor]
 * @param {(cmd: string) => boolean} [deps.binaryOnPath]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.timeoutMs]
 * @returns {import('../types.js').Transport}
 */
export function createCodexQueue({
  run = execRun,
  tmuxApi = tmuxLib,
  sleep = defaultSleep,
  codexHomeFor = (account) => accountByName(account)?.codexDir,
  binaryOnPath = (cmd) => hasBinaryOnPath(cmd),
  pollMs = VERIFY_POLL_MS,
  timeoutMs = QUEUE_TIMEOUT_MS,
} = {}) {
  /** @param {Target} target */
  function supports(target) {
    return Boolean(target && target.cli === 'codex' && target.codex?.id && binaryOnPath('codex'));
  }

  /** @param {string} reason @param {number} started @param {string} msgId @param {string} [detail] */
  function blocked(reason, started, msgId, detail) {
    return { status: 'blocked', via: 'codex-queue', msgId, elapsedMs: Date.now() - started, reason, detail };
  }

  /**
   * A new `›` transcript line carrying the text, or any new `•` line, means the turn ran.
   * @param {string} paneId @param {string} text @param {number} verifyTimeoutMs
   */
  async function verifyDelivered(paneId, text, verifyTimeoutMs) {
    const probe = collapse(text).slice(0, 32);
    const countPrompt = (screen) => String(screen ?? '').split('\n')
      .filter((line) => /^\s*›/.test(line) && collapse(line).includes(probe)).length;
    const countBullet = (screen) => String(screen ?? '').split('\n')
      .filter((line) => /^\s*•/.test(line)).length;
    let before;
    try {
      before = await tmuxApi.capturePane(paneId, VERIFY_LINES);
    } catch {
      return false; // cannot verify -> the caller reports queued, never delivered
    }
    const promptsBefore = countPrompt(before);
    const bulletsBefore = countBullet(before);
    const deadline = Date.now() + verifyTimeoutMs;
    for (;;) {
      let screen;
      try {
        screen = await tmuxApi.capturePane(paneId, VERIFY_LINES);
      } catch {
        return false;
      }
      if (countPrompt(screen) > promptsBefore || countBullet(screen) > bulletsBefore) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
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
    const thread = target?.codex?.id ?? target?.codex?.name;
    if (!thread) return blocked('thread_not_found', started, msgId, 'target carries no codex thread');

    const codexHome = codexHomeFor(target.account);
    if (!codexHome) {
      return blocked('transport_unavailable', started, msgId, `no CODEX_HOME for account ${target.account}`);
    }

    const text = toSingleLine(message.text);
    if (opts.dryRun) {
      return blocked('policy', started, msgId, `dry run: would run codex queue --thread ${thread}`);
    }

    let res;
    try {
      res = await run('codex', ['queue', '--thread', thread, '--message', text], {
        env: { CODEX_HOME: codexHome },
        timeoutMs,
      });
    } catch (err) {
      return blocked('transport_unavailable', started, msgId, String(err?.message ?? err));
    }

    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.timedOut) {
      return {
        status: 'unverified',
        via: 'codex-queue',
        msgId,
        elapsedMs: Date.now() - started,
        reason: 'queue_timeout',
        detail: `codex queue did not return within ${timeoutMs}ms`,
      };
    }
    if (/no rollout found/i.test(combined)) {
      return blocked('no_rollout', started, msgId, 'thread has no rollout yet');
    }
    if (/No active session found/i.test(combined)) {
      return blocked('thread_not_found', started, msgId, `no active session matches ${thread}`);
    }
    if (/codex: not found|ENOENT/.test(combined)) {
      return blocked('transport_unavailable', started, msgId, 'codex binary not found');
    }
    if (res.code === 0 && /Queued message/i.test(res.stdout)) {
      const verifyTimeoutMs = Number(opts.verifyTimeoutMs ?? 4000);
      const seen = target.paneId ? await verifyDelivered(target.paneId, text, verifyTimeoutMs) : false;
      return {
        status: seen ? 'delivered' : 'queued',
        via: 'codex-queue',
        msgId,
        elapsedMs: Date.now() - started,
        detail: seen ? undefined : 'queued; no turn observed on screen',
      };
    }
    return blocked(
      'transport_unavailable',
      started,
      msgId,
      `codex queue exited ${res.code}: ${collapse(combined).slice(0, 200)}`,
    );
  }

  return { id: 'codex-queue', supports, send };
}

/** @type {import('../types.js').Transport} */
export const codexQueue = createCodexQueue();

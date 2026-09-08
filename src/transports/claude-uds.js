// claude-uds transport: inject a message into a live Claude Code session over its Unix
// socket, then wait for the receiver's protocol receipt on our own inbox socket.
// See docs/spec/protocols.md section 1.
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { SOCK_NAME_RE, startInbox } from './uds-inbox.js';

const CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_VERIFY_TIMEOUT_MS = 4000;
const FROM_PREFIX = 'uds:';

/** Peer statuses that are final blocks; the router must not fall back to typing. */
const BLOCKED_STATUSES = new Set(['held', 'denied', 'refused', 'dropped', 'expired']);

/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').OutboundMessage} OutboundMessage */
/** @typedef {import('../types.js').Receipt} Receipt */
/** @typedef {import('../types.js').SendOptions} SendOptions */
/** @typedef {import('./uds-inbox.js').Inbox} Inbox */

/** @type {Map<string, Promise<Inbox>>} */
const inboxCache = new Map();

/** Close every inbox this transport started lazily. Call on CLI shutdown and in tests. */
export async function closeInboxes() {
  const pending = [...inboxCache.values()];
  inboxCache.clear();
  for (const p of pending) await (await p).close();
}

/**
 * @param {string} dir
 * @returns {Promise<Inbox>}
 */
function getInbox(dir) {
  let pending = inboxCache.get(dir);
  if (!pending) {
    pending = startInbox({ dir });
    inboxCache.set(dir, pending);
    pending.catch(() => inboxCache.delete(dir));
  }
  return pending;
}

/**
 * @param {string|undefined} keyFile
 * @returns {{ token: string } | { error: string }}
 */
function readPeerToken(keyFile) {
  if (typeof keyFile !== 'string' || keyFile === '') return { error: 'target has no claude.keyFile' };
  let raw;
  try {
    raw = readFileSync(keyFile, 'utf8');
  } catch (err) {
    return { error: `key file unreadable: ${err.code ?? err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'key file is not JSON' };
  }
  const token = parsed?.peerToken;
  if (typeof token !== 'string' || token === '') return { error: 'key file has no peerToken' };
  return { token };
}

/**
 * A `from` address is only useful when its socket name is one peers accept.
 * @param {string|undefined} fromSock
 */
function normalizeFrom(fromSock) {
  if (typeof fromSock !== 'string' || !fromSock.startsWith(FROM_PREFIX)) {
    return { receivable: false, address: undefined, path: undefined };
  }
  const path = fromSock.slice(FROM_PREFIX.length);
  return { receivable: SOCK_NAME_RE.test(basename(path)), address: fromSock, path };
}

/** @param {string} token */
function authLine(token) {
  return `${JSON.stringify({ type: 'auth', token })}\n`;
}

/** @param {OutboundMessage} message */
function userLine(message) {
  const frame = {
    type: 'user',
    message: { role: 'user', content: message.text },
    msg_id: message.msgId,
    priority: message.priority ?? 'next',
  };
  if (message.fromSock) frame.from = message.fromSock;
  return `${JSON.stringify(frame)}\n`;
}

/**
 * @param {string} sockPath
 * @param {number} timeoutMs
 * @returns {Promise<import('node:net').Socket>}
 */
function connectTo(sockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(Object.assign(new Error(`connect timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

/**
 * Write the frames and end the connection (the server never answers on it).
 * @param {import('node:net').Socket} socket
 * @param {string[]} lines
 */
function writeAndEnd(socket, lines) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.once('error', fail);
    socket.end(lines.join(''), () => {
      if (settled) return;
      settled = true;
      socket.off('error', fail);
      resolve();
    });
  });
}

/**
 * Open a fresh connection, send the auth line plus one control frame, close.
 * @param {string} sockPath
 * @param {string} token
 * @param {object} frame
 */
async function sendControl(sockPath, token, frame) {
  const socket = await connectTo(sockPath, CONNECT_TIMEOUT_MS);
  await writeAndEnd(socket, [authLine(token), `${JSON.stringify(frame)}\n`]);
}

/**
 * @param {Inbox} inbox
 * @param {string} msgId
 * @param {number} timeoutMs
 * @returns {Promise<any|null>} the matching peer_message_status frame, or null on timeout
 */
function waitForStatus(inbox, msgId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (frame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inbox.off?.('receipt', onReceipt);
      resolve(frame);
    };
    const onReceipt = (frame) => {
      if (!frame || frame.orig_msg_id !== msgId) return;
      done(frame);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    inbox.on('receipt', onReceipt);
  });
}

/** @type {import('../types.js').Transport} */
export const claudeUds = {
  id: 'uds',

  /** @param {Target} target */
  supports(target) {
    if (target?.cli !== 'claude') return false;
    const sock = target?.claude?.sock;
    return typeof sock === 'string' && sock !== '' && existsSync(sock);
  },

  /**
   * @param {Target} target
   * @param {OutboundMessage} message
   * @param {SendOptions & { inbox?: Inbox, notifyIdle?: boolean, fromMode?: string }} [opts]
   * @returns {Promise<Receipt>}
   */
  async send(target, message, opts = {}) {
    const startedAt = Date.now();
    /** @param {Receipt['status']} status */
    const finish = (status, reason, detail) => {
      const receipt = { status, via: 'uds', msgId: message.msgId, elapsedMs: Date.now() - startedAt };
      if (reason) receipt.reason = reason;
      if (detail) receipt.detail = detail;
      return receipt;
    };

    const claude = target?.claude;
    const tokenResult = readPeerToken(claude?.keyFile);
    if ('error' in tokenResult) return finish('blocked', 'transport_unavailable', tokenResult.error);

    const sockPath = claude?.sock;
    if (typeof sockPath !== 'string' || sockPath === '') {
      return finish('blocked', 'transport_unavailable', 'target has no claude.sock');
    }

    const from = normalizeFrom(message.fromSock);
    /** @type {Inbox|undefined} */
    let inbox;
    if (from.receivable) {
      try {
        inbox = opts.inbox ?? (await getInbox(dirname(from.path)));
      } catch (err) {
        return finish('blocked', 'transport_unavailable', `inbox unavailable: ${err.message}`);
      }
    }

    let socket;
    try {
      socket = await connectTo(sockPath, CONNECT_TIMEOUT_MS);
    } catch (err) {
      return finish('blocked', 'socket_connect_failed', `${err.code ?? 'error'}: ${err.message}`);
    }
    try {
      await writeAndEnd(socket, [authLine(tokenResult.token), userLine(message)]);
    } catch (err) {
      return finish('blocked', 'transport_unavailable', `write failed: ${err.code ?? err.message}`);
    }

    let receipt;
    if (!from.receivable) {
      // Nothing will ever come back: either no from address at all, or one peers ignore.
      receipt = finish(
        'queued',
        undefined,
        message.fromSock ? `fromSock is not a receivable address: ${message.fromSock}` : undefined,
      );
    } else {
      const timeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
      const frame = await waitForStatus(inbox, message.msgId, timeoutMs);
      if (!frame) receipt = finish('queued', undefined, `no peer_message_status within ${timeoutMs}ms`);
      else if (frame.status === 'delivered') receipt = finish('delivered');
      else if (BLOCKED_STATUSES.has(frame.status)) {
        receipt = finish('blocked', frame.status, frame.status_detail ?? frame.drop_reason);
      } else receipt = finish('queued', undefined, `unknown peer status: ${frame.status}`);
    }

    if (opts.notifyIdle && from.receivable && (receipt.status === 'delivered' || receipt.status === 'queued')) {
      try {
        await sendControl(sockPath, tokenResult.token, {
          type: 'control',
          action: 'notify_when_idle',
          from: from.address,
          msg_id: message.msgId,
          from_mode: opts.fromMode ?? 'bypass',
        });
      } catch (err) {
        const note = `notify_when_idle failed: ${err.code ?? err.message}`;
        receipt.detail = receipt.detail ? `${receipt.detail}; ${note}` : note;
      }
    }
    return receipt;
  },
};

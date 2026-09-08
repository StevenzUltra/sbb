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

/** Characters 2.1.263 accepts inside the wrapper's `from` attribute. */
const FROM_VALUE_RE = /^[A-Za-z0-9%:_/.\-]+$/;

/** Permission modes 2.1.263 renders; anything else is omitted as unknown. */
const FROM_MODES = new Set(['bypass', 'prompting']);

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
 * A `from` address is only useful when it is a `uds:` address whose socket name peers
 * accept; anything else means the receipt can never come back to us.
 * @param {string|undefined} fromSock
 * @returns {{ present: boolean, receivable: boolean, address?: string, path?: string, detail?: string }}
 */
function normalizeFrom(fromSock) {
  if (typeof fromSock !== 'string' || fromSock === '') return { present: false, receivable: false };
  if (!fromSock.startsWith(FROM_PREFIX)) {
    return { present: true, receivable: false, detail: `fromSock must be a uds: address: ${fromSock}` };
  }
  const path = fromSock.slice(FROM_PREFIX.length);
  const name = basename(path);
  if (!SOCK_NAME_RE.test(name)) {
    return { present: true, receivable: false, detail: `fromSock name not receivable by peers: ${name}` };
  }
  return { present: true, receivable: true, address: fromSock, path };
}

/**
 * Wrap the body so 2.1.263 renders it as `Message from @<name>: <body>` (protocols.md
 * section 1). Falls back to plain text when an attribute cannot be represented, and says
 * so in `note` rather than degrading silently.
 * @param {OutboundMessage} message
 * @param {{ present: boolean, receivable: boolean, address?: string }} from
 * @returns {{ content: string, note?: string }}
 */
function buildContent(message, from) {
  const name = message.fromName;
  if (typeof name !== 'string' || name === '') return { content: message.text };
  if (!from.receivable) {
    return { content: message.text, note: 'content not wrapped: no receivable fromSock' };
  }
  if (/["<>\r\n]/.test(name)) {
    return { content: message.text, note: `content not wrapped: from-name has forbidden characters: ${name}` };
  }
  if (!FROM_VALUE_RE.test(from.address)) {
    return { content: message.text, note: `content not wrapped: fromSock has characters peers reject: ${from.address}` };
  }
  const attrs = [`from="${from.address}"`, `from-name="${name}"`];
  if (FROM_MODES.has(message.fromMode)) attrs.push(`from-mode="${message.fromMode}"`);
  return { content: `<cross-session-message ${attrs.join(' ')}>\n${message.text}\n</cross-session-message>` };
}

/** @param {string} token */
function authLine(token) {
  return `${JSON.stringify({ type: 'auth', token })}\n`;
}

/** @param {OutboundMessage} message @param {string} content */
function userLine(message, content) {
  const frame = {
    type: 'user',
    message: { role: 'user', content },
    msg_id: message.msgId,
    priority: message.priority ?? 'next',
  };
  if (message.replyTo) frame.reply_to = message.replyTo;
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

/**
 * The waiting inbox recorded in a receipt's `fromSock`, when it is a socket we can write to.
 * `sbb ask`/`sbb tell` leave one open while they wait, so a reply can go straight to the
 * process that asked instead of into the sender's conversation.
 * @param {string|undefined} fromSock
 * @returns {string|null} socket path
 */
export function waitingInboxPath(fromSock) {
  const from = normalizeFrom(fromSock);
  return from.receivable ? from.path : null;
}

/**
 * True when something is still listening: the process that asked has not given up yet.
 * @param {string} sockPath
 * @param {number} [timeoutMs]
 */
export async function canConnect(sockPath, timeoutMs = CONNECT_TIMEOUT_MS) {
  try {
    (await connectTo(sockPath, timeoutMs)).destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver one `user` frame straight to a sender-side inbox socket. A plain inbox answers with
 * nothing, so a written frame is `queued`, never `delivered`; `ok: false` means the socket
 * could not be reached and the caller should fall back to the sender's session address.
 * @param {{ sockPath: string, message: OutboundMessage, connectTimeoutMs?: number }} input
 * @returns {Promise<{ ok: boolean, receipt: Receipt }>}
 */
export async function sendToInbox({ sockPath, message, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const startedAt = Date.now();
  const base = { via: 'uds-inbox', msgId: message.msgId };
  const failed = (reason, detail) => ({
    ok: false,
    receipt: { ...base, status: 'blocked', reason, detail, elapsedMs: Date.now() - startedAt },
  });
  let socket;
  try {
    socket = await connectTo(sockPath, connectTimeoutMs);
  } catch (err) {
    return failed('socket_connect_failed', `${err.code ?? 'error'}: ${err.message}`);
  }
  const body = buildContent(message, normalizeFrom(message.fromSock));
  try {
    await writeAndEnd(socket, [userLine(message, body.content)]);
  } catch (err) {
    return failed('transport_unavailable', `write failed: ${err.code ?? err.message}`);
  }
  return {
    ok: true,
    receipt: { ...base, status: 'queued', detail: 'waiting inbox accepted the frame (no protocol ack)', elapsedMs: Date.now() - startedAt },
  };
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
    if (from.present && !from.receivable) {
      // The caller asked us to listen where we cannot: a configuration error, not a queue.
      return finish('blocked', 'transport_unavailable', from.detail);
    }
    /** @type {Inbox|undefined} */
    let inbox;
    if (from.receivable) {
      try {
        inbox = opts.inbox ?? (await getInbox(dirname(from.path)));
      } catch (err) {
        return finish('blocked', 'transport_unavailable', `inbox unavailable: ${err.message}`);
      }
      if (from.path !== inbox.sockPath) {
        // The receipt comes back to `from`; an address we do not listen on means no
        // receipt can ever arrive, so this must not be reported as queued.
        return finish('blocked', 'transport_unavailable', `fromSock must be this process inbox: ${inbox.sockPath}`);
      }
    }

    const body = buildContent(message, from);

    let socket;
    try {
      socket = await connectTo(sockPath, CONNECT_TIMEOUT_MS);
    } catch (err) {
      return finish('blocked', 'socket_connect_failed', `${err.code ?? 'error'}: ${err.message}`);
    }
    try {
      await writeAndEnd(socket, [authLine(tokenResult.token), userLine(message, body.content)]);
    } catch (err) {
      return finish('blocked', 'transport_unavailable', `write failed: ${err.code ?? err.message}`);
    }

    let receipt;
    if (!from.receivable) {
      // No from address at all: nothing confirmed the message, but it was written.
      receipt = finish('queued');
    } else {
      const timeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
      const frame = await waitForStatus(inbox, message.msgId, timeoutMs);
      if (!frame) receipt = finish('queued', undefined, `no peer_message_status within ${timeoutMs}ms`);
      else if (frame.status === 'delivered') receipt = finish('delivered');
      else if (BLOCKED_STATUSES.has(frame.status)) {
        receipt = finish('blocked', frame.status, frame.status_detail ?? frame.drop_reason);
      } else receipt = finish('queued', undefined, `unknown peer status: ${frame.status}`);
    }

    if (body.note) receipt.detail = receipt.detail ? `${receipt.detail}; ${body.note}` : body.note;

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

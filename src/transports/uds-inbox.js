// Inbox: a Unix-socket server that receives control frames and replies from peer
// Claude sessions. The receiver of a `user` frame posts back to the sender's `from`
// address, so a sender that wants receipts must listen here.
// See docs/spec/protocols.md section 1.
import { connect, createServer } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { claudeSocksDirs } from '../lib/paths.js';

/**
 * Socket names a peer accepts as a `from` address. A socket outside this shape is
 * ignored by the receiver, so no receipt ever arrives for it.
 */
export const SOCK_NAME_RE = /^(\d+(-[0-9a-f]{8})?|[0-9a-f]{1,16})\.sock$/;

/** Primary directory Claude Code publishes sockets in. */
export function defaultInboxDir() {
  return claudeSocksDirs()[0];
}

/** How long the ack write to a peer inbox may take before it is reported as failed. */
export const ACK_TIMEOUT_MS = 1000;

/**
 * `uds:/tmp/cc-socks/123.sock` -> the socket path, when peers would accept that name.
 * Anything else (a plain path, a name outside SOCK_NAME_RE) is not a peer inbox.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function parseUdsAddress(value) {
  if (typeof value !== 'string' || !value.startsWith('uds:')) return undefined;
  const path = value.slice('uds:'.length);
  if (path === '' || !SOCK_NAME_RE.test(basename(path))) return undefined;
  return path;
}

/**
 * Answer a peer `user` frame that carries `reply_to`, so the sender's `sbb reply` can
 * report `delivered via=uds-inbox` instead of `queued` (docs/spec/lifecycle.md section
 * "Inbox ack"). The auth line is sent with an empty token for symmetry; SBB inboxes do
 * not require it. A failure to write is emitted as an 'error', never swallowed.
 * @param {string} sockPath
 * @param {string} msgId
 * @param {(event: string, payload: any) => void} emit
 */
function ackPeer(sockPath, msgId, emit) {
  const socket = connect(sockPath);
  let done = false;
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const fail = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.destroy();
    emit('error', new Error(`inbox ack to ${sockPath} failed: ${err?.code ?? err?.message ?? err}`));
  };
  timer = setTimeout(() => fail(new Error(`timeout after ${ACK_TIMEOUT_MS}ms`)), ACK_TIMEOUT_MS);
  socket.once('error', fail);
  socket.once('connect', () => {
    clearTimeout(timer);
    const payload = [
      `${JSON.stringify({ type: 'auth', token: '' })}\n`,
      `${JSON.stringify({ type: 'control', action: 'peer_message_status', orig_msg_id: msgId, status: 'delivered' })}\n`,
    ].join('');
    socket.end(payload, () => {
      done = true;
      socket.destroy();
    });
  });
}

/**
 * @typedef {Object} Inbox
 * @property {string} sockPath
 * @property {(event: string, fn: (payload: any) => void) => void} on
 * @property {(event: string, fn: (payload: any) => void) => void} off
 * @property {() => Promise<void>} close
 */

/**
 * Listen on `<dir>/<process.pid>.sock`.
 * Events: 'receipt' (peer_message_status frame), 'idle' (peer_idle_notice frame),
 * 'message' (user frame, i.e. a reply from another Claude session), 'error' (socket
 * error or an unparseable line). Frames without a `type` are ignored.
 * @param {{ dir?: string }} [options] defaults to the primary claudeSocksDir()
 * @returns {Promise<Inbox>}
 */
export async function startInbox({ dir } = {}) {
  const targetDir = dir ?? defaultInboxDir();
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const sockPath = join(targetDir, `${process.pid}.sock`);
  const name = basename(sockPath);
  if (!SOCK_NAME_RE.test(name)) {
    throw new Error(`inbox socket name ${name} does not match ${SOCK_NAME_RE}`);
  }
  try {
    unlinkSync(sockPath); // stale socket left by a crashed process
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  /** @type {Map<string, Set<(payload: any) => void>>} */
  const listeners = new Map();

  /**
   * A listener that throws must not be swallowed, and must not break the other
   * listeners silently: route it to 'error', or rethrow when nobody handles it.
   * @param {string} event
   * @param {any} payload
   */
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        if (event === 'error' || !(listeners.get('error')?.size)) throw err;
        emit('error', err);
      }
    }
  };

  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  };
  const off = (event, fn) => {
    listeners.get(event)?.delete(fn);
  };

  /** @param {string} line */
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      emit('error', new Error(`inbox: unparseable line from peer: ${trimmed.slice(0, 200)}`));
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
    if (frame.type === 'control' && frame.action === 'peer_message_status') emit('receipt', frame);
    else if (frame.type === 'control' && frame.action === 'peer_idle_notice') emit('idle', frame);
    else if (frame.type === 'user') {
      // A reply from another SBB process: acknowledge it on its own inbox socket.
      const ackTo = frame.reply_to && typeof frame.msg_id === 'string' && frame.msg_id !== ''
        ? parseUdsAddress(frame.from)
        : undefined;
      if (ackTo) ackPeer(ackTo, frame.msg_id, emit);
      emit('message', frame);
    }
  };

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        handleLine(line);
      }
    });
    socket.on('error', (err) => emit('error', err));
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(sockPath);
  });
  server.on('error', (err) => emit('error', err));

  const onExit = () => {
    // Process is exiting; there is nothing useful to do with a failure here.
    try {
      unlinkSync(sockPath);
    } catch {
      /* socket already gone */
    }
  };
  process.on('exit', onExit);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    process.off('exit', onExit);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(sockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  };

  return { sockPath, on, off, close };
}

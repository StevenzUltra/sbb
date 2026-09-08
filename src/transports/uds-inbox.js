// Inbox: a Unix-socket server that receives control frames and replies from peer
// Claude sessions. The receiver of a `user` frame posts back to the sender's `from`
// address, so a sender that wants receipts must listen here.
// See docs/spec/protocols.md section 1.
import { createServer } from 'node:net';
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
    else if (frame.type === 'user') emit('message', frame);
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

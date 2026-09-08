// Test fixture: a fake Claude session socket. Accepts auth + user frames, records them,
// and can post peer_message_status / peer_idle_notice back to the sender's `from`.
// Tests must never talk to a real Claude session.
import { createServer, connect } from 'node:net';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {Object} FakeClaudeServer
 * @property {string} sockPath
 * @property {any[]} frames          parsed frames in arrival order
 * @property {Error[]} postErrors    automatic status posts that could not be delivered
 * @property {string} raw            every byte received, concatenated
 * @property {(n: number, timeoutMs?: number) => Promise<any[]>} waitForFrames
 * @property {(opts: { to: string, msgId: string, status: string, statusDetail?: string, dropReason?: string }) => Promise<void>} postStatus
 * @property {(opts: { to: string, msgId: string, state?: string, detail?: string, fromMode?: string }) => Promise<void>} postIdle
 * @property {() => Promise<void>} close
 */

/**
 * @param {Object} [options]
 * @param {string} [options.dir]        directory for the socket; a temp dir by default
 * @param {string} [options.sockPath]   full socket path; overrides dir
 * @param {string} [options.token]      accepted auth token (recorded, not enforced)
 * @param {null|string|((frame: any) => ({ msgId?: string, status: string, statusDetail?: string, dropReason?: string }|null))} [options.autoStatus]
 *        reply automatically to a user frame that carries a `from` address
 * @returns {Promise<FakeClaudeServer>}
 */
export async function startFakeClaudeServer({ dir, sockPath, token = 'tok-abc', autoStatus = null } = {}) {
  const baseDir = dir ?? mkdtempSync(join(tmpdir(), 'sbb-fake-'));
  const path = sockPath ?? join(baseDir, `${process.pid}.sock`);
  /** @type {any[]} */
  const frames = [];
  /** @type {Error[]} */
  const postErrors = [];
  let raw = '';

  /**
   * @param {string} toAddress
   * @param {object} frame
   */
  const post = (toAddress, frame) =>
    new Promise((resolve, reject) => {
      const target = String(toAddress).replace(/^uds:/, '');
      const socket = connect(target);
      socket.once('error', reject);
      socket.end(`${JSON.stringify(frame)}\n`, () => resolve());
    });

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      raw += chunk;
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          frame = { __unparseable: line };
        }
        frames.push(frame);
        if (frame.type === 'user' && frame.from) {
          const spec = typeof autoStatus === 'function' ? autoStatus(frame) : autoStatus;
          if (spec) {
            const status = typeof spec === 'string' ? { status: spec } : spec;
            post(frame.from, {
              type: 'control',
              action: 'peer_message_status',
              orig_msg_id: status.msgId ?? frame.msg_id,
              status: status.status,
              status_detail: status.statusDetail,
              drop_reason: status.dropReason,
            }).catch((err) => {
              postErrors.push(err);
            });
          }
        }
      }
    });
    socket.on('error', () => {
      /* the sender ended the connection; nothing to report in a fixture */
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  /** @param {number} n @param {number} [timeoutMs] */
  const waitForFrames = async (n, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (frames.length < n) {
      if (Date.now() > deadline) throw new Error(`fake server saw ${frames.length} frames, expected ${n}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return frames;
  };

  return {
    sockPath: path,
    frames,
    postErrors,
    get raw() {
      return raw;
    },
    waitForFrames,
    postStatus: ({ to, msgId, status, statusDetail, dropReason }) =>
      post(to, {
        type: 'control',
        action: 'peer_message_status',
        orig_msg_id: msgId,
        status,
        status_detail: statusDetail,
        drop_reason: dropReason,
      }),
    postIdle: ({ to, msgId, state = 'idle', detail, fromMode = 'bypass' }) =>
      post(to, {
        type: 'control',
        action: 'peer_idle_notice',
        orig_msg_id: msgId,
        state,
        detail,
        from_mode: fromMode,
      }),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(path);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },
  };
}

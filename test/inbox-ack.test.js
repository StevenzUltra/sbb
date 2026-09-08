// Inbox ack: a peer `user` frame carrying reply_to is answered on its own inbox
// socket, so the sender's `sbb reply` can report `delivered via=uds-inbox`.
// docs/spec/lifecycle.md section "Inbox ack".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUdsAddress, startInbox } from '../src/transports/uds-inbox.js';
import { sendToInbox } from '../src/transports/claude-uds.js';
import { appendReceipt } from '../src/registry/receipts.js';
import { run as replyRun } from '../src/cli/reply.js';
import { shortId } from '../src/lib/ids.js';
import { tempDir, withEnv } from './fixtures/registry/helpers.js';

const sockDir = () => mkdtempSync(join(tmpdir(), 'sbb-h1-sock-'));

/** Poll until `check()` is true, or fail with the label. */
async function waitFor(check, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A peer socket that captures whatever arrives on it. */
async function captureServer(dir = sockDir()) {
  const sockPath = join(dir, `${process.pid}.sock`);
  const received = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
    });
    socket.on('end', () => received.push(buffered));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  return {
    sockPath,
    received,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Write one newline-terminated frame into an inbox socket. */
function writeFrame(sockPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify(frame)}\n`, resolve));
  });
}

test('parseUdsAddress: only a uds: address whose socket name peers accept', () => {
  assert.equal(parseUdsAddress('uds:/tmp/cc-socks/123.sock'), '/tmp/cc-socks/123.sock');
  assert.equal(parseUdsAddress('uds:/tmp/cc-socks/123-abcdef01.sock'), '/tmp/cc-socks/123-abcdef01.sock');
  assert.equal(parseUdsAddress('uds:/tmp/cc-socks/abcdef0123456789.sock'), '/tmp/cc-socks/abcdef0123456789.sock');
  assert.equal(parseUdsAddress('uds:/tmp/cc-socks/foo.sock'), undefined);
  assert.equal(parseUdsAddress('/tmp/cc-socks/123.sock'), undefined);
  assert.equal(parseUdsAddress('uds:'), undefined);
  assert.equal(parseUdsAddress(undefined), undefined);
});

test('inbox acks a peer user frame that carries reply_to', async () => {
  const peer = await captureServer();
  const inbox = await startInbox({ dir: sockDir() });
  const messages = [];
  inbox.on('message', (frame) => messages.push(frame));
  try {
    await writeFrame(inbox.sockPath, {
      type: 'user',
      msg_id: 'a1b2c3d4',
      reply_to: 'e5f60718',
      from: `uds:${peer.sockPath}`,
      message: { role: 'user', content: 'hello' },
    });
    await waitFor(() => peer.received.length === 1, 'the ack on the peer socket');
    const lines = peer.received[0].trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { type: 'auth', token: '' },
      { type: 'control', action: 'peer_message_status', orig_msg_id: 'a1b2c3d4', status: 'delivered' },
    ]);
    assert.equal(messages.length, 1, 'the frame still reaches the message listener');
    assert.equal(messages[0].msg_id, 'a1b2c3d4');
  } finally {
    await inbox.close();
    await peer.close();
  }
});

for (const [label, frame] of [
  ['no reply_to', { type: 'user', msg_id: 'a1b2c3d4', from: 'PLACEHOLDER' }],
  ['an empty msg_id', { type: 'user', msg_id: '', reply_to: 'e5f60718', from: 'PLACEHOLDER' }],
  ['a from that is not a uds: address', { type: 'user', msg_id: 'a1b2c3d4', reply_to: 'e5f60718', from: '/tmp/123.sock' }],
  ['a socket name peers would reject', { type: 'user', msg_id: 'a1b2c3d4', reply_to: 'e5f60718', from: 'uds:/tmp/foo.sock' }],
]) {
  test(`inbox sends no ack for ${label}`, async () => {
    const peer = await captureServer();
    const inbox = await startInbox({ dir: sockDir() });
    const messages = [];
    inbox.on('message', (f) => messages.push(f));
    try {
      await writeFrame(inbox.sockPath, { ...frame, from: frame.from === 'PLACEHOLDER' ? `uds:${peer.sockPath}` : frame.from });
      await waitFor(() => messages.length === 1, 'the message frame');
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(peer.received, []);
    } finally {
      await inbox.close();
      await peer.close();
    }
  });
}

test('sendToInbox: a real SBB inbox ack makes the receipt delivered', async () => {
  const senderInbox = await startInbox({ dir: sockDir() });
  const receiverInbox = await startInbox({ dir: sockDir() });
  const receiverErrors = [];
  receiverInbox.on('error', (err) => receiverErrors.push(err));
  try {
    const { ok, receipt } = await sendToInbox({
      sockPath: receiverInbox.sockPath,
      inbox: senderInbox,
      ackTimeoutMs: 1000,
      message: {
        msgId: 'a1b2c3d4e5f60718',
        text: 'hello',
        priority: 'next',
        replyTo: 'ffffffff',
        fromBrain: 'ios',
        fromName: 'ios',
        fromSock: `uds:${senderInbox.sockPath}`,
      },
    });
    assert.equal(ok, true);
    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.via, 'uds-inbox');
    assert.equal(receipt.detail, 'acked by the receiving SBB inbox');
    assert.deepEqual(receiverErrors, []);
  } finally {
    await senderInbox.close();
    await receiverInbox.close();
  }
});

test('sendToInbox: without an inbox the frame is only written, so it stays queued', async () => {
  const peer = await captureServer();
  try {
    const { ok, receipt } = await sendToInbox({
      sockPath: peer.sockPath,
      message: { msgId: 'a1b2c3d4e5f60718', text: 'hello', priority: 'next' },
    });
    assert.equal(ok, true);
    assert.equal(receipt.status, 'queued');
    assert.equal(receipt.detail, 'waiting inbox accepted the frame (no protocol ack)');
  } finally {
    await peer.close();
  }
});

test('sendToInbox: a peer that never acks stays queued with the timeout in the detail', async () => {
  const peer = await captureServer();
  const inbox = await startInbox({ dir: sockDir() });
  try {
    const { ok, receipt } = await sendToInbox({
      sockPath: peer.sockPath,
      inbox,
      ackTimeoutMs: 60,
      message: { msgId: 'a1b2c3d4e5f60718', text: 'hello', priority: 'next', fromSock: `uds:${inbox.sockPath}` },
    });
    assert.equal(ok, true);
    assert.equal(receipt.status, 'queued');
    assert.match(receipt.detail, /no ack within 60ms/);
  } finally {
    await inbox.close();
    await peer.close();
  }
});

test('sbb reply reports delivered via=uds-inbox when the waiting inbox acks', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  const waiting = await startInbox({ dir: sockDir() });
  const deliveryDir = sockDir();
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(line);
  try {
    const msgId = 'a1b2c3d4e5f60718';
    appendReceipt({
      msgId,
      from: 'ios',
      fromAddress: 'a/claude:ios',
      fromSock: `uds:${waiting.sockPath}`,
      status: 'delivered',
      via: 'uds',
    });
    const code = await replyRun([shortId(msgId), 'ack please'], {
      rows: [],
      startInbox: () => startInbox({ dir: deliveryDir }),
    });
    assert.equal(code, 0);
    assert.match(logged[0], /^delivered {2}msg=[0-9a-f]{8} {2}via=uds-inbox {2}\d+\.\ds/);
    assert.match(logged[0], /acked by the receiving SBB inbox/);
  } finally {
    console.log = original;
    restore();
    await waiting.close();
  }
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { claudeUds, closeInboxes } from '../src/transports/claude-uds.js';
import { startInbox } from '../src/transports/uds-inbox.js';
import { startFakeClaudeServer } from './fixtures/fake-claude-server.js';

const MSG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN = 'tok-abc';

const tmpDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** A key file shaped like Claude Code's `<pid>.<sha256>.key`. */
function keyFileWith(token) {
  const path = join(tmpDir('sbb-key-'), '1234.abcdef.key');
  writeFileSync(path, JSON.stringify({ peerToken: token, procStart: 'x', pidDomain: 'darwin' }), { mode: 0o600 });
  return path;
}

/** Our own inbox address; claude-uds starts the listener lazily from this path. */
const fromIn = (dir) => `uds:${join(dir, `${process.pid}.sock`)}`;

function targetFor(server, { keyFile = keyFileWith(TOKEN), sock = server.sockPath } = {}) {
  return {
    address: 'b/claude:test',
    account: 'b',
    cli: 'claude',
    paneId: '%31',
    coord: '24:3.5',
    claude: { pid: 1234, sessionId: 's', cwd: '/tmp', sock, keyFile, account: 'b', version: '2.1.263' },
  };
}

const msg = (over = {}) => ({ msgId: MSG_ID, text: 'hello world', priority: 'next', fromBrain: 'lead', ...over });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await delay(5);
  }
}

after(() => closeInboxes());

test('supports only claude targets whose socket exists', async () => {
  const server = await startFakeClaudeServer();
  try {
    assert.equal(claudeUds.supports(targetFor(server)), true);
    assert.equal(claudeUds.supports({ ...targetFor(server), cli: 'codex' }), false);
    assert.equal(claudeUds.supports(targetFor(server, { sock: join(tmpdir(), 'sbb-missing.sock') })), false);
    assert.equal(claudeUds.supports({ cli: 'claude' }), false);
  } finally {
    await server.close();
  }
});

test('writes the exact auth and user lines, without from, and reports queued at once', async () => {
  const server = await startFakeClaudeServer();
  try {
    const receipt = await claudeUds.send(targetFor(server), msg(), {});
    assert.equal(receipt.status, 'queued');
    assert.equal(receipt.via, 'uds');
    assert.equal(receipt.msgId, MSG_ID);
    assert.equal(receipt.reason, undefined);
    assert.equal(typeof receipt.elapsedMs, 'number');

    await server.waitForFrames(2);
    assert.equal(
      server.raw,
      `{"type":"auth","token":"${TOKEN}"}\n` +
        `{"type":"user","message":{"role":"user","content":"hello world"},"msg_id":"${MSG_ID}","priority":"next"}\n`,
    );
    assert.deepEqual(server.frames[0], { type: 'auth', token: TOKEN });
    assert.equal(server.frames[1].from, undefined);
  } finally {
    await server.close();
  }
});

test('includes from in the user line when the message carries a fromSock', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  const fromSock = fromIn(dir);
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock }), { verifyTimeoutMs: 1000 });
    assert.equal(receipt.status, 'delivered');
    await server.waitForFrames(2);
    assert.equal(
      server.raw.split('\n')[1],
      `{"type":"user","message":{"role":"user","content":"hello world"},"msg_id":"${MSG_ID}","priority":"next","from":"${fromSock}"}`,
    );
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('maps a delivered receipt', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), { verifyTimeoutMs: 1000 });
    assert.deepEqual(
      { status: receipt.status, via: receipt.via, reason: receipt.reason },
      { status: 'delivered', via: 'uds', reason: undefined },
    );
  } finally {
    await server.close();
    await closeInboxes();
  }
});

for (const [peerStatus, expectedReason] of [
  ['held', 'held'],
  ['denied', 'denied'],
  ['refused', 'refused'],
  ['dropped', 'dropped'],
  ['expired', 'expired'],
]) {
  test(`maps a ${peerStatus} receipt to blocked/${expectedReason}`, async () => {
    const server = await startFakeClaudeServer({
      autoStatus: { status: peerStatus, statusDetail: 'why', dropReason: 'queue-full' },
    });
    const dir = tmpDir('sbb-inbox-');
    try {
      const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), { verifyTimeoutMs: 1000 });
      assert.equal(receipt.status, 'blocked');
      assert.equal(receipt.reason, expectedReason);
      assert.equal(receipt.detail, 'why');
    } finally {
      await server.close();
      await closeInboxes();
    }
  });
}

test('no receipt within verifyTimeoutMs maps to queued', async () => {
  // The fake server answers with a status for a different msg_id: it must be ignored.
  const server = await startFakeClaudeServer({ autoStatus: () => ({ msgId: 'f'.repeat(32), status: 'delivered' }) });
  const dir = tmpDir('sbb-inbox-');
  try {
    const started = Date.now();
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), { verifyTimeoutMs: 120 });
    assert.equal(receipt.status, 'queued');
    assert.equal(receipt.reason, undefined);
    assert.match(receipt.detail, /no peer_message_status within 120ms/);
    assert.ok(Date.now() - started >= 100, `returned after ${Date.now() - started}ms, expected the full timeout`);
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('an unknown peer status is queued with the raw status in detail', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'something-new' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), { verifyTimeoutMs: 1000 });
    assert.equal(receipt.status, 'queued');
    assert.match(receipt.detail, /unknown peer status: something-new/);
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('a fromSock whose name peers would ignore is blocked before any write', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const started = Date.now();
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: `uds:${join(dir, 'not-a-pid.sock')}` }), {
      verifyTimeoutMs: 5000,
    });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.reason, 'transport_unavailable');
    assert.match(receipt.detail, /fromSock name not receivable by peers: not-a-pid.sock/);
    assert.ok(Date.now() - started < 500, 'must not wait for a receipt that can never arrive');
    assert.equal(server.frames.length, 0, 'must not write anything');
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('a fromSock that is not a uds: address is blocked before any write', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: join(dir, '123.sock') }), {
      verifyTimeoutMs: 1000,
    });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.reason, 'transport_unavailable');
    assert.match(receipt.detail, /fromSock must be a uds: address/);
    assert.equal(server.frames.length, 0, 'must not write anything');
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('a fromSock that is not this process inbox is blocked before any write', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: `uds:${join(dir, '999.sock')}` }), {
      verifyTimeoutMs: 1000,
    });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.reason, 'transport_unavailable');
    assert.match(receipt.detail, /fromSock must be this process inbox/);
    assert.equal(server.frames.length, 0, 'must not write anything');
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('an opts.inbox at another path is blocked too', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  const other = await startInbox({ dir: tmpDir('sbb-other-') });
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), {
      inbox: other,
      verifyTimeoutMs: 1000,
    });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.reason, 'transport_unavailable');
    assert.match(receipt.detail, new RegExp(`fromSock must be this process inbox: ${other.sockPath}`));
    assert.equal(server.frames.length, 0, 'must not write anything');
  } finally {
    await other.close();
    await server.close();
    await closeInboxes();
  }
});

test('connect failure is blocked/socket_connect_failed', async () => {
  const server = await startFakeClaudeServer();
  const missing = join(tmpdir(), `sbb-missing-${process.pid}.sock`);
  try {
    const receipt = await claudeUds.send(targetFor(server, { sock: missing }), msg(), { verifyTimeoutMs: 100 });
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.reason, 'socket_connect_failed');
  } finally {
    await server.close();
  }
});

for (const [label, makeKeyFile] of [
  ['missing file', () => join(tmpdir(), 'sbb-no-such-key.json')],
  ['malformed JSON', () => {
    const p = join(tmpDir('sbb-key-'), 'bad.key');
    writeFileSync(p, 'not json');
    return p;
  }],
  ['no peerToken', () => {
    const p = join(tmpDir('sbb-key-'), 'empty.key');
    writeFileSync(p, JSON.stringify({ procStart: 'x' }));
    return p;
  }],
  ['no keyFile at all', () => null],
]) {
  test(`unreadable key (${label}) is blocked/transport_unavailable`, async () => {
    const server = await startFakeClaudeServer();
    try {
      const receipt = await claudeUds.send(targetFor(server, { keyFile: makeKeyFile() }), msg(), { verifyTimeoutMs: 100 });
      assert.equal(receipt.status, 'blocked');
      assert.equal(receipt.reason, 'transport_unavailable');
      assert.equal(server.frames.length, 0, 'must not write anything without a token');
    } finally {
      await server.close();
    }
  });
}

test('notifyIdle sends the notify_when_idle frame on a fresh connection after delivery', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  const fromSock = fromIn(dir);
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock }), { verifyTimeoutMs: 1000, notifyIdle: true });
    assert.equal(receipt.status, 'delivered');
    await server.waitForFrames(4);
    assert.deepEqual(server.frames[2], { type: 'auth', token: TOKEN });
    assert.deepEqual(server.frames[3], {
      type: 'control',
      action: 'notify_when_idle',
      from: fromSock,
      msg_id: MSG_ID,
      from_mode: 'bypass',
    });
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('notifyIdle is not sent when the option is off', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'delivered' });
  const dir = tmpDir('sbb-inbox-');
  try {
    await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), { verifyTimeoutMs: 1000 });
    await server.waitForFrames(2);
    await delay(50);
    assert.equal(server.frames.length, 2);
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('notifyIdle is not sent for a blocked receipt', async () => {
  const server = await startFakeClaudeServer({ autoStatus: 'held' });
  const dir = tmpDir('sbb-inbox-');
  try {
    const receipt = await claudeUds.send(targetFor(server), msg({ fromSock: fromIn(dir) }), {
      verifyTimeoutMs: 1000,
      notifyIdle: true,
    });
    assert.equal(receipt.status, 'blocked');
    await server.waitForFrames(2);
    await delay(50);
    assert.equal(server.frames.length, 2);
  } finally {
    await server.close();
    await closeInboxes();
  }
});

test('inbox parses partial lines and several frames per chunk', async () => {
  const dir = tmpDir('sbb-inbox-');
  const inbox = await startInbox({ dir });
  try {
    assert.equal(basename(inbox.sockPath), `${process.pid}.sock`);
    assert.ok(existsSync(inbox.sockPath));

    const receipts = [];
    const messages = [];
    const idles = [];
    inbox.on('receipt', (f) => receipts.push(f));
    inbox.on('message', (f) => messages.push(f));
    inbox.on('idle', (f) => idles.push(f));

    const socket = connect(inbox.sockPath);
    socket.on('error', () => {});
    await new Promise((r) => socket.once('connect', r));

    // one full frame plus the head of a second one
    socket.write(
      '{"type":"control","action":"peer_message_status","orig_msg_id":"aa","status":"delivered"}\n' +
        '{"type":"control","action":"peer_mess',
    );
    await waitUntil(() => receipts.length === 1);
    assert.equal(receipts[0].orig_msg_id, 'aa');
    assert.equal(messages.length, 0);
    await delay(30);
    assert.equal(receipts.length, 1, 'a partial line must not be emitted');

    socket.write('age_status","orig_msg_id":"bb","status":"held"}\n');
    await waitUntil(() => receipts.length === 2);
    assert.equal(receipts[1].orig_msg_id, 'bb');

    // three frames in one chunk, one of them without a type
    socket.write(
      '{"type":"control","action":"peer_idle_notice","orig_msg_id":"aa","state":"idle"}\n' +
        '{"no":"type"}\n' +
        '{"type":"user","message":{"role":"user","content":"pong"},"msg_id":"cc"}\n',
    );
    await waitUntil(() => idles.length === 1 && messages.length === 1);
    assert.equal(idles[0].state, 'idle');
    assert.equal(messages[0].message.content, 'pong');

    socket.end();
    await inbox.close();
    assert.equal(existsSync(inbox.sockPath), false, 'close() must unlink the socket');
  } finally {
    await inbox.close();
  }
});

test('inbox off() stops delivering to a removed listener', async () => {
  const dir = tmpDir('sbb-inbox-');
  const inbox = await startInbox({ dir });
  try {
    const seen = [];
    const fn = (f) => seen.push(f);
    inbox.on('receipt', fn);
    inbox.off('receipt', fn);

    const socket = connect(inbox.sockPath);
    socket.on('error', () => {});
    await new Promise((r) => socket.once('connect', r));
    socket.end('{"type":"control","action":"peer_message_status","orig_msg_id":"aa","status":"delivered"}\n');
    await delay(50);
    assert.equal(seen.length, 0);
  } finally {
    await inbox.close();
  }
});

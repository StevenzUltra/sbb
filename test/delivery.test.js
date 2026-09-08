// Delivery path: the sender-side inbox, fromSock/fromName/fromMode on the wire, and the
// optional screen confirmation that upgrades a `queued` uds receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as tellRun } from '../src/cli/tell.js';
import { run as askRun } from '../src/cli/ask.js';
import { run as replyRun } from '../src/cli/reply.js';
import { deliver, fromModeFromEnv, parseDuration, parsePeerFrame } from '../src/cli/util.js';
import { listInbox, writeInboxEntry } from '../src/registry/inbox.js';
import { startFakeClaudeServer } from './fixtures/fake-claude-server.js';
import { send as realSend } from '../src/transports/index.js';
import { readReceiptEntries } from '../src/registry/receipts.js';
import { captureLog, tempDir, withEnv } from './fixtures/registry/helpers.js';

const MSG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REPLY_ID = 'bb'.repeat(16);
const SOCK = '/tmp/cc-socks/4242.sock';

const ROWS = [
  {
    brain: 'h3', brainId: 'TST-0002', role: 'sub', parent: 'TST-0001', account: 'b', cli: 'claude',
    model: null, status: 'idle', name: 'h3', cwd: '/Users/dev/proj', paneId: '%73', coord: '24:3.7',
    pid: 4321, threadId: null, hasRollout: null, threadUncertain: false, sock: SOCK, keyFile: '/tmp/4242.key',
    source: 'pane', where: '24:3.7', claude: { pid: 4321 }, codex: undefined,
  },
];

const TARGET = {
  address: 'lead', brain: 'lead', brainId: 'TST-0001', account: 'a', cli: 'claude',
  paneId: '%30', coord: '24:3.4', claude: { sock: SOCK, keyFile: '/tmp/4242.key' }, codex: undefined,
};

function sbbEnv(home, extra = {}) {
  return { SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb'), TMUX_PANE: undefined, SBB_FROM_MODE: undefined, ...extra };
}

/** A stand-in for the real uds inbox: records listeners, lets a test emit frames. */
function fakeInbox(sockPath = SOCK) {
  const listeners = new Map();
  return {
    sockPath,
    closes: 0,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
    async close() {
      this.closes += 1;
    },
  };
}

/** @param {Record<string, any>} over */
function deps(over = {}) {
  const inbox = over.inbox ?? fakeInbox();
  return {
    inbox,
    ...{
      rows: ROWS,
      paneId: '%73',
      msgId: MSG_ID,
      startInbox: async () => inbox,
      resolve: async () => TARGET,
      send: async () => ({ status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 7 }),
      ...over,
    },
  };
}

test('parseDuration: a bare number is milliseconds, not seconds', () => {
  assert.equal(parseDuration('6000'), 6000, '--timeout 6000 is 6 s, not 100 minutes');
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});

test('sbb tell: resolves within a second of the transport and leaves no handle behind', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inbox = fakeInbox();
    let seenOpts;
    let released = 0;
    const count = (list) => list.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
    const before = count(process.getActiveResourcesInfo());
    const d = deps({
      inbox,
      closeInboxes: async () => {
        released += 1;
      },
      send: async (target, message, opts) => {
        seenOpts = opts;
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 2 };
      },
    });
    const started = Date.now();
    const out = await captureLog(() => tellRun(['lead', 'ping', '--timeout', '6000'], d));
    const elapsed = Date.now() - started;
    assert.equal(out.result, 0);
    assert.equal(seenOpts.verifyTimeoutMs, 6000, '--timeout is milliseconds on the wire');
    assert.ok(elapsed < 1000, `run() must resolve promptly, took ${elapsed}ms`);
    assert.equal(inbox.closes, 1, 'the sender inbox is closed');
    assert.equal(released, 1, 'transport-owned inboxes are closed too');
    const after = count(process.getActiveResourcesInfo());
    const leaked = Object.entries(after).filter(([kind, n]) => n > (before[kind] ?? 0)).map(([kind, n]) => `${kind}x${n - (before[kind] ?? 0)}`);
    assert.deepEqual(leaked, [], 'no handle survives the command');
    assert.equal(readReceiptEntries().at(-1).msgId, MSG_ID, 'the receipt is on disk before run() returns');
    assert.match(out.lines.join('\n'), /^queued/m);
  } finally {
    restore();
  }
});

test('sbb tell: uds sends from this process inbox with the brain name', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      startInbox: async ({ dir }) => {
        assert.equal(dir, '/tmp/cc-socks', 'the inbox listens in the primary Claude socket dir');
        return inbox;
      },
      send: async (target, message, opts) => {
        seen = { target, message, opts };
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 7 };
      },
    });
    const out = await captureLog(() => tellRun(['lead', 'check', 'the', 'PR'], d));
    assert.equal(out.result, 0);
    assert.equal(seen.message.fromSock, `uds:${SOCK}`);
    assert.equal(seen.message.fromName, 'h3#TST-0002');
    assert.equal(seen.message.fromMode, undefined, 'no SBB_FROM_MODE means no from-mode attribute');
    assert.equal(seen.opts.inbox, inbox, 'the transport must listen on the same inbox as fromSock');
    assert.equal(inbox.closes, 1, 'the inbox is closed before the process exits');

    const logged = readReceiptEntries().at(-1);
    assert.equal(logged.fromSock, `uds:${SOCK}`);
    assert.equal(logged.fromId, 'TST-0002');
    assert.equal(logged.status, 'queued');
  } finally {
    restore();
  }
});

test('sbb tell: fromMode is taken from SBB_FROM_MODE and nothing else', async () => {
  const home = tempDir();
  try {
    const messages = [];
    const run = async (env) => {
      const restore = withEnv(sbbEnv(home, env));
      try {
        const d = deps({
          send: async (target, message) => {
            messages.push(message);
            return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 1 };
          },
        });
        return await captureLog(() => tellRun(['lead', 'ping'], d));
      } finally {
        restore();
      }
    };
    await run({ SBB_FROM_MODE: 'bypass' });
    await run({ SBB_FROM_MODE: 'prompting' });
    await run({ SBB_FROM_MODE: 'sudo' });
    await run({});
    assert.deepEqual(messages.map((m) => m.fromMode), ['bypass', 'prompting', undefined, undefined]);
  } finally {
    delete process.env.SBB_FROM_MODE;
  }
});

test('sbb tell: a non-claude target starts no inbox and sends no fromSock', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let started = 0;
    let seen;
    const d = deps({
      startInbox: async () => {
        started += 1;
        return fakeInbox();
      },
      resolve: async () => ({ ...TARGET, cli: 'codex', claude: undefined }),
      send: async (target, message) => {
        seen = message;
        return { status: 'queued', via: 'codex-queue', msgId: MSG_ID, elapsedMs: 1 };
      },
    });
    const out = await captureLog(() => tellRun(['lead', 'ping'], d));
    assert.equal(out.result, 0);
    assert.equal(started, 0, 'only a claude target can send a receipt back over uds');
    assert.equal(seen.fromSock, undefined);
    assert.equal(seen.fromName, 'h3#TST-0002', 'the display name is independent of the transport');
  } finally {
    restore();
  }
});

test('sbb tell: frames received while sending land in the receipt log and the inbox', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      send: async () => {
        inbox.emit('receipt', {
          type: 'control', action: 'peer_message_status', orig_msg_id: MSG_ID,
          status: 'held', status_detail: 'approval dialog',
        });
        inbox.emit('message', {
          type: 'user',
          msg_id: REPLY_ID,
          message: {
            role: 'user',
            content: `<cross-session-message from="uds:/tmp/cc-socks/9999.sock" from-name="lead#TST-0001" from-mode="bypass">\n[lead#TST-0001@a/claude:24:3.4][主脑] PONG   (sbb:cccccccc)\n</cross-session-message>`,
          },
        });
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 3 };
      },
    });
    const out = await captureLog(() => tellRun(['lead', 'ping'], d));
    assert.equal(out.result, 0);

    const status = readReceiptEntries().find((e) => e.kind === 'peer-status');
    assert.equal(status.msgId, MSG_ID);
    assert.equal(status.status, 'held');
    assert.equal(status.statusDetail, 'approval dialog');
    assert.equal(status.owner, 'h3');

    const entries = listInbox('h3');
    assert.equal(entries.length, 1);
    const entry = entries[0].entry;
    assert.equal(entry.msgId, REPLY_ID);
    assert.equal(entry.from, 'lead#TST-0001', 'the wrapper from-name becomes the sender');
    assert.equal(entry.fromSock, 'uds:/tmp/cc-socks/9999.sock');
    assert.equal(entry.replyTo, null, 'the wire frame carries no reply id; never invent one');
    assert.match(entry.text, /PONG/);
    assert.doesNotMatch(entry.text, /cross-session-message/);
  } finally {
    restore();
  }
});

test('sbb ask: the inbox stays open for the wait and its reply is collected', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      pollMs: 1,
      sleep: async () => {},
      send: async () => {
        inbox.emit('message', {
          type: 'user',
          msg_id: REPLY_ID,
          reply_to: MSG_ID,
          message: { role: 'user', content: 'PONG' },
        });
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 2 };
      },
    });
    const out = await captureLog(() => askRun(['lead', 'ping'], d));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /reply {5}msg=bbbbbbbb/);
    assert.match(out.lines.join('\n'), /PONG/);
    assert.equal(inbox.closes, 1);
  } finally {
    restore();
  }
});

/** @param {string} from @param {string} text */
function peerFrame(from, text) {
  return {
    type: 'user',
    msg_id: REPLY_ID,
    message: { role: 'user', content: `<cross-session-message from="${from}" from-name="lead#TST-0001">\n${text}\n</cross-session-message>` },
  };
}

test('sbb ask: a frame from the target socket is the reply when reply_to is missing', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      pollMs: 1,
      sleep: async () => {},
      send: async () => {
        inbox.emit('message', peerFrame(`uds:${SOCK}`, '好'));
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 2 };
      },
    });
    const out = await captureLog(() => askRun(['lead', 'ping'], d));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /reply {5}msg=bbbbbbbb from=lead#TST-0001 {2}via=fromSock/);
    assert.match(out.lines.join('\n'), /好/);
  } finally {
    restore();
  }
});

test('sbb ask: a body carrying sbb:<msgId first 8> is the reply from any socket', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      pollMs: 1,
      sleep: async () => {},
      send: async () => {
        inbox.emit('message', peerFrame('uds:/tmp/cc-socks/9999.sock', `PONG   (sbb:${MSG_ID.slice(0, 8)})`));
        return { status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 2 };
      },
    });
    const out = await captureLog(() => askRun(['lead', 'ping'], d));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /via=body/);
    assert.match(out.lines.join('\n'), /PONG/);
  } finally {
    restore();
  }
});

test('sbb ask: a message from the target that predates the wait is not the reply', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeInboxEntry({
      owner: 'h3',
      entry: { msgId: 'cc'.repeat(16), from: 'lead#TST-0001', fromSock: `uds:${SOCK}`, text: 'older news', t: 1000 },
    });
    const d = deps({
      inbox: fakeInbox(),
      pollMs: 1,
      sleep: async () => {},
      send: async () => ({ status: 'queued', via: 'uds', msgId: MSG_ID, elapsedMs: 2 }),
    });
    const out = await captureLog(() => askRun(['lead', 'ping', '--wait', '1'], d));
    assert.equal(out.result, 5);
    assert.equal(out.lines.at(-1), 'timeout');
  } finally {
    restore();
  }
});

test('sbb tell: the real uds transport returns on --timeout and persists the receipt', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const dir = tempDir();
    const server = await startFakeClaudeServer({ dir, token: 'tok-real' });
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, JSON.stringify({ peerToken: 'tok-real' }));
    const target = {
      address: 'lead', account: 'a', cli: 'claude', paneId: null, coord: '24:3.4',
      claude: { sock: server.sockPath, keyFile }, codex: undefined,
    };
    const started = Date.now();
    const out = await captureLog(() => tellRun(
      ['lead', 'ping', '--timeout', '300'],
      { rows: [], msgId: MSG_ID, resolve: async () => target, send: realSend },
    ));
    const elapsed = Date.now() - started;
    try {
      assert.equal(out.result, 0, 'a delivered-but-unconfirmed message is queued, not an error');
      assert.ok(elapsed < 3000, `--timeout 300 must return in seconds, took ${elapsed}ms`);
      assert.match(out.lines.join('\n'), /^queued/m);
      const receipt = readReceiptEntries().at(-1);
      assert.equal(receipt.msgId, MSG_ID);
      assert.equal(receipt.status, 'queued');
      assert.equal(receipt.via, 'uds');
      assert.match(receipt.fromSock, /^uds:\/tmp\/cc-socks\/\d+\.sock$/, 'the receipt records this process inbox');
      assert.equal(existsSync(receipt.fromSock.slice(4)), false, 'the sender socket is unlinked before returning');
    } finally {
      await server.close();
    }
  } finally {
    restore();
  }
});

test('sbb reply: sends from the sender inbox with replyTo set', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const inbox = fakeInbox();
    const d = deps({
      inbox,
      findReceipt: () => ({ msgId: MSG_ID, from: 'lead', fromAddress: 'a/claude:24:3.4' }),
      send: async (target, message) => {
        seen = message;
        return { status: 'delivered', via: 'uds', msgId: MSG_ID, elapsedMs: 5 };
      },
    });
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'done'], d));
    assert.equal(out.result, 0);
    assert.equal(seen.replyTo, MSG_ID);
    assert.equal(seen.fromSock, `uds:${SOCK}`);
    assert.equal(seen.fromName, 'h3#TST-0002');
    assert.equal(inbox.closes, 1);
  } finally {
    restore();
  }
});

test('parsePeerFrame: wrapper attributes and plain content', () => {
  const wrapped = parsePeerFrame({
    msg_id: REPLY_ID,
    message: { content: '<cross-session-message from="uds:/tmp/cc-socks/9.sock" from-name="ios#SMS-0012">\nhello\n</cross-session-message>' },
  });
  assert.equal(wrapped.from, 'ios#SMS-0012');
  assert.equal(wrapped.fromSock, 'uds:/tmp/cc-socks/9.sock');
  assert.equal(wrapped.text, 'hello');

  const plain = parsePeerFrame({ msg_id: REPLY_ID, message: { content: 'no wrapper' } });
  assert.equal(plain.from, null);
  assert.equal(plain.text, 'no wrapper');

  const noId = parsePeerFrame({ message: { content: 'x' } });
  assert.match(noId.msgId, /^[0-9a-f]{32}$/, 'a frame without msg_id still gets a usable entry id');
});

test('fromModeFromEnv: only the protocol vocabulary is forwarded', () => {
  assert.equal(fromModeFromEnv({}), undefined);
  assert.equal(fromModeFromEnv({ SBB_FROM_MODE: '' }), undefined);
  assert.equal(fromModeFromEnv({ SBB_FROM_MODE: 'bypass' }), 'bypass');
  assert.equal(fromModeFromEnv({ SBB_FROM_MODE: 'prompting' }), 'prompting');
  assert.equal(fromModeFromEnv({ SBB_FROM_MODE: 'bypass\nx' }), undefined);
});

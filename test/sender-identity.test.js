// Sender session identity: the CLAUDE_CODE_MESSAGING_SOCKET recorded on receipts, the reply
// routing order (fromSock -> senderSock -> brain/address -> coord) and --force passthrough.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run as tellRun } from '../src/cli/tell.js';
import { run as askRun } from '../src/cli/ask.js';
import { run as replyRun } from '../src/cli/reply.js';
import { deliver, enforceDelivery, senderSessionFromEnv } from '../src/cli/util.js';
import { formatCoordFull, splitCoordFull } from '../src/lib/coord.js';
import { ResolveError } from '../src/registry/resolve.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const MSG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SERVER = '/private/tmp/tmux-501/default';
const SENDER_SOCK = '/tmp/cc-socks/4242.sock';

const SENDER_ROW = {
  brain: 'lead-a', brainId: 'TST-0001', role: 'main', parent: null, account: 'a', cli: 'claude',
  model: null, status: 'idle', name: 'lead-a', cwd: '/tmp/proj', paneId: '%73', coord: '24:3.7',
  pid: 4321, source: 'pane', where: '24:3.7',
};

const TARGET_B = {
  address: 'lead-b', brain: 'lead-b', brainId: 'TST-0002', account: 'b', cli: 'claude',
  paneId: '%30', coord: '24:3.4', claude: { sock: '/tmp/cc-socks/3333.sock' }, codex: undefined,
};

/** The target reached through the sender's own session socket: no brain, no coord. */
const TARGET_SESSION = {
  address: 'uds:/tmp/cc-socks/2222.sock', account: 'b', cli: 'claude', paneId: null, coord: null,
  claude: { sock: '/tmp/cc-socks/2222.sock' }, codex: undefined,
};

function sbbEnv(home, extra = {}) {
  return {
    SBB_HOME_OVERRIDE: home,
    SBB_DIR: join(home, '.sbb'),
    TMUX_PANE: undefined,
    SBB_FROM_MODE: undefined,
    SBB_FORCE: undefined,
    CLAUDE_CODE_MESSAGING_SOCKET: undefined,
    ...extra,
  };
}

function fakeInbox(sockPath = '/tmp/cc-socks/9999.sock') {
  return { sockPath, closes: 0, on() {}, off() {}, async close() { this.closes += 1; } };
}

/** A receipt as `deliver` writes it: waiting inbox, session socket, server-qualified coord. */
function receipt(over = {}) {
  return {
    msgId: MSG_ID,
    from: 'lead-b',
    fromAddress: 'b/claude:24:3.4',
    fromSock: null,
    senderSock: null,
    senderPid: null,
    fromCoordFull: `${SERVER}@24:3.4`,
    ...over,
  };
}

/** Reply deps that keep routing in memory; callers override resolve/send/canConnect. */
function replyDeps(over = {}) {
  return {
    paneId: '%73',
    rows: [SENDER_ROW],
    startInbox: async () => fakeInbox(),
    closeInboxes: async () => {},
    ...over,
  };
}

test('senderSessionFromEnv reads CLAUDE_CODE_MESSAGING_SOCKET, normalizes uds:, parses the pid', () => {
  assert.deepEqual(senderSessionFromEnv({}), { senderSock: null, senderPid: null });
  assert.deepEqual(senderSessionFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '' }), { senderSock: null, senderPid: null });
  assert.deepEqual(senderSessionFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: SENDER_SOCK }), {
    senderSock: `uds:${SENDER_SOCK}`,
    senderPid: 4242,
  });
  assert.deepEqual(senderSessionFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: `uds:${SENDER_SOCK}` }), {
    senderSock: `uds:${SENDER_SOCK}`,
    senderPid: 4242,
  });
  assert.deepEqual(senderSessionFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/weird/socket' }), {
    senderSock: 'uds:/tmp/weird/socket',
    senderPid: null,
  });
});

test('coords carry the tmux server socket as a prefix without changing the display form', () => {
  assert.equal(formatCoordFull('24:3.4', SERVER), `${SERVER}@24:3.4`);
  assert.equal(formatCoordFull('24:3.4', null), '24:3.4');
  assert.equal(formatCoordFull('', SERVER), null);
  assert.deepEqual(splitCoordFull(`${SERVER}@24:3.4`), { serverPath: SERVER, coord: '24:3.4' });
  assert.deepEqual(splitCoordFull('24:3.4'), { serverPath: null, coord: '24:3.4' });
  assert.deepEqual(splitCoordFull(''), { serverPath: null, coord: null });
  assert.deepEqual(splitCoordFull(null), { serverPath: null, coord: null });
});

test('a sent receipt records senderSock, senderPid and both server-qualified coords', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const { entry } = await deliver({
      target: TARGET_B,
      body: 'hi',
      identity: {
        sender: 'lead-a', id: 'TST-0001', account: 'a', cli: 'claude', coord: '24:3.7',
        role: '主脑', brain: 'lead-a', address: 'a/claude:24:3.7',
      },
      deps: { env: { CLAUDE_CODE_MESSAGING_SOCKET: SENDER_SOCK }, serverPath: SERVER },
      send: async (t, m) => ({ status: 'delivered', via: 'uds', msgId: m.msgId, elapsedMs: 1 }),
    });
    assert.equal(entry.senderSock, `uds:${SENDER_SOCK}`);
    assert.equal(entry.senderPid, 4242);
    assert.equal(entry.fromCoordFull, `${SERVER}@24:3.7`);
    assert.equal(entry.toCoordFull, `${SERVER}@24:3.4`);
    assert.equal(entry.fromAddress, 'a/claude:24:3.7', 'the display form is unchanged');
    assert.equal(entry.address, 'lead-b');
  } finally {
    restore();
  }
});

test('a blocked receipt carries the same sender identity fields', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const blocked = await enforceDelivery({
      target: TARGET_B,
      identity: {
        sender: 'lead-a', id: 'TST-0001', account: 'a', cli: 'claude', coord: '24:3.7',
        role: '主脑', brain: 'lead-a',
      },
      message: { msgId: MSG_ID },
      text: 'hi',
      msgId: MSG_ID,
      senderSession: { senderSock: `uds:${SENDER_SOCK}`, senderPid: 4242 },
      serverPath: SERVER,
      deps: {
        getBrain: (id) => ({ id, name: 'lead-b', account: 'b' }),
        checkPolicy: () => ({ ok: false, detail: 'peers off for account b' }),
        readConfig: () => ({}),
      },
    });
    assert.equal(blocked.entry.reason, 'policy');
    assert.equal(blocked.entry.senderSock, `uds:${SENDER_SOCK}`);
    assert.equal(blocked.entry.senderPid, 4242);
    assert.equal(blocked.entry.fromCoordFull, `${SERVER}@24:3.7`);
    assert.equal(blocked.entry.toCoordFull, `${SERVER}@24:3.4`);
  } finally {
    restore();
  }
});

test('reply uses the sender session socket when the waiting inbox is gone', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const sent = [];
    let resolved = 0;
    let sessionLookups = 0;
    const { lines, result } = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'ok'], replyDeps({
      findReceipt: () => receipt({
        fromSock: 'uds:/tmp/cc-socks/1111.sock',
        senderSock: 'uds:/tmp/cc-socks/2222.sock',
        senderPid: 2222,
      }),
      canConnect: async (sock) => sock === '/tmp/cc-socks/2222.sock',
      targetFromSessionSock: () => { sessionLookups += 1; return TARGET_SESSION; },
      resolve: async () => { resolved += 1; throw new Error('resolve must not run'); },
      send: async (target, message) => {
        sent.push({ target, message });
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
    })));
    assert.equal(result, 0);
    assert.equal(resolved, 0, 'a live sender socket short-circuits address resolution');
    assert.equal(sessionLookups, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.address, 'uds:/tmp/cc-socks/2222.sock');
    assert.equal(sent[0].message.replyTo, MSG_ID);
    assert.match(lines.at(-1), /delivered/);
  } finally {
    restore();
  }
});

test('reply still prefers the waiting inbox while the ask process is listening', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const inboxCalls = [];
    let sessionLookups = 0;
    const { result } = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'ok'], replyDeps({
      findReceipt: () => receipt({
        fromSock: 'uds:/tmp/cc-socks/1111.sock',
        senderSock: 'uds:/tmp/cc-socks/2222.sock',
        senderPid: 2222,
      }),
      canConnect: async () => true,
      targetFromSessionSock: () => { sessionLookups += 1; return TARGET_SESSION; },
      sendToInbox: async ({ sockPath, message }) => {
        inboxCalls.push(sockPath);
        return { receipt: { status: 'queued', via: 'uds-inbox', msgId: message.msgId, elapsedMs: 1 } };
      },
      send: async () => { throw new Error('send must not run'); },
    })));
    assert.equal(result, 0);
    assert.equal(sessionLookups, 0);
    assert.deepEqual(inboxCalls, ['/tmp/cc-socks/1111.sock']);
  } finally {
    restore();
  }
});

test('reply falls back to the recorded coord when the address no longer resolves', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const calls = [];
    const sent = [];
    const { result } = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'ok'], replyDeps({
      findReceipt: () => receipt(),
      canConnect: async () => false,
      serverPath: SERVER,
      resolve: async (address) => {
        calls.push(address);
        if (address === 'b/claude:24:3.4') {
          throw new ResolveError('target_not_found', 'b/claude:24:3.4 belongs to account zz, not b');
        }
        return { ...TARGET_B, address, account: 'zz', claude: { sock: '/tmp/cc-socks/4444.sock' } };
      },
      send: async (target, message) => {
        sent.push(target);
        return { status: 'delivered', via: 'uds', msgId: message.msgId, elapsedMs: 1 };
      },
    })));
    assert.equal(result, 0);
    assert.deepEqual(calls, ['b/claude:24:3.4', '24:3.4']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].account, 'zz');
  } finally {
    restore();
  }
});

test('reply refuses the coord fallback when the receipt names another tmux server', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const calls = [];
    let sent = 0;
    const { result } = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'ok'], replyDeps({
      findReceipt: () => receipt(),
      canConnect: async () => false,
      serverPath: '/private/tmp/tmux-501/other',
      resolve: async (address) => {
        calls.push(address);
        throw new ResolveError('target_not_found', `${address} belongs to account zz, not b`);
      },
      send: async () => { sent += 1; return { status: 'delivered', via: 'uds', msgId: MSG_ID, elapsedMs: 1 }; },
    })));
    assert.equal(result, 4);
    assert.deepEqual(calls, ['b/claude:24:3.4'], 'the bare coord is never resolved across servers');
    assert.equal(sent, 0);
  } finally {
    restore();
  }
});

test('tell and ask pass --force through to the quota gate', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeBrain({ id: 'TST-0001', name: 'lead-a', role: 'main', parent: null, account: 'a' });
    writeBrain({ id: 'TST-0002', name: 'lead-b', role: 'main', parent: null, account: 'b' });
    const low = [{ account: 'b', window: 'weekly', remaining: 4 }];
    let sent = 0;
    const deps = replyDeps({
      sbbDir: join(home, '.sbb'),
      readQuota: async () => low,
      resolve: async () => TARGET_B,
      send: async (t, m) => { sent += 1; return { status: 'delivered', via: 'uds', msgId: m.msgId, elapsedMs: 1 }; },
    });

    const tellBlocked = await captureLog(() => tellRun(['lead-b', 'hi'], deps));
    assert.equal(tellBlocked.result, 4);
    assert.equal(sent, 0);
    const tellForced = await captureLog(() => tellRun(['lead-b', 'hi', '--force'], deps));
    assert.equal(tellForced.result, 0);
    assert.equal(sent, 1);

    const askBlocked = await captureLog(() => askRun(['lead-b', 'hi', '--wait', '1s'], deps));
    assert.equal(askBlocked.result, 4);
    assert.equal(sent, 1);
    const askForced = await captureLog(() => askRun(['lead-b', 'hi', '--wait', '1s', '--force'], deps));
    assert.equal(askForced.result, 5, 'forced through the gate, then times out waiting');
    assert.equal(sent, 2);
  } finally {
    restore();
  }
});

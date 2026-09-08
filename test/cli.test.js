import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as lsRun } from '../src/cli/ls.js';
import { run as adoptRun } from '../src/cli/adopt.js';
import { run as tellRun } from '../src/cli/tell.js';
import { run as askRun } from '../src/cli/ask.js';
import { run as replyRun } from '../src/cli/reply.js';
import { run as collectRun } from '../src/cli/collect.js';
import { run as quotaRun } from '../src/cli/quota.js';
import { run as catalogRun } from '../src/cli/catalog.js';
import { run as doctorRun } from '../src/cli/doctor.js';
import { createWatchState, formatEvent, readNewInboxEntries, readNewReceipts } from '../src/cli/watch.js';
import { getBrain } from '../src/registry/brains.js';
import { listInbox, writeInboxEntry } from '../src/registry/inbox.js';
import { receiptLogPath } from '../src/registry/receipts.js';
import { captureLog, tempDir, withEnv } from './fixtures/registry/helpers.js';

const MSG_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** @param {Record<string, any>} over */
function row(over = {}) {
  return {
    brain: null, brainId: null, role: null, parent: null, account: 'a', cli: 'claude', model: null,
    status: 'idle', name: 'lead', cwd: '/Users/dev/proj',
    paneId: '%30', coord: '24:3.4', pid: 1234, threadId: null, hasRollout: null,
    threadUncertain: false, sock: '/tmp/cc-socks/1234.sock', keyFile: '/tmp/1234.key',
    source: 'pane', claude: { pid: 1234, cwd: '/Users/dev/proj' }, codex: undefined,
    ...over,
    where: over.where ?? over.coord ?? '24:3.4',
  };
}

const ROWS = [
  row({ brain: 'lead', brainId: 'TST-0001', role: 'main' }),
  row({ brain: 'h3', brainId: 'TST-0002', role: 'sub', account: 'b', paneId: '%73', coord: '24:3.7', name: 'h3', pid: 4321 }),
];

const ACCOUNTS = [
  { name: 'a', baseDir: '/x/.ai-account-a', claudeDir: '/x/.ai-account-a/claude' },
  { name: 'b', baseDir: '/x/.ai-account-b', claudeDir: '/x/.ai-account-b/claude' },
];

/** @param {string} status @param {string} [reason] */
function receipt(status, reason) {
  return { status, via: 'uds', msgId: MSG_ID, elapsedMs: 12, reason };
}

function sbbEnv(home) {
  return { SBB_HOME_OVERRIDE: home, SBB_DIR: join(home, '.sbb'), TMUX_PANE: undefined };
}

test('sbb ls: json, filters and the human table', async () => {
  const deps = { roster: async () => ROWS };
  const json = await captureLog(() => lsRun(['--json'], deps));
  assert.equal(json.result, 0);
  const parsed = JSON.parse(json.lines.join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].brain, 'lead');

  const filtered = await captureLog(() => lsRun(['--json', '--account', 'b', '--cli', 'claude'], deps));
  assert.equal(JSON.parse(filtered.lines.join('\n')).length, 1);

  const human = await captureLog(() => lsRun([], deps));
  const table = human.lines.join('\n').split('\n');
  assert.match(table[0], /^ID\s+BRAIN\s+ROLE\s+PARENT\s+ACCOUNT\s+CLI/);
  assert.match(table[1], /^TST-0001\s+lead\s+main\s+-\s+a\s+claude/);
  assert.match(table[2], /^TST-0002\s+h3\s+sub\s+-\s+b\s+claude/);

  const empty = await captureLog(() => lsRun([], { roster: async () => [] }));
  assert.deepEqual(empty.lines, ['no live sessions']);
});

test('sbb ls --tree: brains only, indented by parent', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const tree = [
      row({ brain: 'lead', brainId: 'TST-0001', role: 'main', parent: null }),
      row({ brain: 'ios', brainId: 'TST-0002', role: 'sub', parent: 'TST-0001', paneId: '%31', coord: '24:3.5' }),
      row({ account: 'b', paneId: '%73', coord: '24:3.7', name: 'h3' }),
    ];
    const out = await captureLog(() => lsRun(['--tree'], { roster: async () => tree }));
    assert.deepEqual(out.lines, [
      'TST-0001  lead  main  a/claude  idle  24:3.4  lead',
      '  TST-0002  ios  sub  a/claude  idle  24:3.5  lead',
    ]);
  } finally {
    restore();
  }
});

test('sbb adopt: registers a live session and refuses bad input', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const deps = {
      roster: async () => ROWS,
      allocateId: (() => { let n = 0; return () => `TST-000${++n}`; })(),
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: { pid: 1234 }, codex: undefined }),
    };
    const ok = await captureLog(() => adoptRun(['%30', '--name', 'lead', '--model', 'claude-fable-5-1'], deps));
    assert.equal(ok.result, 0);
    assert.match(ok.lines[0], /^adopted TST-0001 lead\s+role=main/);
    const brain = getBrain('lead');
    assert.equal(brain.id, 'TST-0001');
    assert.equal(typeof brain.uuid, 'string');
    assert.ok(brain.uuid.length > 0, 'every record carries a uuid');
    assert.equal(brain.account, 'a');
    assert.equal(brain.cli, 'claude');
    assert.equal(brain.cwd, '/Users/dev/proj');
    assert.equal(brain.paneId, '%30');
    assert.equal(brain.pid, 1234);
    assert.equal(brain.origin, 'adopted');

    const dupe = await captureLog(() => adoptRun(['%30', '--name', 'lead'], deps));
    assert.equal(dupe.result, 4);

    const badName = await captureLog(() => adoptRun(['%30', '--name', 'Lead!'], deps));
    assert.equal(badName.result, 4);

    const badParent = await captureLog(() => adoptRun(['%30', '--name', 'ios', '--role', 'sub', '--parent', 'ghost'], deps));
    assert.equal(badParent.result, 4);

    const okSub = await captureLog(() => adoptRun(['%30', '--name', 'ios', '--role', 'sub', '--parent', 'lead'], deps));
    assert.equal(okSub.result, 0);
    assert.equal(getBrain('ios').parent, 'TST-0001', '--parent accepts a name and stores the id');
    const byId = await captureLog(() => adoptRun(['%30', '--name', 'ios2', '--role', 'sub', '--parent', 'TST-0001'], deps));
    assert.equal(byId.result, 0);
    assert.equal(getBrain('ios2').parent, 'TST-0001', '--parent accepts an id');
  } finally {
    restore();
  }
});

test('sbb tell --dry-run: resolves without sending and without a body', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let sent = 0;
    const deps = {
      rows: ROWS,
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async () => { sent += 1; return receipt('delivered'); },
    };
    const out = await captureLog(() => tellRun(['lead', '--dry-run'], deps));
    assert.equal(out.result, 0);
    assert.equal(sent, 0, 'dry-run must not send');
    assert.match(out.lines.join('\n'), /target {4}lead/);
    assert.match(out.lines.join('\n'), /transport send-keys/);
    assert.match(out.lines.join('\n'), /sender\s+\[user@cli\]\[用户\]/);
    assert.equal(existsSync(receiptLogPath()), false, 'dry-run logs nothing');

    const asBrain = await captureLog(() => tellRun(['lead', '--dry-run'], { ...deps, paneId: '%73' }));
    assert.match(
      asBrain.lines.join('\n'),
      /sender\s+\[h3#TST-0002@b\/claude:24:3\.7\]\[子脑\]/,
      'the dry-run sender line is the real envelope prefix, id included',
    );
  } finally {
    restore();
  }
});

test('sbb tell: builds the envelope, routes it and logs the receipt', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const deps = {
      rows: ROWS,
      paneId: '%73',
      msgId: MSG_ID,
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async (target, message) => { seen = { target, message }; return receipt('delivered'); },
    };
    const out = await captureLog(() => tellRun(['lead', 'check', 'the', 'PR', '--priority', 'now'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.message.text, `[h3#TST-0002@b/claude:24:3.7][子脑] check the PR   (sbb:${MSG_ID.slice(0, 8)})`);
    assert.equal(seen.message.priority, 'now');
    assert.equal(seen.message.msgId, MSG_ID);
    assert.match(out.lines.join('\n'), /delivered {2}msg=a1b2c3d4/);

    const logged = readFileSync(receiptLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].msgId, MSG_ID);
    assert.equal(logged[0].from, 'h3');
    assert.equal(logged[0].fromId, 'TST-0002');
    assert.equal(logged[0].to, 'lead');
    assert.equal(logged[0].toId, null, 'an address-only target has no brain id');
    assert.equal(logged[0].address, 'lead');
    assert.equal(logged[0].status, 'delivered');
    assert.equal(logged[0].via, 'uds');
  } finally {
    restore();
  }
});

test('sbb tell: outside tmux the sender is the user', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const deps = {
      rows: [],
      msgId: MSG_ID,
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async (target, message) => { seen = message; return receipt('queued'); },
    };
    const out = await captureLog(() => tellRun(['a/claude:lead', 'hello'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.text, `[user@cli][用户] hello   (sbb:${MSG_ID.slice(0, 8)})`);
    assert.equal(seen.fromBrain, 'user');
  } finally {
    restore();
  }
});

test('sbb tell: exit codes follow the receipt status', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const base = {
      rows: [],
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
    };
    const blocked = await captureLog(() => tellRun(['a/claude:lead', 'x'], { ...base, send: async () => receipt('blocked', 'pane_in_copy_mode') }));
    assert.equal(blocked.result, 4);
    const unverified = await captureLog(() => tellRun(['a/claude:lead', 'x'], { ...base, send: async () => receipt('unverified', 'enter_swallowed_twice') }));
    assert.equal(unverified.result, 3);
    const queued = await captureLog(() => tellRun(['a/claude:lead', 'x'], { ...base, send: async () => receipt('queued') }));
    assert.equal(queued.result, 0);
    const usage = await captureLog(() => tellRun(['a/claude:lead'], base));
    assert.equal(usage.result, 2, 'missing body is a usage error');
  } finally {
    restore();
  }
});

test('sbb tell --file: sends the path plus the first line', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const file = join(home, 'note.md');
    writeFileSync(file, '\n# Title\nbody line\n');
    let seen;
    const deps = {
      rows: [],
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async (target, message) => { seen = message; return receipt('queued'); },
    };
    const out = await captureLog(() => tellRun(['a/claude:lead', '--file', file], deps));
    assert.equal(out.result, 0);
    assert.match(seen.text, new RegExp(`见 ${file} # Title`));
  } finally {
    restore();
  }
});

test('sbb reply: routes back to the original sender with replyTo set', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const deps = {
      rows: [],
      findReceipt: () => ({ msgId: MSG_ID, from: 'lead', fromAddress: 'a/claude:24:3.4', address: 'lead' }),
      getBrain: () => ({ name: 'lead', role: 'main' }),
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async (target, message) => { seen = { target, message }; return receipt('delivered'); },
    };
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'done'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.target.address, 'lead');
    assert.equal(seen.message.replyTo, MSG_ID);
    assert.match(seen.message.text, /^\[user@cli\]\[用户\] done/);
  } finally {
    restore();
  }
});

test('sbb reply: a receipt from the user goes to the user inbox', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const deps = { rows: [], findReceipt: () => ({ msgId: MSG_ID, from: 'user' }) };
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'for the human'], deps));
    assert.equal(out.result, 0);
    const entries = listInbox('user');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entry.replyTo, MSG_ID);
    assert.equal(entries[0].entry.text, 'for the human');
  } finally {
    restore();
  }
});

test('sbb reply: an unknown message id is blocked, not guessed', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'x'], { rows: [], findReceipt: () => undefined }));
    assert.equal(out.result, 4);
  } finally {
    restore();
  }
});

test('sbb reply: a live fromSock reaches the waiting ask, not the sender session', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const deps = {
      rows: [],
      findReceipt: () => ({
        msgId: MSG_ID, from: 'lead', fromAddress: 'a/claude:24:3.4', fromSock: 'uds:/tmp/cc-socks/9625.sock',
      }),
      canConnect: async (sockPath) => { seen = { sockPath }; return true; },
      sendToInbox: async ({ sockPath, message }) => {
        seen = { sockPath, message };
        return { ok: true, receipt: { status: 'queued', via: 'uds-inbox', msgId: message.msgId, elapsedMs: 3 } };
      },
      resolve: async () => { throw new Error('the waiting inbox must win over the session address'); },
      send: async () => { throw new Error('must not send to the sender session'); },
    };
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), '好', '--role', '发起方'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.sockPath, '/tmp/cc-socks/9625.sock');
    assert.equal(seen.message.replyTo, MSG_ID, 'the waiting ask matches on reply_to');
    assert.match(seen.message.text, /^\[user@cli\]\[发起方\] 好/, '--role overrides the envelope role');
    assert.match(out.lines.join('\n'), /queued {5}msg=[0-9a-f]{8} {2}via=uds-inbox/);
    const logged = readFileSync(receiptLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logged.at(-1).via, 'uds-inbox');
    assert.equal(logged.at(-1).address, 'a/claude:24:3.4', 'the receipt still names the original sender');
    assert.equal(logged.at(-1).status, 'queued');
  } finally {
    restore();
  }
});

test('sbb reply: a dead fromSock falls back to the sender session address', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let seen;
    const deps = {
      rows: [],
      findReceipt: () => ({
        msgId: MSG_ID, from: 'lead', fromAddress: 'a/claude:24:3.4', fromSock: 'uds:/tmp/cc-socks/9625.sock',
      }),
      canConnect: async () => false,
      sendToInbox: async () => { throw new Error('must not write to a dead socket'); },
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async (target, message) => { seen = { target, message }; return receipt('delivered'); },
    };
    const out = await captureLog(() => replyRun([MSG_ID.slice(0, 8), 'done'], deps));
    assert.equal(out.result, 0);
    assert.equal(seen.target.address, 'a/claude:24:3.4');
    assert.equal(seen.message.replyTo, MSG_ID);
    assert.match(out.lines.join('\n'), /delivered {2}msg=a1b2c3d4 {2}via=uds/);
  } finally {
    restore();
  }
});

test('sbb tell: an unregistered CLI session speaks as 协作方', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const deps = {
      rows: [row()],
      paneId: '%30',
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
    };
    const out = await captureLog(() => tellRun(['lead', '--dry-run'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /sender\s+\[Claude@a\/claude:24:3\.4\]\[协作方\]/);
  } finally {
    restore();
  }
});

test('sbb ask --role: the envelope carries the caller role', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const deps = {
      rows: [],
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async () => receipt('delivered'),
      msgId: MSG_ID,
    };
    const out = await captureLog(() => askRun(['a/claude:lead', 'ping', '--wait', '1s', '--role', '协调方'], deps));
    assert.equal(out.result, 5, 'no reply arrives, so the wait times out');
    assert.match(out.lines.join('\n'), /envelope {2}\[user@cli\]\[协调方\] ping/);
  } finally {
    restore();
  }
});

test('sbb collect: prints unread entries and marks them read', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeInboxEntry({ owner: 'lead', entry: { msgId: MSG_ID, from: 'h3', replyTo: 'ffeeddccbbaa99887766554433221100', text: 'first', t: 1000 } });
    const first = await captureLog(() => collectRun(['--for', 'lead'], { rows: [] }));
    assert.equal(first.result, 0);
    assert.match(first.lines[0], /^msg=a1b2c3d4 {2}from=h3/);
    assert.equal(listInbox('lead', { unreadOnly: true }).length, 0, 'marked read');

    const second = await captureLog(() => collectRun(['--for', 'lead'], { rows: [] }));
    assert.deepEqual(second.lines, ['no unread messages for lead']);

    const all = await captureLog(() => collectRun(['--for', 'lead', '--all'], { rows: [] }));
    assert.match(all.lines[0], /^msg=a1b2c3d4/);
  } finally {
    restore();
  }
});

test('sbb ask: returns the reply when it arrives', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    writeInboxEntry({ owner: 'user', entry: { msgId: 'bb'.repeat(16), from: 'lead', replyTo: MSG_ID, text: 'PONG', t: 2000 } });
    const deps = {
      rows: [],
      msgId: MSG_ID,
      startInbox: async () => undefined,
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async () => receipt('queued'),
    };
    const out = await captureLog(() => askRun(['a/claude:lead', 'ping'], deps));
    assert.equal(out.result, 0);
    assert.match(out.lines.join('\n'), /reply {5}msg=bbbbbbbb from=lead/);
    assert.match(out.lines.join('\n'), /PONG/);
  } finally {
    restore();
  }
});

test('sbb ask: exit 5 on timeout', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    let clock = 0;
    const deps = {
      rows: [],
      msgId: MSG_ID,
      startInbox: async () => undefined,
      sleep: async () => {},
      now: () => (clock += 1000),
      resolve: async (address) => ({ address, account: 'a', cli: 'claude', paneId: '%30', coord: '24:3.4', claude: {}, codex: undefined }),
      send: async () => receipt('queued'),
    };
    const out = await captureLog(() => askRun(['a/claude:lead', 'ping', '--wait', '1s'], deps));
    assert.equal(out.result, 5);
    assert.equal(out.lines.at(-1), 'timeout');
  } finally {
    restore();
  }
});

test('sbb quota and catalog: json output from the injected readers', async () => {
  const quota = await captureLog(() => quotaRun(['--json'], {
    readQuota: async () => [{ account: 'a', provider: 'claude', window: 'session', remaining: 89, resetsAt: 1, capturedAt: 2, note: null }],
  }));
  assert.equal(quota.result, 0);
  assert.equal(JSON.parse(quota.lines.join('\n'))[0].remaining, 89);

  const human = await captureLog(() => quotaRun([], {
    readQuota: async () => [{ account: 'a', provider: 'claude', window: 'session', remaining: null, resetsAt: null, capturedAt: null, note: 'unknown' }],
  }));
  assert.match(human.lines.join('\n'), /unknown/);

  const cat = await captureLog(() => catalogRun([], {
    catalog: () => [{ account: 'a', cli: 'claude', models: [{ id: 'claude-fable-5-1', source: 'static' }], source: 'static' }],
  }));
  assert.equal(cat.result, 0);
  assert.match(cat.lines.join('\n'), /claude-fable-5-1/);
});

test('sbb doctor: exits 0 when tmux is reachable, 1 when it is not', async () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const deps = {
      tmux: async (args) => (args[0] === '-V' ? 'tmux 3.7c' : '/private/tmp/tmux-501/default'),
      listClaudeSessions: () => [{ pid: 1234, account: 'a', name: 'lead', sock: '/tmp/cc-socks/1234.sock', status: 'busy' }],
      checkSocket: async () => 'ok',
      which: () => '/opt/homebrew/bin/codex',
      exec: async () => ({ code: 0, stdout: 'codex-cli 0.154.0\n', stderr: '', timedOut: false }),
      accounts: ACCOUNTS,
      dbPath: join(home, 'usage.sqlite'),
      env: {},
    };
    const ok = await captureLog(() => doctorRun([], deps));
    assert.equal(ok.result, 0);
    assert.match(ok.lines.join('\n'), /tmux {8}ok {2}socket=\/private\/tmp\/tmux-501\/default/);
    assert.match(ok.lines.join('\n'), /brains\s+live=0 retired=0/);
    assert.match(ok.lines.join('\n'), /connect=ok/);
    assert.match(ok.lines.join('\n'), /codex-cli 0\.154\.0/);

    const down = await captureLog(() => doctorRun([], { ...deps, tmux: async () => { throw new Error('no server running'); } }));
    assert.equal(down.result, 1);
    assert.match(down.lines.join('\n'), /UNREACHABLE/);
  } finally {
    restore();
  }
});

test('sbb watch helpers: new receipts, new inbox files and one-line events', () => {
  const home = tempDir();
  const restore = withEnv(sbbEnv(home));
  try {
    const state = createWatchState();
    assert.deepEqual(readNewReceipts(state), [], 'missing log is not an error');

    mkdirSync(join(home, '.sbb', 'log'), { recursive: true });
    writeFileSync(receiptLogPath(), `${JSON.stringify({ msgId: MSG_ID, status: 'delivered', from: 'lead', to: 'h3', via: 'uds' })}\n`);
    const first = readNewReceipts(state);
    assert.equal(first.length, 1);
    assert.match(formatEvent(first[0]), /^receipt {2}delivered {2}msg=a1b2c3d4 {2}from=lead/);
    assert.deepEqual(readNewReceipts(state), [], 'the offset advances');

    writeInboxEntry({ owner: 'lead', entry: { msgId: MSG_ID, from: 'h3', replyTo: 'ffeeddccbbaa99887766554433221100', text: 'hi', t: 5 } });
    const inbox = readNewInboxEntries(state);
    assert.equal(inbox.length, 1);
    assert.match(formatEvent(inbox[0]), /^inbox {4}lead {2}msg=a1b2c3d4 {2}from=h3 {2}replyTo=ffeeddcc/);
    assert.deepEqual(readNewInboxEntries(state), [], 'seen files are not repeated');
  } finally {
    restore();
  }
});

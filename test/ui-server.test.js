// The UI server: token auth, /api routes, SSE events and the pane WebSocket. The host and
// the tmux control client are fakes, so nothing here touches a real tmux server or opens a
// window. SBB_DIR points at a temp directory, so the real registry is never read or written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import { createControlFactory } from './fixtures/ui/fake-control.js';
import { readConfig as readSbbConfig } from '../src/policy/config.js';

const TMP = mkdtempSync(join(tmpdir(), 'sbb-h1-ui-'));
const SBB = join(TMP, 'sbb');
mkdirSync(SBB, { recursive: true });
// data.js `watch()` only watches paths that exist when it starts (a path created later is
// covered by its 30 s re-snapshot), so the log dir a running sbb has already made is created
// here. See the report: a `log/` born after `sbb ui` starts is only picked up on re-snapshot.
mkdirSync(join(SBB, 'log'), { recursive: true });
process.env.SBB_DIR = SBB;
const {
  ERROR_STATUS,
  createUiServer,
  newToken,
  presentedToken,
  readToken,
  tokenMatches,
  writeToken,
  extractJson,
} = await import('../src/ui/server.js');
const { writeBrain } = await import('./fixtures/registry/helpers.js');

const TOKEN = '0123456789abcdef0123456789abcdef';
const brainA = writeBrain({ name: 'h1-one', cli: 'claude', account: 'a', paneId: '%1', coord: 'work:0.0', cwd: '/tmp/h1', origin: 'adopted' });
const brainB = writeBrain({ name: 'h1-two', cli: 'codex', account: 'b', paneId: '%2', coord: 'work:0.1', cwd: '/tmp/h1', origin: 'adopted' });

/** @param {{ panes?: any[], clients?: any[], screen?: string }} [opts] */
function makeHost(opts = {}) {
  const api = createFakeTmux({
    paneId: '%1',
    panes: opts.panes ?? [
      { paneId: '%1', session: 'work', windowId: '@1', coord: 'work:0.0', command: 'zsh' },
      { paneId: '%2', session: 'work', windowId: '@1', coord: 'work:0.1', command: 'zsh' },
    ],
  });
  api.capturePaneEscaped = async (paneId, lines) => {
    api.calls.push(['capturePaneEscaped', paneId, lines]);
    return opts.screen ?? 'SCREEN';
  };
  api.resizePane = async (paneId, size) => {
    api.calls.push(['resize-pane', paneId, size.cols, size.rows]);
  };
  api.switchClient = async (tty, session) => {
    api.calls.push(['switch-client', tty, session]);
  };
  api.listClients = async () => opts.clients ?? [];
  api.setClients = (next) => {
    api.listClients = async () => next;
  };
  return api;
}

const host = makeHost();
const control = createControlFactory();
const osascript = {
  calls: [],
  run: async (file, args) => {
    osascript.calls.push({ file, args });
    return { code: 0, stdout: '', stderr: '' };
  },
};
/** @type {any[]} */
const channelCalls = [];
const fakeInbox = { sockPath: join(TMP, 'socks', '1.sock'), on: () => {}, off: () => {}, close: async () => {} };
const deps = {
  sbbDir: SBB,
  inboxDir: join(TMP, 'socks'),
  controlFactory: control,
  roster: async () => [
    { brainId: brainA.id, status: 'busy', where: 'work:0.0', paneId: '%1', name: 's1', threadId: 'th-1' },
  ],
  catalog: () => [{ account: 'a', cli: 'claude', models: [{ id: 'claude-opus-5', label: 'Opus 5' }] }],
  accountList: () => [{ name: 'a', clis: ['claude', 'codex'], label: 'a' }],
  readQuota: async () => [{ account: 'a', window: 'session', usedPercent: 11 }],
  readConfig: () => ({ policy: { peers: 'all' }, terminal: 'ghostty' }),
  listHeld: () => [{ msgId: 'm-held' }],
  listPlans: () => [{ planId: 'p-1' }],
  listAllClaims: () => [{ brainId: brainA.id, resource: 'branch:h1' }],
  resolve: async (ref) => ({ brain: ref, address: `a/claude:${ref}`, cli: 'claude', account: 'a' }),
  isChannelAddress: (to) => to.startsWith('#'),
  resolveChannel: (address) => ({
    id: 'team:SSL-0001', name: address.slice(1), main: { id: 'SSL-0001' },
    members: [{ id: 'SSL-0002', name: 'ios', role: 'sub' }, { id: 'SSL-0003', name: 'review', role: 'sub' }],
  }),
  sendToChannel: async (input) => {
    channelCalls.push(input);
    return {
      msgId: 'abc123', text: '[you][user -> #lead] hello team', logFile: '/tmp/team.log',
      entry: { receipts: input.channel.members.map((m) => ({ member: m.id, status: 'delivered', via: 'uds' })) },
      results: input.channel.members.map((m) => ({ member: m, receipt: { status: 'delivered', via: 'uds' } })),
    };
  },
  startInbox: async () => fakeInbox,
  switch: {
    listClients: async () => [],
    ps: async () => ({ stdout: '' }),
    platform: 'darwin',
    installed: () => true,
    run: osascript.run,
    readFile: () => {
      throw new Error('no config');
    },
    tmuxArgs: ['-L', 'sbb-h1-test'],
  },
};

/** @type {Awaited<ReturnType<typeof createUiServer>>} */
let server;
/** @type {{ port: number, token: string, url: string }} */
let info;

before(async () => {
  server = await createUiServer({ port: 0, token: TOKEN, host, deps });
  info = await server.start({ port: 0 });
});

after(async () => {
  await server?.stop();
  rmSync(TMP, { recursive: true, force: true });
});

/** @param {string} path @param {RequestInit} [init] @param {string} [token] */
function request(path, init = {}, token = TOKEN) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`http://127.0.0.1:${info.port}${path}${sep}t=${token}`, init);
}

/** @param {string} path */
async function getJson(path) {
  const res = await request(path);
  return { res, body: await res.json() };
}

/** @param {() => boolean} fn @param {number} [timeoutMs] */
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fn();
}

test('every request needs the token, by query, header or cookie', async () => {
  const base = `http://127.0.0.1:${info.port}`;
  const bare = await fetch(`${base}/api/state`);
  assert.equal(bare.status, 401);
  assert.equal(await bare.text(), '');
  assert.equal((await fetch(`${base}/api/state?t=${'0'.repeat(32)}`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-sbb-token': TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `sbb_ui=${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${base}/ws/pane/%1`)).status, 401);
});

test('token helpers', () => {
  assert.match(newToken(), /^[0-9a-f]{32}$/);
  assert.equal(tokenMatches('a'.repeat(32), 'a'.repeat(32)), true);
  assert.equal(tokenMatches('a'.repeat(32), 'a'.repeat(31)), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(presentedToken({ headers: { 'x-sbb-token': 'header', cookie: 'sbb_ui=cookie' } }, new URL('http://x/api/state?t=query')), 'query');
  assert.equal(presentedToken({ headers: {} }, new URL('http://x/api/state')), undefined);
  assert.equal(presentedToken({ headers: { cookie: 'a=1; sbb_ui=abc' } }, new URL('http://x/api/state')), 'abc');
  const path = writeToken('deadbeef'.repeat(4), { dir: SBB });
  assert.equal(readToken({ dir: SBB }), 'deadbeef'.repeat(4));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(ERROR_STATUS.invalid_input, 400);
  assert.equal(ERROR_STATUS.not_found, 404);
});

test('/api/state serves the injected snapshot and enriches brains from the roster', async () => {
  const { res, body } = await getJson('/api/state');
  assert.equal(res.status, 200);
  assert.deepEqual(body.policy, { policy: { peers: 'all' }, terminal: 'ghostty' });
  assert.deepEqual(body.quota, [{ account: 'a', window: 'session', usedPercent: 11 }]);
  assert.deepEqual(body.held, [{ msgId: 'm-held' }]);
  assert.deepEqual(body.plans, [{ planId: 'p-1' }]);
  assert.deepEqual(body.claims, [{ brainId: brainA.id, resource: 'branch:h1' }]);
  assert.deepEqual(body.accounts, [{ name: 'a', clis: ['claude', 'codex'], label: 'a' }], 'data.js accountList');
  assert.deepEqual(body.catalog, [{ account: 'a', cli: 'claude', model: 'claude-opus-5', label: 'Opus 5' }]);
  assert.deepEqual(body.receipts, [], 'no receipt log yet');
  assert.ok(Array.isArray(body.tps.list), 'TpsBar reads { list, total }');
  assert.equal(typeof body.tps.total, 'number');
  assert.ok(Array.isArray(body.teams));
  for (const team of body.teams) assert.ok(Array.isArray(team.messages), 'ConversationStream pushes into team.messages');
  assert.equal(typeof body.version, 'string');
  const one = body.brains.find((b) => b.id === brainA.id);
  assert.equal(one.status, 'busy');
  assert.equal(one.where, 'work:0.0');
  assert.equal(one.live, true);
  assert.equal(one.sessionName, 's1');
  assert.equal(one.threadId, 'th-1');
  const two = body.brains.find((b) => b.id === brainB.id);
  assert.equal(two.status, '?', 'no roster row: the console shows unknown, not a guess');
  assert.equal(two.live, false);
  assert.equal(body.tree.id, 'user');
  assert.equal(body.tree.kind, 'user');
  assert.deepEqual(
    body.tree.children.find((t) => t.id === brainA.id),
    { id: brainA.id, name: 'h1-one', kind: 'brain', children: [] },
    'OrgChart.vue walks nested children',
  );
});

test('/api/state carries the newest 500 receipts, newest first', async () => {
  const { appendReceipt, readReceiptEntries } = await import('../src/registry/receipts.js');
  for (let i = 0; i < 501; i += 1) {
    appendReceipt({ msgId: `m${String(i).padStart(4, '0')}`, status: 'delivered', via: 'uds' });
  }
  const { body } = await getJson('/api/state');
  assert.equal(body.receipts.length, 500);
  assert.equal(body.receipts[0].msgId, 'm0500', 'newest first');
  assert.equal(body.receipts.at(-1).msgId, 'm0001', 'the oldest kept entry');
  assert.equal(readReceiptEntries().length, 501, 'the log itself is not truncated');
});

test('/api/state still answers when tmux cannot be listed', async () => {
  const other = await createUiServer({
    port: 0,
    token: TOKEN,
    host,
    deps: { ...deps, roster: async () => { throw new Error('tmux down'); } },
  });
  const otherInfo = await other.start({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${otherInfo.port}/api/state?t=${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.brains.find((b) => b.id === brainA.id).status, '?');
  } finally {
    await other.stop();
  }
});

test('/api/events streams named events with the raw object as payload', async () => {
  const res = await request('/api/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /: sbb ui events/);
  server.emitEvent('receipt', { msgId: 'm-probe', status: 'delivered' });
  const next = decoder.decode((await reader.read()).value);
  assert.equal(next, 'event: receipt\ndata: {"msgId":"m-probe","status":"delivered"}\n\n');
  await reader.cancel();
});

test('/api/events follows the state files through src/ui/data.js watch', async () => {
  const { appendReceipt } = await import('../src/registry/receipts.js');
  const res = await request('/api/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // the opening comment frame
  let seen = '';
  const pump = () => {
    reader.read().then((chunk) => {
      seen += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      if (!chunk.done) pump();
    });
  };
  pump();
  appendReceipt({ msgId: 'm-live', status: 'delivered', via: 'uds' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !seen.includes('m-live')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(seen, /event: receipt\ndata: \{[^}]*"msgId":"m-live"/, `saw ${JSON.stringify(seen.slice(0, 400))}`);
  await reader.cancel();
});

test('/api/events sends a named heartbeat frame', async () => {
  const other = await createUiServer({ port: 0, token: TOKEN, host, deps: { ...deps, heartbeatMs: 20 } });
  const otherInfo = await other.start({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${otherInfo.port}/api/events?t=${TOKEN}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.includes('event: heartbeat')) {
      const chunk = await reader.read();
      seen += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      if (chunk.done) break;
    }
    assert.match(seen, /event: heartbeat\ndata: \{"t":\d+\}/);
    await reader.cancel();
  } finally {
    await other.stop();
  }
});

test('/api read routes answer for unknown and known brains', async () => {
  const missing = await request('/api/brains/zzzz9999/transcript');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { reason: 'target_not_found', detail: 'unknown brain "zzzz9999"' } });
  const known = await request(`/api/brains/${brainA.id}/transcript?limit=5`);
  assert.equal(known.status, 200);
  assert.equal(typeof await known.json(), 'object');
  assert.equal((await request('/api/messages?limit=5')).status, 200);
  assert.equal((await request('/api/teams/nope')).status, 200);
});

test('POST routes validate their body and reject unknown paths', async () => {
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const channelRes = await post('/api/tell', { to: '#lead', text: 'hello team' });
  assert.equal(channelRes.status, 200);
  const channelTell = await channelRes.json();
  assert.equal(channelTell.via, 'channel');
  assert.equal(channelTell.status, 'delivered');
  assert.equal(channelTell.name, '#lead');
  assert.deepEqual(channelTell.receipts.map((r) => r.member), ['SSL-0002', 'SSL-0003']);
  assert.equal(channelCalls.length, 1);
  assert.equal(channelCalls[0].identity.id ?? channelCalls[0].identity.brain ?? 'user', 'user');

  const tell = await post('/api/tell', { to: 'x' });
  assert.equal(tell.status, 400);
  assert.equal((await tell.json()).error.reason, 'invalid_input');
  assert.equal((await post('/api/approve', {})).status, 400);
  assert.equal((await post('/api/nope', {})).status, 404);
  const badJson = await request('/api/tell', { method: 'POST', body: '{oops' });
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error.detail, /cannot read request body/);
});

test('/api/switch opens a terminal and touches no client when none exists', async () => {
  const res = await request('/api/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain: brainA.id }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.switched, false);
  assert.equal(body.opened, 'ghostty');
  assert.equal(body.command, 'tmux -L sbb-h1-test attach -t work');
  assert.equal(host.calls.filter((c) => c[0] === 'select-pane').length, 0);
  assert.equal(host.calls.filter((c) => c[0] === 'switch-client').length, 0);
  assert.equal(osascript.calls.length, 1);
  assert.equal(osascript.calls[0].file, 'osascript');
  const unknown = await request('/api/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain: 'zzzz9999' }),
  });
  assert.equal(unknown.status, 404);
});

test('static files come from web/dist, and a missing build explains itself', async () => {
  const dist = join(TMP, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>h1-console</title>');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  const withDist = await createUiServer({ port: 0, token: TOKEN, host, deps, dist });
  const distInfo = await withDist.start({ port: 0 });
  try {
    // A browser loads <script src="/assets/app.js"> before the page's own code can set a
    // cookie, so the first page load must hand the token back as the cookie.
    const first = await fetch(`http://127.0.0.1:${distInfo.port}/?t=${TOKEN}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('set-cookie'), `sbb_ui=${TOKEN}; Path=/; SameSite=Strict`);
    const asset = await fetch(`http://127.0.0.1:${distInfo.port}/assets/app.js`, { headers: { cookie: `sbb_ui=${TOKEN}` } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('set-cookie'), null, 'no cookie is set when the token did not come by query');
    assert.equal((await fetch(`http://127.0.0.1:${distInfo.port}/assets/app.js`)).status, 401);

    const res = await fetch(`http://127.0.0.1:${distInfo.port}/?t=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /h1-console/);
    assert.equal((await fetch(`http://127.0.0.1:${distInfo.port}/api/state?t=${TOKEN}`)).status, 200);
  } finally {
    await withDist.stop();
  }
  const noDist = await createUiServer({ port: 0, token: TOKEN, host, deps, dist: join(TMP, 'nope') });
  const noInfo = await noDist.start({ port: 0 });
  try {
    const hint = await fetch(`http://127.0.0.1:${noInfo.port}/?t=${TOKEN}`);
    assert.equal(hint.status, 200);
    assert.match(await hint.text(), /web\/dist is not built/);
  } finally {
    await noDist.stop();
  }
});

/** @param {string} pane @param {string} [token] */
function openPane(pane, token = TOKEN) {
  // browsers URL-encode the pane id ('%1' travels as '%251'); the server decodes that escape
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws/pane/${encodeURIComponent(pane)}?t=${token}`);
  /** @type {{ data: any, isBinary: boolean }[]} */
  const messages = [];
  ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

test('the pane WebSocket sends the initial screen and refuses input until asked', async () => {
  const { ws, messages } = await openPane('%1');
  try {
    assert.ok(await waitFor(() => messages.length >= 1), 'initial screen arrived');
    assert.equal(messages[0].isBinary, true);
    assert.equal(messages[0].data.toString('utf8'), 'SCREEN\r\n');
    const client = control.clients.at(-1);
    assert.deepEqual(client.lines, ['refresh-client -A "%1:on"']);

    ws.send(JSON.stringify({ type: 'input', data: 'echo hi' }));
    assert.ok(await waitFor(() => messages.length >= 2), 'refusal arrived');
    assert.deepEqual(JSON.parse(messages[1].data.toString('utf8')), { type: 'refused', reason: 'input_off' });
    assert.equal(host.calls.filter((c) => c[0] === 'send-literal').length, 0);

    ws.send(JSON.stringify({ type: 'mode', input: true }));
    ws.send(JSON.stringify({ type: 'input', data: 'echo hi' }));
    assert.ok(await waitFor(() => host.calls.some((c) => c[0] === 'send-literal')));
    assert.deepEqual(host.calls.filter((c) => c[0] === 'send-literal').at(-1), ['send-literal', '%1', 'echo hi']);

    ws.send(JSON.stringify({ type: 'key', name: 'Enter' }));
    assert.ok(await waitFor(() => host.calls.some((c) => c[0] === 'send-key')));
    assert.deepEqual(host.calls.filter((c) => c[0] === 'send-key').at(-1), ['send-key', '%1', 'Enter']);

    // A real human client (tty, not control mode, same session) blocks resize.
    host.setClients([{ tty: '/dev/ttys003', session: 'work' }]);
    const before = messages.length;
    ws.send(JSON.stringify({ type: 'key', name: '-l' }));
    ws.send(JSON.stringify({ type: 'input' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    ws.send('not json');
    assert.ok(await waitFor(() => messages.length >= before + 4), 'four refusals arrived');
    const refusals = messages.slice(before).map((m) => JSON.parse(m.data.toString('utf8')));
    // Frames are handled concurrently, so the four replies may interleave; the set is what matters.
    assert.deepEqual(refusals.map((r) => r.reason).sort(), ['client_attached', 'invalid_input', 'invalid_input', 'invalid_key']);
    assert.equal(host.calls.filter((c) => c[0] === 'resize-pane').length, 0, 'a human client is attached');

    host.setClients([{ tty: '', session: 'work', controlMode: true }]);
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    assert.ok(await waitFor(() => host.calls.some((c) => c[0] === 'resize-pane')));
    assert.deepEqual(host.calls.filter((c) => c[0] === 'resize-pane').at(-1), ['resize-pane', '%1', 100, 30]);

    // tmux escapes CR LF as octal; the parser strips the line terminator first.
    client.feed('%output %1 live-output\\015\\012\n');
    assert.ok(await waitFor(() => messages.some((m) => m.isBinary && m.data.toString('utf8') === 'live-output\r\n')));
  } finally {
    ws.close();
  }
});

test('the pane WebSocket refuses a bad token, a bad pane id and a gone pane', async () => {
  await assert.rejects(() => openPane('%1', '0'.repeat(32)));
  await assert.rejects(() => openPane('abc'));
  const { ws, messages } = await openPane('%99');
  try {
    assert.ok(await waitFor(() => messages.length >= 1));
    assert.deepEqual(JSON.parse(messages[0].data.toString('utf8')), { type: 'closed', reason: 'pane_gone' });
  } finally {
    ws.close();
  }
});

test('extractJson: a human line before the JSON document does not hide it', () => {
  assert.deepEqual(extractJson(['kill      SSL-0058  lead  main  a/claude  24:8.1', '{', '  "results": [],', '  "reparented": []', '}']), { results: [], reparented: [] });
  assert.deepEqual(extractJson(['{"a":1}']), { a: 1 });
  assert.deepEqual(extractJson(['[1,2]']), [1, 2]);
  assert.equal(extractJson(['no json here']), undefined);
  assert.equal(extractJson([]), undefined);
  assert.equal(extractJson(['note', '{oops']), undefined);
});

test('/api/policy accepts the settings-page keys and returns the new config', async () => {
  const post = (body) => request('/api/policy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [body, check] of [
    [{ spawnShell: '/bin/zsh' }, (c) => assert.equal(c.spawn.shell, '/bin/zsh')],
    [{ spawnPreamble: { cli: 'claude', value: 'source /x/proxy.sh on' } }, (c) => assert.equal(c.spawn.preamble.claude, 'source /x/proxy.sh on')],
    [{ spawnCommand: { cli: 'codex', value: '/x/bin/codex-launch' } }, (c) => assert.equal(c.spawn.command.codex, '/x/bin/codex-launch')],
    [{ terminal: 'iterm2' }, (c) => assert.equal(c.terminal, 'iterm2')],
    [{ terminal: null }, (c) => assert.equal('terminal' in c, false)],
    [{ subsDirect: false }, (c) => assert.equal(c.teams.subsDirect, false)],
    [{ spawnShell: '' }, (c) => assert.equal('shell' in c.spawn, false)],
  ]) {
    const res = await post(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    await res.json();
    // the route answers with the injected readConfig stub; the effect is on disk
    check(readSbbConfig({ sbbDir: SBB }));
  }
  const bad = await post({ nothing: true });
  assert.equal(bad.status, 400);
});

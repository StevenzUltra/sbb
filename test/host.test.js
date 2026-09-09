// Host interface: src/host/tmux.js is the only module that talks to tmux, and the old
// src/lib/tmux.js is now a pure re-export of it. Everything below runs against a scratch
// tmux server (`-L sbb-h1-host-<pid>`), never the user's server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as host from '../src/host/tmux.js';
import * as hostIndex from '../src/host/index.js';
import * as lib from '../src/lib/tmux.js';

const SOCKET = `sbb-h1-host-${process.pid}`;
const PREV = process.env.SBB_TMUX_ARGS;
process.env.SBB_TMUX_ARGS = `-L ${SOCKET}`;
after(() => {
  if (PREV === undefined) delete process.env.SBB_TMUX_ARGS;
  else process.env.SBB_TMUX_ARGS = PREV;
  spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
/** @param {string[]} args */
const run = (args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });

// A detached session cannot grow past its window size, so start large and resize down.
if (hasTmux) run(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'work']);

test('baseArgs reads SBB_TMUX_ARGS and defaults to no extra flags', () => {
  assert.deepEqual(host.baseArgs({}), []);
  assert.deepEqual(host.baseArgs({ SBB_TMUX_ARGS: '-L sbb-h1 -f /tmp/x' }), ['-L', 'sbb-h1', '-f', '/tmp/x']);
});

test('src/lib/tmux.js re-exports the host module, same function objects', () => {
  const hostKeys = Object.keys(host).sort();
  assert.ok(hostKeys.length >= 20);
  assert.deepEqual(Object.keys(lib).sort(), hostKeys);
  for (const key of hostKeys) assert.equal(lib[key], host[key], key);
});

test('the active host is tmux', () => {
  assert.equal(hostIndex.kind, 'tmux');
  assert.equal(hostIndex.host, host);
  assert.equal(hostIndex.activeHost(), host);
});

test('controlClient attaches in control mode with the base args and writes whole lines', () => {
  /** @type {any[]} */
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  /** @type {string[]} */
  const written = [];
  child.stdin.on('data', (chunk) => written.push(String(chunk)));
  child.kill = (signal) => {
    calls.push(['kill', signal]);
    return true;
  };
  const client = host.controlClient({
    session: 'work',
    env: { SBB_TMUX_ARGS: '-L other' },
    spawn: (file, args, opts) => {
      calls.push([file, args, opts.stdio.join(',')]);
      return child;
    },
  });
  assert.equal(calls[0][0], 'tmux');
  assert.deepEqual(calls[0][1], ['-L', 'other', '-C', 'attach-session', '-t', 'work']);
  assert.equal(calls[0][2], 'pipe,pipe,pipe');
  assert.equal(client.pid, 4242);
  assert.equal(client.session, 'work');
  client.write('refresh-client -A "%1:on"\n');
  client.write('\n');
  assert.deepEqual(written, ['refresh-client -A "%1:on"\n']);
  client.kill('SIGKILL');
  assert.deepEqual(calls.at(-1), ['kill', 'SIGKILL']);
  assert.throws(() => host.controlClient({ session: '' }), /session is required/);
});

test('controlClient.close resolves once the child is gone', async () => {
  const child = new EventEmitter();
  child.pid = 1;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    setImmediate(() => child.emit('close', 0, 'SIGTERM'));
    return true;
  };
  const client = host.controlClient({ session: 'work', env: {}, spawn: () => child });
  await client.close();
  assert.ok(true, 'close resolved');
});

test('sendLiteral refuses multi-line text instead of typing it', async () => {
  await assert.rejects(() => host.sendLiteral('%1', 'a\nb'), /single line/);
  await assert.rejects(() => host.sendLiteral('%1', 'a\rb'), /single line/);
});

test('selfPane is undefined outside tmux', async () => {
  const prev = process.env.TMUX_PANE;
  delete process.env.TMUX_PANE;
  try {
    assert.equal(await host.selfPane(), undefined);
  } finally {
    if (prev !== undefined) process.env.TMUX_PANE = prev;
  }
});

test('real tmux: list panes, capture, type, key, resize, split, kill', { skip: !hasTmux }, async () => {
  const panes = await host.listPanes();
  assert.equal(panes.length, 1);
  const pane = panes[0];
  assert.match(pane.paneId, /^%\d+$/);
  assert.equal(pane.session, 'work');
  // The scratch server loads the user's tmux.conf, which may set base-index 1.
  assert.match(pane.coord, /^work:\d+\.\d+$/);
  assert.equal(await host.resolvePaneId(pane.paneId), pane.paneId);
  assert.equal(await host.resolvePaneId(pane.coord), pane.paneId);

  await host.sendLiteral(pane.paneId, 'echo H1_HOST_CHECK');
  await host.sendKey(pane.paneId, 'Enter');
  let screen = '';
  for (let i = 0; i < 40 && !screen.includes('H1_HOST_CHECK'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    screen = await host.capturePane(pane.paneId, 40);
  }
  assert.match(screen, /H1_HOST_CHECK/);

  await host.resizePane(pane.paneId, { cols: 100, rows: 30 });
  // The window takes the requested size; the pane keeps one row for the status line.
  assert.equal(await host.tmux(['display-message', '-p', '-t', pane.paneId, '#{window_width}x#{window_height}']), '100x30');
  assert.equal(await host.tmux(['display-message', '-p', '-t', pane.paneId, '#{pane_width}x#{pane_height}']), '100x29');

  assert.equal(await host.paneInMode(pane.paneId), false);
  await host.tmux(['copy-mode', '-t', pane.paneId]);
  assert.equal(await host.paneInMode(pane.paneId), true);
  await host.tmux(['send-keys', '-t', pane.paneId, 'q']);

  assert.equal(await host.paneOption(pane.paneId, 'sbb_brain'), null);
  await host.tmux(['set-option', '-p', '-t', pane.paneId, '@sbb_brain', 'h1-test']);
  assert.equal(await host.paneOption(pane.paneId, 'sbb_brain'), 'h1-test');

  const split = await host.splitWindow({});
  assert.match(split, /^%\d+$/);
  assert.equal((await host.listPanes()).length, 2);
  await host.killPane(split);
  assert.equal((await host.listPanes()).length, 1);

  const win = await host.newWindow({ name: 'h1-win' });
  assert.match(win, /^%\d+$/);
  assert.ok((await host.listPanes()).some((p) => p.paneId === win));
  await host.killPane(win);
});

test('real tmux: capturePaneEscaped keeps colour that capturePane strips', { skip: !hasTmux }, async () => {
  const pane = (await host.listPanes())[0].paneId;
  await host.sendLiteral(pane, "printf '\\033[31mRED\\033[0m\\n'");
  await host.sendKey(pane, 'Enter');
  let escaped = '';
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    escaped = await host.capturePaneEscaped(pane, 40);
    // The echoed command line carries the literal text as typed; only real output has the ESC byte.
    if (escaped.includes('\u001b[31m')) break;
  }
  const plain = await host.capturePane(pane, 40);
  const sgr = '\u001b[31m';
  assert.match(escaped, /RED/);
  assert.ok(escaped.includes(sgr), 'escaped capture keeps the SGR sequence');
  assert.ok(!plain.includes(sgr), 'plain capture drops the SGR sequence');
});

test('real tmux: serverSocketPath names the scratch socket', { skip: !hasTmux }, async () => {
  const path = await host.serverSocketPath();
  assert.ok(typeof path === 'string' && path.includes(SOCKET), `expected a socket path, got ${path}`);
});

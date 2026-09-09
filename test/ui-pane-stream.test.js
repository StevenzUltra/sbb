// Pane stream: control-mode parsing, the per-pane subscription, and the rule that input
// stays refused until the subscriber asks for it. No real tmux here: the control client and
// the host are fakes (test/fixtures/ui/fake-control.js, test/fixtures/lifecycle/fake-tmux.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import { createControlFactory } from './fixtures/ui/fake-control.js';
import {
  DEFAULT_CAPTURE_LINES,
  KEY_NAME_RE,
  REFUSED,
  createPaneStream,
  parseControlLine,
  unescapeOutput,
} from '../src/ui/pane-stream.js';

const PANE = '%1';
const SESSION = 'work';

/** @param {{ clients?: any[], panes?: any[], screen?: string }} [opts] */
function makeHost(opts = {}) {
  const api = createFakeTmux({
    paneId: PANE,
    panes: opts.panes ?? [{ paneId: PANE, session: SESSION, windowId: '@1', coord: 'work:0.0', command: 'zsh' }],
    clients: opts.clients ?? [],
  });
  api.capturePaneEscaped = async (paneId, lines) => {
    api.calls.push(['capturePaneEscaped', paneId, lines]);
    return opts.screen ?? 'SCREEN';
  };
  api.resizePane = async (paneId, size) => {
    api.calls.push(['resize-pane', paneId, size.cols, size.rows]);
  };
  return api;
}

/** @param {{ host?: any, control?: any }} [opts] */
function makeStream(opts = {}) {
  const host = opts.host ?? makeHost();
  const control = opts.control ?? createControlFactory();
  const errors = [];
  const stream = createPaneStream({
    session: SESSION,
    host,
    controlFactory: control,
    onError: (err) => errors.push(err),
  });
  return { stream, host, control, errors, client: () => control.clients[0] };
}

test('unescapeOutput decodes octal escapes, doubled backslashes and UTF-8', () => {
  assert.equal(unescapeOutput('plain').toString('utf8'), 'plain');
  assert.equal(unescapeOutput('hi\\015\\012').toString('utf8'), 'hi\r\n');
  assert.equal(unescapeOutput('\\033[31m').toString('utf8'), '\u001b[31m');
  assert.equal(unescapeOutput('a\\134b').toString('utf8'), 'a' + String.fromCharCode(92) + 'b');
  assert.equal(unescapeOutput('a\\\\b').toString('utf8'), 'a' + String.fromCharCode(92) + 'b');
  assert.equal(unescapeOutput('\\99').toString('utf8'), String.fromCharCode(92) + '99');
  assert.equal(unescapeOutput('中文').toString('utf8'), '中文');
  assert.equal(unescapeOutput('').length, 0);
});

test('parseControlLine classifies every line the server reacts to', () => {
  const output = parseControlLine('%output %7 hello');
  assert.equal(output.type, 'output');
  assert.equal(output.paneId, '%7');
  assert.equal(output.data.toString('utf8'), 'hello');
  const empty = parseControlLine('%output %7');
  assert.equal(empty.type, 'output');
  assert.equal(empty.paneId, '%7');
  assert.equal(empty.data.length, 0);
  assert.equal(parseControlLine('%exit').type, 'exit');
  assert.equal(parseControlLine('%session-changed $3 work').session, 'work');
  assert.equal(parseControlLine('%window-close @2').windowId, '@2');
  assert.equal(parseControlLine('%layout-change @1').type, 'layout-change');
  assert.equal(parseControlLine('%begin 1 2 0').type, 'block');
  assert.equal(parseControlLine('%end 1 2 0').type, 'block');
  assert.equal(parseControlLine('%error 1 2 0 oops').type, 'error');
  assert.equal(parseControlLine('anything else').type, 'other');
});

test('createPaneStream needs a session', () => {
  assert.throws(() => createPaneStream({ session: '' }), /session is required/);
});

test('subscribing before start captures nothing; start sends the screen and turns streaming on', async () => {
  const { stream, control, client } = makeStream();
  /** @type {any[]} */
  const events = [];
  stream.subscribe(PANE, { onOutput: (data, meta) => events.push({ data: data.toString('utf8'), meta }) });
  assert.equal(events.length, 0, 'nothing before start');
  assert.equal(stream.watched().length, 1);
  await stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client().lines, [`refresh-client -A "${PANE}:on"`]);
  assert.equal(events.length, 1);
  assert.equal(events[0].meta.initial, true);
  assert.equal(events[0].data, 'SCREEN\r\n');
  assert.deepEqual(control.clients.map((c) => c.session), [SESSION]);
  assert.ok(stream.started);
});

test('captureLines defaults to 40 and can be overridden', async () => {
  const host = makeHost();
  const stream = createPaneStream({ session: SESSION, host, controlFactory: createControlFactory() });
  stream.subscribe(PANE, {});
  await stream.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls.find((c) => c[0] === 'capturePaneEscaped'), ['capturePaneEscaped', PANE, DEFAULT_CAPTURE_LINES]);
});

test('output reaches only the subscribed pane and is unescaped', async () => {
  const { stream, client } = makeStream();
  /** @type {string[]} */
  const seen = [];
  stream.subscribe(PANE, { onOutput: (data, meta) => { if (!meta.initial) seen.push(data.toString('utf8')); } });
  await stream.start();
  client().feed('%output %2 not-watched\n');
  client().feed('%output %1 \u001b[31mhi\u001b[0m\\015\\012\n');
  assert.deepEqual(seen, ['\u001b[31mhi\u001b[0m\r\n']);
});

test('input is refused until the subscriber asks for it, then typed as a single line', async () => {
  const { stream, host } = makeStream();
  const sub = stream.subscribe(PANE, {});
  await stream.start();
  assert.deepEqual(await sub.input('ls'), { refused: true, reason: REFUSED.INPUT_OFF });
  assert.equal(host.calls.filter((c) => c[0] === 'send-literal').length, 0, 'nothing typed while refused');
  sub.setInput(true);
  assert.deepEqual(await sub.input('ls -la'), { refused: false });
  assert.deepEqual(host.calls.filter((c) => c[0] === 'send-literal').at(-1), ['send-literal', PANE, 'ls -la']);
  assert.deepEqual(await sub.input(''), { refused: true, reason: REFUSED.INVALID_INPUT });
  assert.deepEqual(await sub.input('a\nb'), { refused: true, reason: REFUSED.INVALID_INPUT });
  assert.deepEqual(await sub.input('a\rb'), { refused: true, reason: REFUSED.INVALID_INPUT });
  assert.deepEqual(await sub.input('a b\tc'), { refused: false }, 'tabs and spaces are fine');
  sub.setInput(false);
  assert.deepEqual(await sub.input('ls'), { refused: true, reason: REFUSED.INPUT_OFF });
});

test('key accepts tmux key names only, and only with input on', async () => {
  const { stream, host } = makeStream();
  const sub = stream.subscribe(PANE, {});
  await stream.start();
  assert.deepEqual(await sub.key('Enter'), { refused: true, reason: REFUSED.INPUT_OFF });
  sub.setInput(true);
  assert.deepEqual(await sub.key('Enter'), { refused: false });
  assert.deepEqual(await sub.key('C-u'), { refused: false });
  assert.deepEqual(await sub.key('BSpace'), { refused: false });
  for (const bad of ['-l', 'Enter; rm -rf /', 'a b', '', 'Enter -t %1']) {
    assert.equal(KEY_NAME_RE.test(bad), false, bad);
    assert.deepEqual(await sub.key(bad), { refused: true, reason: REFUSED.INVALID_KEY });
  }
  const sent = host.calls.filter((c) => c[0] === 'send-key').map((c) => c[2]);
  assert.deepEqual(sent, ['Enter', 'C-u', 'BSpace']);
});

test('resize is refused while a human client is attached and allowed when none is', async () => {
  const withHuman = makeHost({ clients: [{ tty: '/dev/ttys001', session: SESSION, controlMode: false }] });
  const first = makeStream({ host: withHuman });
  const sub1 = first.stream.subscribe(PANE, {});
  await first.stream.start();
  assert.deepEqual(await sub1.resize(100, 30), { refused: true, reason: REFUSED.CLIENT_ATTACHED });
  assert.equal(withHuman.calls.filter((c) => c[0] === 'resize-pane').length, 0);

  const controlOnly = makeHost({ clients: [{ tty: '', session: SESSION, controlMode: true }] });
  const second = makeStream({ host: controlOnly });
  const sub2 = second.stream.subscribe(PANE, {});
  await second.stream.start();
  assert.deepEqual(await sub2.resize(1, 30), { refused: true, reason: REFUSED.INVALID_SIZE }, 'cols must be >= 2');
  assert.deepEqual(await sub2.resize(100, 0), { refused: true, reason: REFUSED.INVALID_SIZE });
  assert.deepEqual(await sub2.resize(100, 30.5), { refused: true, reason: REFUSED.INVALID_SIZE });
  assert.deepEqual(await sub2.resize(2001, 30), { refused: true, reason: REFUSED.INVALID_SIZE });
  assert.deepEqual(await sub2.resize(100, 30), { refused: false });
  assert.deepEqual(controlOnly.calls.filter((c) => c[0] === 'resize-pane').at(-1), ['resize-pane', PANE, 100, 30]);
});

test('closing a subscription stops its output and turns streaming off', async () => {
  const { stream, client } = makeStream();
  /** @type {string[]} */
  const seen = [];
  const sub = stream.subscribe(PANE, { onOutput: (data, meta) => { if (!meta.initial) seen.push(data.toString('utf8')); } });
  await stream.start();
  await sub.close();
  assert.deepEqual(client().lines, [`refresh-client -A "${PANE}:on"`, `refresh-client -A "${PANE}:off"`]);
  client().feed('%output %1 after-close\n');
  assert.deepEqual(seen, []);
  assert.deepEqual(stream.watched(), []);
  await sub.close(); // idempotent
  assert.equal(client().lines.length, 2);
});

test('%exit closes subscribers, a same-session %session-changed does not', async () => {
  const { stream, client } = makeStream();
  /** @type {any[]} */
  const closed = [];
  stream.subscribe(PANE, { onClosed: (info) => closed.push(info) });
  await stream.start();
  client().feed('%session-changed $1 work\n');
  assert.deepEqual(closed, [], 'the attach itself reports our own session');
  client().feed('%session-changed $2 other\n');
  assert.deepEqual(closed, [{ type: 'closed', paneId: PANE, reason: 'session_changed' }]);
});

test('%exit closes every subscriber with control_exit', async () => {
  const { stream, client } = makeStream();
  /** @type {any[]} */
  const closed = [];
  stream.subscribe(PANE, { onClosed: (info) => closed.push(info) });
  await stream.start();
  client().feed('%exit\n');
  assert.deepEqual(closed, [{ type: 'closed', paneId: PANE, reason: 'control_exit' }]);
});

test('a pane that disappears after a layout change is reported closed', async () => {
  const host = makeHost();
  const { stream, client } = makeStream({ host });
  /** @type {any[]} */
  const closed = [];
  stream.subscribe(PANE, { onClosed: (info) => closed.push(info) });
  await stream.start();
  host.setPanes([]);
  client().feed('%layout-change @1\n');
  for (let i = 0; i < 40 && closed.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(closed, [{ type: 'closed', paneId: PANE, reason: 'pane_closed' }]);
});

test('stop closes subscribers and the control client', async () => {
  const { stream, client } = makeStream();
  /** @type {any[]} */
  const closed = [];
  stream.subscribe(PANE, { onClosed: (info) => closed.push(info) });
  await stream.start();
  await stream.stop();
  assert.deepEqual(closed, [{ type: 'closed', paneId: PANE, reason: 'server_stopped' }]);
  assert.deepEqual(stream.watched(), []);
  assert.equal(client().lines.at(-1), `refresh-client -A "${PANE}:off"`);
  await stream.stop(); // idempotent
});

test('a throwing handler is routed to onError, not swallowed', async () => {
  const errors = [];
  const stream = createPaneStream({
    session: SESSION,
    host: makeHost(),
    controlFactory: createControlFactory(),
    onError: (err) => errors.push(err),
  });
  stream.subscribe(PANE, { onOutput: () => { throw new Error('handler boom'); } });
  await stream.start();
  assert.ok(errors.some((err) => /handler boom/.test(err.message)));
  await stream.stop();
});

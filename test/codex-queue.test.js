// Unit tests for the codex-queue transport. The `codex` binary and tmux are both faked,
// so nothing here needs a live Codex session. Screen samples are the live captures from
// test/tmux-keys.test.js (panes %20 idle, %21 busy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexQueue, hasBinaryOnPath, QUEUE_TIMEOUT_MS } from '../src/transports/codex-queue.js';
import { newMsgId } from '../src/lib/ids.js';

const CODEX_HOME = '/Users/steven/.ai-account-b/codex';

const CODEX_IDLE = [
  '› Ask Codex to do anything',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

const CODEX_ANSWERED = [
  '› [h2@b/codex:24:3.6][子脑] hello from h2',
  '• hello from h2',
  '› Ask Codex to do anything',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

const TARGET = {
  address: 'b/codex:Reply with PONG',
  account: 'b',
  cli: 'codex',
  paneId: '%20',
  coord: '24:1.7',
  codex: { id: '01a08154-c780-7953-9378-2158dec124da', name: 'Reply with PONG' },
};

function fakeRun(result = {}) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...result };
    },
  };
}

function fakeTmux(screens) {
  const calls = { captures: 0 };
  let index = 0;
  return {
    calls,
    api: {
      async capturePane() {
        calls.captures += 1;
        const screen = screens[Math.min(index, screens.length - 1)];
        index += 1;
        return screen;
      },
    },
  };
}

const fastSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function transportFor({ run, tmux = fakeTmux([CODEX_IDLE]), ...overrides } = {}) {
  return createCodexQueue({
    run: run ?? fakeRun().run,
    tmuxApi: tmux.api,
    sleep: fastSleep,
    pollMs: 1,
    codexHomeFor: () => CODEX_HOME,
    binaryOnPath: () => true,
    ...overrides,
  });
}

const message = (text = 'hello from h2') => ({ msgId: newMsgId(), text, priority: 'next', fromBrain: 'h2' });

test('supports(): codex target with a thread id and the binary on PATH', () => {
  const transport = transportFor();
  assert.equal(transport.supports(TARGET), true);
  assert.equal(transport.supports({ ...TARGET, cli: 'claude' }), false);
  assert.equal(transport.supports({ ...TARGET, codex: { name: 'x' } }), false);
  assert.equal(transport.supports({ ...TARGET, codex: undefined }), false);
  assert.equal(createCodexQueue({ binaryOnPath: () => false }).supports(TARGET), false);
});

test('hasBinaryOnPath() finds an existing binary and rejects a fake one', () => {
  assert.equal(hasBinaryOnPath('node'), true);
  assert.equal(hasBinaryOnPath('definitely-not-a-real-binary-xyz'), false);
});

test('send(): runs codex queue with the target CODEX_HOME, thread and 25 s timeout', async () => {
  const { calls, run } = fakeRun({ stdout: 'Queued message abc for thread def.\n' });
  const transport = transportFor({ run, tmux: fakeTmux([CODEX_IDLE, CODEX_IDLE]) });
  await transport.send(TARGET, message(), { verifyTimeoutMs: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
  assert.deepEqual(calls[0].args, ['queue', '--thread', TARGET.codex.id, '--message', 'hello from h2']);
  assert.equal(calls[0].opts.env.CODEX_HOME, CODEX_HOME);
  assert.equal(calls[0].opts.timeoutMs, QUEUE_TIMEOUT_MS);
});

test('send(): delivered when the queued text shows up on screen', async () => {
  const { run } = fakeRun({ stdout: 'Queued message abc for thread def.\n' });
  const transport = transportFor({ run, tmux: fakeTmux([CODEX_IDLE, CODEX_ANSWERED]) });
  const receipt = await transport.send(TARGET, message(), { verifyTimeoutMs: 50 });
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.via, 'codex-queue');
});

test('send(): queued when the turn is not observed on screen', async () => {
  const { run } = fakeRun({ stdout: 'Queued message abc for thread def.\n' });
  const transport = transportFor({ run, tmux: fakeTmux([CODEX_IDLE]) });
  const receipt = await transport.send(TARGET, message(), { verifyTimeoutMs: 20 });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.reason, undefined);
});

test('send(): queued when the target has no pane to verify against', async () => {
  const { run } = fakeRun({ stdout: 'Queued message abc for thread def.\n' });
  const tmux = fakeTmux([CODEX_ANSWERED]);
  const transport = transportFor({ run, tmux });
  const receipt = await transport.send({ ...TARGET, paneId: undefined }, message());
  assert.equal(receipt.status, 'queued');
  assert.equal(tmux.calls.captures, 0);
});

test('send(): no rollout found maps to blocked no_rollout', async () => {
  const { run } = fakeRun({ code: 1, stderr: 'Error: no rollout found for thread id abc\n' });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'no_rollout');
});

test('send(): unknown thread maps to blocked thread_not_found', async () => {
  const { run } = fakeRun({ code: 1, stderr: "Error: No active session found matching 'x'\n" });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.reason, 'thread_not_found');
});

test('send(): missing binary maps to transport_unavailable', async () => {
  const { run } = fakeRun({ code: 1, stderr: 'codex: not found\n' });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.reason, 'transport_unavailable');
});

test('send(): a hung codex queue is unverified, never delivered', async () => {
  const { run } = fakeRun({ code: null, timedOut: true });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.status, 'unverified');
  assert.equal(receipt.reason, 'queue_timeout');
});

test('send(): unknown failure is blocked, not queued', async () => {
  const { run } = fakeRun({ code: 2, stderr: 'error: unexpected argument\n' });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'transport_unavailable');
  assert.match(receipt.detail, /exited 2/);
});

test('send(): exit 0 without the Queued message marker is blocked', async () => {
  const { run } = fakeRun({ code: 0, stdout: 'nothing useful\n' });
  const receipt = await transportFor({ run }).send(TARGET, message());
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'transport_unavailable');
});

test('send(): missing CODEX_HOME for the account is transport_unavailable', async () => {
  const { calls, run } = fakeRun();
  const receipt = await transportFor({ run, codexHomeFor: () => undefined }).send(TARGET, message());
  assert.equal(receipt.reason, 'transport_unavailable');
  assert.equal(calls.length, 0);
});

test('send(): dry run reports the command without running it', async () => {
  const { calls, run } = fakeRun();
  const receipt = await transportFor({ run }).send(TARGET, message(), { dryRun: true });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'policy');
  assert.equal(calls.length, 0);
});

test('send(): newlines in the envelope are collapsed to one line', async () => {
  const { calls, run } = fakeRun({ stdout: 'Queued message abc for thread def.\n' });
  const transport = transportFor({ run, tmux: fakeTmux([CODEX_IDLE, CODEX_IDLE]) });
  await transport.send(TARGET, message('a\r\nb'), { verifyTimeoutMs: 10 });
  assert.equal(calls[0].args[4], 'a b');
});

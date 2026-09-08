// confirm.js: screen confirmation for transports without a protocol receipt.
// Screen samples follow the shapes measured in docs/spec/protocols.md section 1 (Claude
// `Message from @<name>: ...`) and section 2 (Codex echo + answer), trimmed to the parts
// the confirmation reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BODY_PROBE_CHARS,
  claudeSessionFile,
  confirmOnScreen,
  readClaudeStatus,
} from '../src/transports/confirm.js';

const BODY = '[h2@b/claude:24:3.6][子脑] hello from h2';
const CODEX_BODY = '[h2@b/codex:24:3.6][子脑] hello from h2';
const RULE = '─'.repeat(74);

const CLAUDE_IDLE = [
  '⏺ Update(~/developer/sbb/package.json)',
  '  ⎿  Added 1 line, removed 1 line',
  RULE,
  '❯ ',
  RULE,
  '  @ai-a · latest · [████░░░░░░] 40% · 5h:10%/3h42m · 7d:10%/2d23h · age:1h9m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const CLAUDE_MESSAGE = [
  '  Message from @eagerstudy-b1: [h2@b/claude:24:3.6][子脑] hello from h2',
  '⏺ On it.',
  RULE,
  '❯ ',
  RULE,
  '  @ai-a · latest · [████░░░░░░] 40% · 5h:10%/3h42m · 7d:10%/2d23h · age:1h9m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// Text typed but not submitted: it sits in the composer. Must never count as delivered.
const CLAUDE_DRAFT = [
  '⏺ Update(~/developer/sbb/package.json)',
  RULE,
  `❯ ${BODY}`,
  RULE,
  '  @ai-a · latest · [████░░░░░░] 40% · 5h:10%/3h42m · 7d:10%/2d23h · age:1h9m',
].join('\n');

const CODEX_IDLE = [
  '› Ask Codex to do anything',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

const CODEX_ECHO = [
  `› ${CODEX_BODY}`,
  `• ${CODEX_BODY}`,
  '› Ask Codex to do anything',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

const CURSOR_IDLE = [
  '→ Plan, search, build anything',
  '  fake · auto',
].join('\n');

const CURSOR_QUEUED = [
  '⏺ read file.ts',
  '1 task',
  '→ Add a follow-up',
  '  fake · auto',
].join('\n');

/** @param {string} cli */
const target = (cli) => ({ address: 'h2', account: 'a', cli, paneId: '%30', coord: '24:3.4' });

/**
 * capturePane walks the screen list, then repeats the last one.
 * Sending keys throws: confirm must never type.
 */
function fakeTmux(screens) {
  const calls = { captures: 0, sends: 0 };
  let i = 0;
  return {
    calls,
    api: {
      async capturePane() {
        calls.captures += 1;
        const screen = screens[Math.min(i, screens.length - 1)];
        i += 1;
        return screen;
      },
      async sendLiteral() {
        calls.sends += 1;
        throw new Error('confirmOnScreen must never type');
      },
      async sendKey() {
        calls.sends += 1;
        throw new Error('confirmOnScreen must never type');
      },
    },
  };
}

/** @param {Array<string|undefined>} list */
function statusReader(list) {
  const calls = { reads: 0 };
  let i = 0;
  return {
    calls,
    read: async () => {
      calls.reads += 1;
      const status = list[Math.min(i, list.length - 1)];
      i += 1;
      return status;
    },
  };
}

const noSleep = async () => {};
const recordingSleep = (record) => async (ms) => { record.push(ms); };

test('claude: Message from @<name> in the transcript confirms delivery', async () => {
  const tmux = fakeTmux([CLAUDE_IDLE, CLAUDE_MESSAGE]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
  assert.equal(tmux.calls.sends, 0);
  assert.equal(tmux.calls.captures, 2);
});

test('codex: a new transcript echo alone confirms delivery', async () => {
  const tmux = fakeTmux([CODEX_IDLE, CODEX_ECHO]);
  const result = await confirmOnScreen(
    target('codex'),
    { text: CODEX_BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
  assert.equal(tmux.calls.sends, 0);
});

test('claude: text sitting in the composer is a draft, not a delivery', async () => {
  const tmux = fakeTmux([CLAUDE_IDLE, CLAUDE_DRAFT]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 30, pollMs: 1 },
  );
  assert.equal(result, 'pending');
  assert.equal(tmux.calls.sends, 0);
});

test('cursor: a newly queued follow-up confirms delivery', async () => {
  const tmux = fakeTmux([CURSOR_IDLE, CURSOR_QUEUED]);
  const result = await confirmOnScreen(
    target('cursor'),
    { text: 'unrelated-text-xyz', fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
});

test('claude: roster status idle -> busy confirms delivery without a screen signal', async () => {
  const tmux = fakeTmux([CLAUDE_IDLE]);
  const status = statusReader(['idle', 'idle', 'busy']);
  const result = await confirmOnScreen(
    { ...target('claude'), claude: { pid: 4242 } },
    { text: BODY, fromName: 'nobody-on-screen' },
    { tmuxApi: tmux.api, sleep: noSleep, readStatus: status.read, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
  assert.ok(status.calls.reads >= 2, 'status is polled after the baseline');
  assert.equal(tmux.calls.sends, 0);
});

test('status already busy at baseline is not a signal (no idle -> busy edge)', async () => {
  const tmux = fakeTmux([CLAUDE_IDLE]);
  const status = statusReader(['busy']);
  const result = await confirmOnScreen(
    { ...target('claude'), claude: { pid: 4242 } },
    { text: BODY, fromName: 'nobody-on-screen' },
    { tmuxApi: tmux.api, sleep: noSleep, readStatus: status.read, timeoutMs: 20, pollMs: 1 },
  );
  assert.equal(result, 'pending');
});

test('timeout with a quiet screen and idle roster returns pending', async () => {
  const tmux = fakeTmux([CLAUDE_IDLE]);
  const status = statusReader(['idle']);
  const result = await confirmOnScreen(
    { ...target('claude'), claude: { pid: 1 } },
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: noSleep, readStatus: status.read, timeoutMs: 20, pollMs: 1 },
  );
  assert.equal(result, 'pending');
  assert.equal(tmux.calls.sends, 0);
});

test('a message already on screen confirms on the first capture, with no sleep', async () => {
  const record = [];
  const tmux = fakeTmux([CLAUDE_MESSAGE]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: recordingSleep(record), timeoutMs: 1000 },
  );
  assert.equal(result, 'delivered');
  assert.equal(tmux.calls.captures, 1);
  assert.deepEqual(record, []);
});

test('no paneId returns pending without touching tmux', async () => {
  const tmux = fakeTmux([CLAUDE_MESSAGE]);
  const result = await confirmOnScreen(
    { address: 'h2', account: 'a', cli: 'claude' },
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api },
  );
  assert.equal(result, 'pending');
  assert.equal(tmux.calls.captures, 0);
  assert.equal(tmux.calls.sends, 0);
});

test('default poll interval is 500 ms', async () => {
  const record = [];
  const tmux = fakeTmux([CLAUDE_IDLE, CLAUDE_MESSAGE]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: tmux.api, sleep: recordingSleep(record), timeoutMs: 2000 },
  );
  assert.equal(result, 'delivered');
  assert.deepEqual(record, [500]);
});

test('body wrapped across pane lines still matches', async () => {
  const body = 'the quick brown fox jumps over the lazy dog and keeps running past the fence';
  assert.ok(body.length > BODY_PROBE_CHARS, 'probe must be a strict prefix of the body');
  // A pane wraps at its column width (about 80 here), so the first break lands far past
  // the 32/60-char probe. A break inside the probe itself is reported pending, not
  // delivered: under-reporting is the safe direction.
  const wrapped = [
    `⏺ ${body.slice(0, 78)}`,
    body.slice(78),
    '❯ ',
  ].join('\n');
  const tmux = fakeTmux([CLAUDE_IDLE, wrapped]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: body, fromName: 'never-shown' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
});

test('a similar sender name does not match', async () => {
  const screen = ['  Message from @axb: unrelated text', '❯ '].join('\n');
  const tmux = fakeTmux([screen]);
  const result = await confirmOnScreen(
    target('claude'),
    { text: 'zzz-not-on-screen', fromName: 'a.b' },
    { tmuxApi: tmux.api, sleep: noSleep, timeoutMs: 20, pollMs: 1 },
  );
  assert.equal(result, 'pending');
});

test('an unreadable pane at baseline returns pending without polling', async () => {
  let captures = 0;
  const api = {
    async capturePane() {
      captures += 1;
      throw new Error('pane not found');
    },
  };
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'pending');
  assert.equal(captures, 1);
});

test('a transient capture failure keeps polling and can still confirm', async () => {
  let n = 0;
  const api = {
    async capturePane() {
      n += 1;
      if (n === 2) throw new Error('transient tmux hiccup');
      return n >= 3 ? CLAUDE_MESSAGE : CLAUDE_IDLE;
    },
  };
  const result = await confirmOnScreen(
    target('claude'),
    { text: BODY, fromName: 'eagerstudy-b1' },
    { tmuxApi: api, sleep: noSleep, timeoutMs: 1000, pollMs: 10 },
  );
  assert.equal(result, 'delivered');
  assert.ok(n >= 3);
});

test('readClaudeStatus reads a real registry file and tolerates a partial write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sbb-confirm-'));
  const file = join(dir, '4242.json');
  await writeFile(file, JSON.stringify({ pid: 4242, status: 'busy' }));
  assert.equal(await readClaudeStatus({}, { file }), 'busy');
  await writeFile(file, '{"pid":4242,"stat');
  assert.equal(await readClaudeStatus({}, { file }), undefined);
  await writeFile(file, JSON.stringify({ pid: 4242 }));
  assert.equal(await readClaudeStatus({}, { file }), undefined);
  assert.equal(await readClaudeStatus({}, { file: join(dir, 'missing.json') }), undefined);
});

test('claudeSessionFile needs both a pid and an account config dir', () => {
  assert.equal(claudeSessionFile({ account: 'a' }), undefined);
  assert.equal(claudeSessionFile({ claude: { pid: 4242 }, account: 'no-such-account' }), undefined);
  const path = claudeSessionFile({ claude: { pid: 4242 }, account: 'a' });
  assert.ok(path === undefined || path.endsWith('/sessions/4242.json'));
});

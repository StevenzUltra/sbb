// Unit tests for the typed transport and the per-CLI fingerprints, plus one integration
// test against a scratch tmux server running test/fixtures/fake-cli.js.
//
// Screen samples marked "live" were captured with `tmux capture-pane -p` on this machine
// on 2026-09-09: claude from panes %30/%74, codex from %20/%21, agy and cursor from scratch
// sessions. Samples marked "spec" are states no live pane was in (permission dialog,
// Cursor task queue) and come from docs/spec/protocols.md section 3.
// test/fixtures/codex-screens.json holds full codex captures from a scratch codex-cli
// 0.154.0-alpha.6 (same day), including the trust dialog and the screen left behind by it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLI_PROFILES, profileFor } from '../src/transports/cli-profiles.js';
import { createTmuxKeys, MAX_TEXT_CHARS } from '../src/transports/tmux-keys.js';
import { newMsgId } from '../src/lib/ids.js';

// --- live samples (claude: %30 / %74, codex: %20 idle, %21 busy, agy / cursor: scratch) -----

const CLAUDE_IDLE = [
  '⏺ Update(~/developer/sbb/package.json)',
  '  ⎿  Added 1 line, removed 1 line',
  '──────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '──────────────────────────────────────────────────────────────────────────────',
  '  @ai-a · latest · [████░░░░░░] 40% · 5h:10%/3h42m · 7d:10%/2d23h · age:1h9m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · /diff to hide diff',
  '  ⧉  agent-switchboard-design',
].join('\n');

const CLAUDE_BUSY = [
  '⏺ Approve held messages in helper panes and check they started',
  '  ⎿  $ for p in %31 %74 %73; do tmux send-keys -t $p Down; sleep 0.3; tmux',
  '     send-keys -t $p Enter; done',
  '· Sublimating… (10m 9s · ↓ 43.5k tokens)',
  '──────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '──────────────────────────────────────────────────────────────────────────────',
  '  @ai-a · latest · [████░░░░░░] 40% · 5h:10%/3h42m · 7d:10%/2d23h · age:1h9m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const CODEX_IDLE = [
  '╭───────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.154.0-alpha.6)                │',
  '╰───────────────────────────────────────────────────╯',
  '  Tip: Try the Desktop app. Run \'codex app\' or visit',
  '• You have 2 usage limit resets available. Run /usage to use one.',
  '⠁   ⠈         ⠄          ⢀      ⠁       ⠁        ⠐ ⠐     ⠐⠂ ⠄',
  '› Ask Codex to do anything⡀        ⠈    ⠁                    ⠈        ⠄',
  '      ⠠⢀⠐        ⠄        ⠄                  ⢀       ⡀ ⠂',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

const CODEX_BUSY = [
  '• Ran bash scripts/verify/pnpm-node20.sh --filter @eagerstudy/api run typecheck:app > /',
  '  │ tmp/eagerstudy-material-cloud-copy-20260909.sAcaz3/api-typecheck-r2.log 2>&1',
  '  └ (no output)',
  '• Working (18m 06s • esc to interrupt)',
  '› Ask Codex to do anything',
  '  latest · weekly 77% left · gpt-6-astra xhigh · Context 6% … Pursuing goal (2d 8h 4m)',
].join('\n');

const CODEX_SUBMITTED = [
  '• Working (2s • esc to interrupt)',
  '› [h2@b/codex:24:3.6][子脑] hello from h2',
  '• hello from h2',
  '› Ask Codex to do anything',
  '  latest · weekly 97% left · gpt-6-astra xhigh · Context 100% left',
].join('\n');

// --- spec samples (protocols.md section 3; no live pane available) ------------------------

const AGY_IDLE = [
  '      ▄▀▀▄        Antigravity CLI 1.1.20',
  '     ▀▀▀▀▀▀       stevenzjhpre@gmail.com (Google AI Ultra)',
  '    ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (High)',
  '   ▄▀▀    ▀▀▄     ~/developer/eagerstudy',
  '  ▄▀▀      ▀▀▄',
  '────────────────────────────────────────────────────────────────────────────────',
  '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
  '────────────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                                accept-edits · Gemini 3.8 Flash · high · AI Credits: 2',
].join('\n');

const AGY_BUSY = [
  '⏺ Bash(cd ~/developer/eagerstudy && pnpm test)',
  'Working',
  '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
  '? for shortcuts                                                accept-edits · Gemini 3.8 Flash · high',
].join('\n');

const CURSOR_IDLE = [
  '→ Add a follow-up',
  '  eagerstudy · auto',
  '  Tip: Cursor agent runs tools in your workspace',
].join('\n');

const CURSOR_QUEUED = [
  '→ Add a follow-up',
  '  1 task',
  '  eagerstudy · auto',
  '  Tip: Cursor agent runs tools in your workspace',
].join('\n');

const CURSOR_SUBMITTED = [
  '› [h2@b/cursor:24:3.6][子脑] hello cursor',
  '• Working on it',
  '→ Add a follow-up',
  '  eagerstudy · auto',
].join('\n');

// live: a freshly started cursor-agent, scratch session 2026-09-09
const CURSOR_FRESH_IDLE = [
  '  Cursor Agent',
  '  v2026.09.06-cd43d70',
  '  Tip: Hit shift+tab to enable Plan Mode for large or complex changes.',
  ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '  → Plan, search, build anything',
  ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '  Root · Steven Zhang · stevenzjhpre@gmail.com',
  '  Auto · eagerstudy latest · auto · [░░░░░░░░░░] 0%',
].join('\n');

// --- profile fingerprints -----------------------------------------------------------------

test('claude profile: live idle, busy and composer rules', () => {
  const p = CLI_PROFILES.claude;
  assert.equal(p.enters, 1);
  assert.equal(p.idle(CLAUDE_IDLE), true);
  assert.equal(p.busy(CLAUDE_IDLE), false);
  assert.equal(p.prompting(CLAUDE_IDLE), false);
  assert.equal(p.acceptsInput(CLAUDE_IDLE), true);

  assert.equal(p.idle(CLAUDE_BUSY), false);
  assert.equal(p.busy(CLAUDE_BUSY), true);
  assert.equal(p.acceptsInput(CLAUDE_BUSY), false);

  // A composer with a draft is never "safe to type": sendLiteral would append to it.
  assert.equal(p.idle('❯ half written draft'), false);
  assert.equal(p.acceptsInput('❯ half written draft'), false);
});

test('claude profile: permission dialog (spec sample)', () => {
  const dialog = [
    'Bash command',
    '  rm -rf /tmp/example',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  assert.equal(CLI_PROFILES.claude.prompting(dialog), true);
  assert.equal(CLI_PROFILES.claude.acceptsInput(dialog), false);
});

test('codex profile: live idle and busy samples', () => {
  const p = CLI_PROFILES.codex;
  assert.equal(p.enters, 1);
  assert.equal(p.idle(CODEX_IDLE), true);
  assert.equal(p.busy(CODEX_IDLE), false);
  assert.equal(p.acceptsInput(CODEX_IDLE), true);

  assert.equal(p.idle(CODEX_BUSY), false);
  assert.equal(p.busy(CODEX_BUSY), true);
  assert.equal(p.acceptsInput(CODEX_BUSY), false);
});

// Full captures, not trimmed samples: these are the shapes that broke roster status.
const CODEX_SCREENS = JSON.parse(readFileSync(new URL('./fixtures/codex-screens.json', import.meta.url), 'utf8'));

test('codex profile: a dismissed trust dialog in the scrollback is not an open dialog', () => {
  // The trust prompt stays in the capture for the rest of the session. Matching the whole
  // screen kept `prompting` true, so roster showed `?` for a perfectly idle codex brain.
  const p = CLI_PROFILES.codex;
  const screen = CODEX_SCREENS.idleWithDismissedDialog;
  assert.match(screen, /› 1\. Yes, continue/, 'fixture must still contain the dismissed dialog');
  assert.equal(p.prompting(screen), false);
  assert.equal(p.busy(screen), false);
  assert.equal(p.idle(screen), true);
  assert.equal(p.acceptsInput(screen), true);
});

test('codex profile: a dialog that is actually open still reads as prompting', () => {
  const p = CLI_PROFILES.codex;
  const screen = CODEX_SCREENS.trustDialog;
  assert.equal(p.prompting(screen), true);
  assert.equal(p.idle(screen), false);
  assert.equal(p.acceptsInput(screen), false);
});

test('codex profile: live busy and finished-turn captures', () => {
  const p = CLI_PROFILES.codex;
  assert.match(CODEX_SCREENS.busy, /• Working \(\d+s • esc to interrupt\)/);
  assert.equal(p.busy(CODEX_SCREENS.busy), true);
  assert.equal(p.idle(CODEX_SCREENS.busy), false);
  // The spinner line is redrawn, never left behind: a finished turn is idle again.
  assert.doesNotMatch(CODEX_SCREENS.turnDone, /• Working \(/);
  assert.equal(p.busy(CODEX_SCREENS.turnDone), false);
  assert.equal(p.idle(CODEX_SCREENS.turnDone), true);
});

test('codex profile: braille padding on the composer line still reads as idle', () => {
  const p = CLI_PROFILES.codex;
  const screen = CODEX_SCREENS.brailleIdleComposer;
  assert.match(screen, /› Ask Codex to do anything[\u2800-\u28ff]/);
  assert.equal(p.idle(screen), true);
  assert.equal(p.prompting(screen), false);
});

test('roster resolves the profile map through its dynamic import', async () => {
  // src/registry/roster.js does `mod.profiles ?? mod.default ?? mod`; the namespace has no
  // `codex` key, so a missing `profiles` export silently degrades every status to '?'.
  const mod = await import('../src/transports/cli-profiles.js');
  const profiles = mod.profiles ?? mod.default ?? mod;
  assert.equal(profiles.codex, mod.CLI_PROFILES.codex);
  assert.equal(profiles.codex.idle(CODEX_SCREENS.idleWithDismissedDialog), true);
  assert.equal(profiles.codex.busy(CODEX_SCREENS.busy), true);
});

test('agy profile: spec idle and busy samples', () => {
  const p = CLI_PROFILES.agy;
  assert.equal(p.enters, 1);
  assert.equal(p.idle(AGY_IDLE), true);
  assert.equal(p.busy(AGY_IDLE), false);
  assert.equal(p.busy(AGY_BUSY), true);
  assert.equal(p.acceptsInput(AGY_BUSY), false);
});

test('cursor profile: spec samples, two Enters, follow-up queue', () => {
  const p = CLI_PROFILES.cursor;
  assert.equal(p.enters, 2);
  assert.equal(p.idle(CURSOR_IDLE), true);
  assert.equal(p.busy(CURSOR_IDLE), false);
  assert.equal(p.idle(CURSOR_FRESH_IDLE), true);
  assert.equal(p.acceptsInput(CURSOR_FRESH_IDLE), true);
  // The composer stays usable while a task runs: that is how a follow-up is queued.
  assert.equal(p.idle(CURSOR_QUEUED), false);
  assert.equal(p.busy(CURSOR_QUEUED), true);
  assert.equal(p.acceptsInput(CURSOR_QUEUED), true);
});

test('submitted(): delivered when the text leaves the composer', () => {
  assert.equal(CLI_PROFILES.codex.submitted(CODEX_IDLE, CODEX_SUBMITTED, 'hello from h2'), 'delivered');
  assert.equal(CLI_PROFILES.cursor.submitted(CURSOR_IDLE, CURSOR_SUBMITTED, 'hello cursor'), 'delivered');
});

test('submitted(): pending while the text still sits on the composer', () => {
  const stillThere = CODEX_IDLE.replace('› Ask Codex to do anything', '› hello from h2');
  assert.equal(CLI_PROFILES.codex.submitted(CODEX_IDLE, stillThere, 'hello from h2'), 'pending');
});

test('submitted(): cursor 1 task badge means queued', () => {
  assert.equal(CLI_PROFILES.cursor.submitted(CURSOR_IDLE, CURSOR_QUEUED, 'hello cursor'), 'queued');
});

test('submitted(): wrapped long text still matches through the 32-char probe', () => {
  const text = 'x'.repeat(200);
  const after = ['• ' + 'x'.repeat(60), '  ' + 'x'.repeat(60), '› Ask Codex to do anything'].join('\n');
  assert.equal(CLI_PROFILES.codex.submitted(CODEX_IDLE, after, text), 'delivered');
});

test('profileFor() falls back to the other profile', () => {
  assert.equal(profileFor('agy').id, 'agy');
  assert.equal(profileFor('unknown-cli').id, 'other');
  assert.equal(profileFor(undefined).id, 'other');
});

// --- transport with a fake tmux api --------------------------------------------------------

function fakeTmux({ screens, pane = {}, inMode = false } = {}) {
  const calls = { literal: [], keys: [], listPanes: 0, captures: 0, paneInMode: 0 };
  let index = 0;
  const livePane = { paneId: '%9', command: 'node', inMode: false, ...pane };
  return {
    calls,
    api: {
      async listPanes() {
        calls.listPanes += 1;
        return [livePane];
      },
      async paneInMode() {
        calls.paneInMode += 1;
        return inMode;
      },
      async capturePane() {
        calls.captures += 1;
        const screen = screens[Math.min(index, screens.length - 1)];
        index += 1;
        return screen;
      },
      async sendLiteral(_paneId, text) {
        calls.literal.push(text);
      },
      async sendKey(_paneId, key) {
        calls.keys.push(key);
      },
    },
  };
}

const TARGET = { address: 'fake', account: 'default', cli: 'codex', paneId: '%9', coord: 'h2-fake:1.1' };

function transportFor(tmux, opts = {}) {
  return createTmuxKeys({ tmuxApi: tmux.api, sleep: async () => {}, settleMs: 0, ...opts });
}

function message(text = 'hello from h2') {
  return { msgId: newMsgId(), text, priority: 'next', fromBrain: 'h2' };
}

test('send: delivered when the screen confirms submission', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE, CODEX_SUBMITTED] });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.via, 'send-keys');
  assert.equal(tmux.calls.literal.length, 1);
  assert.deepEqual(tmux.calls.keys, ['Enter']);
  assert.equal(tmux.calls.keys.includes('Esc'), false);
});

test('send: one extra Enter when the first is swallowed, never a resend', async () => {
  const stillThere = CODEX_IDLE.replace('› Ask Codex to do anything', '› hello from h2');
  const tmux = fakeTmux({ screens: [CODEX_IDLE, stillThere, CODEX_SUBMITTED] });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.status, 'delivered');
  assert.equal(tmux.calls.literal.length, 1, 'text must be sent exactly once');
  assert.deepEqual(tmux.calls.keys, ['Enter', 'Enter']);
});

test('send: unverified enter_swallowed_twice after the retry', async () => {
  const stillThere = CODEX_IDLE.replace('› Ask Codex to do anything', '› hello from h2');
  const tmux = fakeTmux({ screens: [CODEX_IDLE, stillThere, stillThere] });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.status, 'unverified');
  assert.equal(receipt.reason, 'enter_swallowed_twice');
  assert.equal(tmux.calls.literal.length, 1);
  assert.deepEqual(tmux.calls.keys, ['Enter', 'Enter']);
});

test('send: cursor sends two Enters and reports queued on the 1 task badge', async () => {
  const tmux = fakeTmux({ screens: [CURSOR_IDLE, CURSOR_QUEUED] });
  const receipt = await transportFor(tmux).send({ ...TARGET, cli: 'cursor' }, message('hello cursor'));
  assert.equal(receipt.status, 'queued');
  assert.deepEqual(tmux.calls.keys, ['Enter', 'Enter']);
});

test('send: strips CR/LF instead of typing a second line', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE, CODEX_SUBMITTED] });
  await transportFor(tmux).send(TARGET, message('a\r\nb\nc'));
  assert.deepEqual(tmux.calls.literal, ['a b c']);
});

test('send: refuses text longer than the limit without touching tmux', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE] });
  const receipt = await transportFor(tmux).send(TARGET, message('x'.repeat(MAX_TEXT_CHARS + 1)));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'too_long');
  assert.equal(tmux.calls.listPanes, 0);
  assert.equal(tmux.calls.literal.length, 0);
});

test('send: accepts exactly the limit', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE, CODEX_SUBMITTED] });
  const receipt = await transportFor(tmux).send(TARGET, message('x'.repeat(MAX_TEXT_CHARS)));
  assert.equal(receipt.status, 'delivered');
});

test('send: blocked pane_in_copy_mode before any screen read', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE], inMode: true });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.reason, 'pane_in_copy_mode');
  assert.equal(tmux.calls.captures, 0);
});

test('send: blocked foreground_program when a shell owns the pane', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE], pane: { command: 'zsh' } });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.reason, 'foreground_program');
  assert.equal(tmux.calls.literal.length, 0);
});

test('send: blocked target_busy while a turn runs', async () => {
  const tmux = fakeTmux({ screens: [CLAUDE_BUSY] });
  const receipt = await transportFor(tmux).send({ ...TARGET, cli: 'claude' }, message());
  assert.equal(receipt.reason, 'target_busy');
  assert.equal(tmux.calls.literal.length, 0);
});

test('send: blocked target_prompting on a permission dialog', async () => {
  const dialog = ['Do you want to proceed?', '❯ 1. Yes', '  2. No (esc)'].join('\n');
  const tmux = fakeTmux({ screens: [dialog] });
  const receipt = await transportFor(tmux).send({ ...TARGET, cli: 'claude' }, message());
  assert.equal(receipt.reason, 'target_prompting');
  assert.equal(tmux.calls.literal.length, 0);
});

test('send: blocked when the screen is not a known composer', async () => {
  const tmux = fakeTmux({ screens: ['$ make build\nbuilding...'] });
  const receipt = await transportFor(tmux).send(TARGET, message());
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'target_busy');
  assert.equal(tmux.calls.literal.length, 0);
});

test('send: blocked target_not_found for a dead pane', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE] });
  const receipt = await transportFor(tmux).send({ ...TARGET, paneId: '%404' }, message());
  assert.equal(receipt.reason, 'target_not_found');
});

test('send: dry run checks preconditions and types nothing', async () => {
  const tmux = fakeTmux({ screens: [CODEX_IDLE] });
  const receipt = await transportFor(tmux).send(TARGET, message(), { dryRun: true });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'policy');
  assert.equal(tmux.calls.literal.length, 0);
  assert.equal(tmux.calls.keys.length, 0);
});

test('supports(): true for any target with a pane id', () => {
  const transport = transportFor(fakeTmux({ screens: [CODEX_IDLE] }));
  assert.equal(transport.supports(TARGET), true);
  assert.equal(transport.supports({ ...TARGET, cli: 'other' }), true);
  assert.equal(transport.supports({ ...TARGET, paneId: undefined }), false);
  assert.equal(transport.supports(undefined), false);
});

// --- integration against a real tmux server ------------------------------------------------

const HAS_TMUX = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

// Unique per process. Several agents share this machine and each `npm test` run owns its
// own server because after() kills it: with one fixed name, a concurrent run's kill-server
// deleted this run's panes mid-test ("no current target" / "can't find pane").
const TMUX_SOCKET = `sbb-test-${process.pid}`;
const TMUX_ARGS = ['-L', TMUX_SOCKET];
// src/lib/tmux.js reads this for every call, so the real transport talks to the scratch server.
process.env.SBB_TMUX_ARGS = TMUX_ARGS.join(' ');

function tmuxCli(args, encoding) {
  return execFileSync('tmux', [...TMUX_ARGS, ...args], { encoding: encoding ?? 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function startFakeSession(name, extra = []) {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.js');
  try {
    tmuxCli(['kill-session', '-t', name]);
  } catch {
    // no such session
  }
  tmuxCli(['new-session', '-d', '-s', name, '-x', '200', '-y', '50', process.execPath, fixture, '--cli', 'codex', '--busy-ms', '300', ...extra]);
  const paneId = tmuxCli(['list-panes', '-t', name, '-F', '#{pane_id}']).trim();
  // Wait for the fixture to draw its composer before the transport reads the screen.
  const deadline = Date.now() + 10000;
  for (;;) {
    if (/^\s*›/m.test(tmuxCli(['capture-pane', '-p', '-t', paneId]))) return paneId;
    if (Date.now() >= deadline) throw new Error(`${name} never drew a codex composer`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

/** Poll the pane for a pattern instead of waiting a fixed number of seconds. */
async function waitForPane(paneId, re, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (re.test(tmuxCli(['capture-pane', '-p', '-t', paneId]))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

after(() => {
  if (!HAS_TMUX) return;
  try {
    execFileSync('tmux', [...TMUX_ARGS, 'kill-server'], { stdio: 'pipe' });
  } catch {
    // server already gone
  }
});

test('integration: real send-keys against the fake CLI in tmux', { skip: HAS_TMUX ? false : 'tmux not available' }, async () => {
  const paneId = await startFakeSession('h2-fake-plain');
  const receipt = await createTmuxKeys({ settleMs: 3000 }).send(
    { address: 'fake', account: 'default', cli: 'codex', paneId, coord: 'h2-fake-plain:1.1' },
    message('hello h2 integration'),
  );
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.via, 'send-keys');
  assert.ok(await waitForPane(paneId, /hello h2 integration/), 'the echo is on the pane');
});

test('integration: swallowed first Enter is retried and delivered', { skip: HAS_TMUX ? false : 'tmux not available' }, async () => {
  const paneId = await startFakeSession('h2-fake-swallow', ['--swallow-first-enter']);
  const receipt = await createTmuxKeys({ settleMs: 3000 }).send(
    { address: 'fake', account: 'default', cli: 'codex', paneId, coord: 'h2-fake-swallow:1.1' },
    message('hello h2 retry'),
  );
  assert.equal(receipt.status, 'delivered');
  assert.ok(await waitForPane(paneId, /hello h2 retry/), 'the echo is on the pane');
  // The first verification window (3 s) had to expire before the retry: that only happens
  // when the swallowed Enter left the text on the composer. Polling then delivered fast.
  assert.ok(receipt.elapsedMs >= 3000, `expected the retry path, got ${receipt.elapsedMs}ms`);
});

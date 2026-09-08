#!/usr/bin/env node
// Interactive fake CLI for the tmux-keys integration test.
// Prints one CLI's idle composer, echoes submitted lines into a transcript, optionally
// swallows the first Enter, and shows that CLI's busy marker for --busy-ms.
//
//   node test/fixtures/fake-cli.js --cli codex --swallow-first-enter --busy-ms 1200
//
// It owns its pane, so tests must never point it at a real session.
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    cli: { type: 'string', default: 'codex' },
    'swallow-first-enter': { type: 'boolean', default: false },
    'busy-ms': { type: 'string', default: '1200' },
  },
});

const FACES = {
  claude: {
    composer: '❯ ',
    placeholder: '',
    busy: '· Working… (2s · ↓ 1.2k tokens)',
    footer: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  },
  codex: {
    composer: '› ',
    placeholder: 'Ask Codex to do anything',
    busy: '• Working (2s • esc to interrupt)',
    footer: '  latest · weekly 97% left · gpt-6-astra xhigh',
  },
  agy: {
    composer: '> ',
    placeholder: 'Accept-edits mode',
    busy: 'Working',
    footer: '  accept-edits · Gemini 3 Pro',
  },
  cursor: {
    composer: '→ ',
    placeholder: 'Add a follow-up',
    busy: '1 task',
    footer: '  fake · auto',
  },
};

const face = FACES[values.cli] ?? FACES.codex;
const busyMs = Number(values['busy-ms']) || 0;

// `node --test` treats every file under test/ as a test file. With no TTY there is no
// interactive session to fake, so exit instead of blocking the runner forever.
if (!process.stdin.isTTY && process.env.SBB_FAKE_CLI_FORCE !== '1') process.exit(0);

/** @type {string[]} */
const transcript = [];
let input = '';
let busy = false;
let enters = 0;

const write = (text) => process.stdout.write(text);

function render() {
  const lines = [...transcript];
  if (busy) lines.push(face.busy);
  lines.push(`${face.composer}${input || face.placeholder}`);
  lines.push(face.footer);
  // 3J clears the saved lines too, so capture-pane never sees a stale composer.
  write(`\x1b[3J\x1b[2J\x1b[H${lines.join('\n')}\n`);
}

function submit() {
  const text = input.trim();
  if (!text) {
    render();
    return;
  }
  transcript.push(`${face.composer}${text}`);
  transcript.push(`• ${text}`);
  input = '';
  busy = true;
  render();
  if (busyMs > 0) {
    setTimeout(() => {
      busy = false;
      render();
    }, busyMs);
  }
}

function onKey(char) {
  if (char === '\r' || char === '\n') {
    enters += 1;
    if (values['swallow-first-enter'] && enters === 1) {
      render();
      return;
    }
    submit();
    return;
  }
  if (char === '\u007f' || char === '\b') {
    input = input.slice(0, -1);
    render();
    return;
  }
  if (char === '\u0003' || char === '\u0004') {
    process.exit(0);
  }
  if (char >= ' ') {
    input += char;
    render();
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const char of chunk) onKey(char);
});
process.on('SIGTERM', () => process.exit(0));

render();

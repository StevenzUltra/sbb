// Per-CLI screen fingerprints for typed delivery (tmux send-keys).
// Pure functions over `tmux capture-pane -p` text: no I/O, no tmux, no state.
//
// Fingerprints follow docs/spec/protocols.md section 3. The samples in test/tmux-keys.test.js
// marked "live" were captured from scratch panes on this machine on 2026-09-09; the rest come
// from the spec table and are labelled "spec" (see docs/reports/h2-2026-09-09.md).

/** @typedef {import('../types.js').CliKind} CliKind */
/** @typedef {'delivered'|'queued'|'pending'} ScreenVerdict */

/** Collapse whitespace so a wrapped composer line compares equal to the sent text. */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Braille spinner glyphs the CLIs draw in and beside the composer line. */
export function stripGlyphs(text) {
  return String(text ?? '').replace(/[⠀-⣿]/g, '');
}

/**
 * One screen line as the matchers see it: spinner glyphs gone, runs of spaces and tabs
 * collapsed. Codex draws its spinner into the composer line itself and pads with spaces,
 * so `› Ask Codex to do anything⡀   ⠈  ⠁` and `› Ask Codex to do anything` are the same
 * state (live sample: test/fixtures/codex-screens.json).
 */
export function normalizeLine(text) {
  return collapse(stripGlyphs(text));
}

/**
 * Index of the last line that looks like the CLI's composer (input) line, or -1.
 * The composer is always the last prompt-prefixed line: earlier ones are transcript echoes.
 * @param {string} screen
 * @param {RegExp} promptRe
 */
export function lastPromptIndex(screen, promptRe) {
  const lines = String(screen ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (promptRe.test(lines[i])) return i;
  }
  return -1;
}

/** The composer line and everything below it (status bars, footers). */
export function inputRegion(screen, promptRe) {
  const lines = String(screen ?? '').split('\n');
  const i = lastPromptIndex(screen, promptRe);
  return i === -1 ? '' : lines.slice(i).join('\n');
}

/** Everything above the composer line: the transcript. */
export function transcriptAbove(screen, promptRe) {
  const lines = String(screen ?? '').split('\n');
  const i = lastPromptIndex(screen, promptRe);
  return (i === -1 ? lines : lines.slice(0, i)).join('\n');
}

const PROBE_CHARS = 32;

/** Short stable probe for wrapped text; 32 chars survive normal terminal wrapping. */
export function probeOf(text) {
  return collapse(text).slice(0, PROBE_CHARS);
}

/**
 * @typedef {Object} CliProfile
 * @property {CliKind} id
 * @property {1|2} enters               Enter keys one submission needs
 * @property {(screen: string) => boolean} idle       composer empty, no turn, no dialog
 * @property {(screen: string) => boolean} busy       a turn is running
 * @property {(screen: string) => boolean} prompting  a permission dialog is open
 * @property {(screen: string) => boolean} acceptsInput  typing now is safe (see cursor note)
 * @property {(before: string, after: string, text: string) => ScreenVerdict} submitted
 */

/**
 * @param {Object} spec
 * @param {CliKind} spec.id
 * @param {RegExp} spec.promptRe        composer line prefix
 * @param {RegExp} spec.emptyComposer   composer line with nothing typed (marker stripped)
 * @param {RegExp[]} spec.busyRe
 * @param {RegExp[]} spec.promptingRe
 * @param {1|2} spec.enters
 * @param {RegExp} [spec.queuedRe]      badge meaning "accepted as a follow-up"
 * @param {boolean} [spec.followUpQueue] CLI queues follow-ups while a turn is running
 * @param {'screen'|'input'} [spec.promptingScope]  where to look for a dialog (default screen)
 * @returns {CliProfile}
 */
function defineProfile(spec) {
  const busy = (screen) => spec.busyRe.some((re) => re.test(String(screen ?? '')));

  // A dismissed dialog stays in the scrollback forever, so matching the whole capture
  // would report "prompting" for the rest of the session. With scope 'input' only the
  // composer line and below count, which is where an open dialog is drawn (the trust
  // dialog replaces the composer entirely; its own `› 1. Yes` line is the last prompt
  // line, so it still lands inside the region). No prompt line at all falls back to the
  // whole screen.
  const prompting = (screen) => {
    const text = String(screen ?? '');
    const region = spec.promptingScope === 'input' ? (inputRegion(text, spec.promptRe) || text) : text;
    return spec.promptingRe.some((re) => re.test(region));
  };

  const composerEmpty = (screen) => {
    const lines = String(screen ?? '').split('\n');
    const i = lastPromptIndex(screen, spec.promptRe);
    return i !== -1 && spec.emptyComposer.test(normalizeLine(lines[i]));
  };

  const idle = (screen) => composerEmpty(screen) && !busy(screen) && !prompting(screen);

  // Cursor keeps its composer usable while a task runs: that is how a follow-up is queued.
  // For every other CLI "safe to type" is exactly "idle".
  const acceptsInput = (screen) => {
    if (prompting(screen)) return false;
    if (lastPromptIndex(screen, spec.promptRe) === -1) return false;
    return spec.followUpQueue ? true : idle(screen);
  };

  /** @type {CliProfile['submitted']} */
  const submitted = (before, after, text) => {
    const probe = probeOf(text);
    if (!probe) return 'pending';
    const queuedAfter = spec.queuedRe ? spec.queuedRe.test(String(after ?? '')) : false;
    const queuedBefore = spec.queuedRe ? spec.queuedRe.test(String(before ?? '')) : false;
    if (queuedAfter && !queuedBefore) return 'queued';
    if (collapse(inputRegion(after, spec.promptRe)).includes(probe)) return 'pending';
    const echoAfter = collapse(transcriptAbove(after, spec.promptRe)).includes(probe);
    const echoBefore = collapse(transcriptAbove(before, spec.promptRe)).includes(probe);
    if (echoAfter && !echoBefore) return 'delivered';
    if (spec.followUpQueue && busy(after)) return 'queued';
    if (!busy(before) && busy(after)) return 'delivered';
    return 'pending';
  };

  return { id: spec.id, enters: spec.enters, idle, busy, prompting, acceptsInput, submitted };
}

const claude = defineProfile({
  id: 'claude',
  promptRe: /^\s*❯/,
  emptyComposer: /^\s*❯\s*$/,
  busyRe: [
    /⎿\s+(?:Running|Waiting)\b/,
    /(?:^|\n)\s*[·*✢✳✶✻✽]\s+[A-Z][^\n]*…\s*\(/,
    /(?:esc|Esc) to interrupt/,
  ],
  promptingRe: [
    /Do you want to (?:proceed|allow|make this edit|run|create|delete)\b/i,
    /(?:^|\n)\s*[❯›>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

const codex = defineProfile({
  id: 'codex',
  promptRe: /^\s*›/,
  // normalizeLine() strips the spinner braille and collapses padding first.
  emptyComposer: /^›(?:\s*Ask Codex to do anything)?$/,
  // Codex keeps a dismissed dialog in the scrollback (live sample: trust prompt), and its
  // approval dialog replaces the composer, so only the input region can hold an open one.
  promptingScope: 'input',
  busyRe: [
    /(?:^|\n)\s*•\s+Working\b/,
    /(?:esc|Esc) to interrupt/,
  ],
  promptingRe: [
    /(?:^|\n)\s*Allow (?:command|this)\b/i,
    /(?:^|\n)\s*[❯›>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

const agy = defineProfile({
  id: 'agy',
  promptRe: /^\s*>/,
  // live pane 2026-09-09: '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)'
  emptyComposer: /^\s*>\s*(?:Accept-edits mode[^\n]*)?$/,
  busyRe: [/(?:^|\n)\s*Working\b/, /(?:esc|Esc) to interrupt/],
  promptingRe: [
    /Do you want to (?:proceed|allow|run)\b/i,
    /(?:^|\n)\s*[❯›>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

const cursor = defineProfile({
  id: 'cursor',
  promptRe: /^\s*→/,
  // live pane 2026-09-09 (fresh): '→ Plan, search, build anything';
  // spec (a task is running): '→ Add a follow-up'
  emptyComposer: /^\s*→\s*(?:Plan, search, build anything|Add a follow-up)?\s*$/,
  busyRe: [/(?:^|\n)\s*\d+\s+tasks?\b/],
  promptingRe: [
    /Do you want to (?:proceed|allow|run)\b/i,
    /(?:^|\n)\s*[❯›>]?\s*1\.\s+Yes\b/,
  ],
  enters: 2,
  queuedRe: /(?:^|\n)\s*\d+\s+tasks?\b/,
  followUpQueue: true,
});

const kimi = defineProfile({
  id: 'kimi',
  promptRe: /^\s*\u2502\s*>/,
  // live pane 2026-09-10 (m4k, kimi 0.41.0): the composer is a bordered box, so the
  // collapsed empty line is '\u2502 > \u2502' (the right border shares the row).
  emptyComposer: /^\u2502\s*>\s*\u2502?$/,
  // 'working...' / 'thinking...' are the turn markers; the footer's rotating tip
  // ('ctrl-s to add guidance...') and 'K3 thinking: max' are not, so anchor on the glyph.
  busyRe: [/(?:^|\n)\s*[\u2800-\u28ff]?\s*(?:working|thinking)\u2026/],
  promptingRe: [
    // live pane 2026-09-10 (m4k8): first visit to a folder that is not trusted yet.
    /Trust this folder\?/,
    /Enable project MCP servers/,
    /Do you want to (?:proceed|allow|run)\b/i,
    /(?:^|\n)\s*[\u276f\u203a>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

const grok = defineProfile({
  id: 'grok',
  promptRe: /^\s*\u2502\s*\u276f/,
  // live pane 2026-09-10 (m4g, grok 1.0.13): boxed composer '\u2502 \u276f'. The user's own
  // turn is echoed above as an indented '\u276f <text>' with no border, so only the boxed
  // line is the composer and lastPromptIndex never picks an echo.
  emptyComposer: /^\u2502\s*\u276f\s*\u2502?$/,
  busyRe: [
    /(?:^|\n)\s*[\u2800-\u28ff]?\s*(?:Waiting for response|Thinking|Responding|Retrying \(attempt \d+\))\u2026/,
    /Esc:cancel/,
  ],
  promptingRe: [
    /Do you want to (?:proceed|allow|run)\b/i,
    /(?:^|\n)\s*[\u276f\u203a>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

// Fallback for cli === 'other': no measured fingerprint exists, so only generic markers
// are used and the transport still refuses anything that is not a plain prompt.
const other = defineProfile({
  id: 'other',
  promptRe: /^\s*[>❯›→$#%]\s?/,
  emptyComposer: /^\s*[>❯›→$#%]\s*$/,
  busyRe: [
    /(?:^|\n)\s*•\s+Working\b/,
    /⎿\s+(?:Running|Waiting)\b/,
    /(?:esc|Esc) to interrupt/,
  ],
  promptingRe: [
    /Do you want to (?:proceed|allow|run)\b/i,
    /(?:^|\n)\s*[❯›>]?\s*1\.\s+Yes\b/,
  ],
  enters: 1,
});

/** @type {Record<CliKind, CliProfile>} */
export const CLI_PROFILES = { claude, codex, agy, cursor, kimi, grok, other };

/**
 * Alias the dynamic importer in src/registry/roster.js resolves (`mod.profiles ?? …`).
 * Without it roster fell through to the module namespace, found no `codex` key and
 * reported `?` for every non-Claude pane.
 */
export const profiles = CLI_PROFILES;

/**
 * @param {CliKind|string|undefined} cli
 * @returns {CliProfile}
 */
export function profileFor(cli) {
  return CLI_PROFILES[cli] ?? CLI_PROFILES.other;
}

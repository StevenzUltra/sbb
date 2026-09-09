import { cliLabel } from './quota.js';

// Rules behind 新建 (web/src/components/SpawnDialog.vue). Kept out of the SFC so the account
// x CLI quota pick, the per-account CLI and model lists, the working-directory quick picks
// and the drag clamp are testable without a DOM (test/web-spawn.test.js).
//
// Quota: the number must belong to the pair that will actually launch. An account can hold
// one chip per CLI, so reading "the first chip of the account" showed another CLI's 0.
// Order: the exact `${account}/${cli}` chip when it carries a number, then the account's
// first numeric chip, then 按量 when the account has no number at all.

/**
 * @param {any[]} quota ready-made chips from web/src/lib/quota.js
 * @param {string} account @param {string} cli
 * @returns {{ key: string, label?: string, pct?: number|null, note?: string }|null}
 */
export function quotaChipFor(quota, account, cli) {
  const chips = Array.isArray(quota) ? quota : [];
  const numeric = (chip) => Boolean(chip) && typeof chip.pct === 'number';
  const exact = chips.find((chip) => chip?.key === `${account}/${cli}`) ?? null;
  if (numeric(exact)) return exact;
  const sibling = chips.find(
    (chip) => typeof chip?.key === 'string' && chip.key.startsWith(`${account}/`) && numeric(chip),
  );
  return sibling ?? exact;
}

/** What the account button and the footer show for the pair. Never a number from another CLI. */
export function quotaLabel(quota, account, cli) {
  const chip = quotaChipFor(quota, account, cli);
  if (!chip) return '按量';
  return typeof chip.pct === 'number' ? `${chip.pct}%` : '按量';
}

/** The CLIs the account can actually launch (server merges the catalog into `clis`). */
export function cliOptions(account) {
  const list = Array.isArray(account?.clis) ? account.clis : [];
  return [...new Set(list.filter((cli) => typeof cli === 'string' && cli !== ''))];
}

/**
 * Models for one account x CLI pair. Catalog rows carry `account` and `cli`; a row without an
 * account applies everywhere. A pair with no rows stays selectable with an empty model, which
 * means "the CLI's own default" (docs/tasks/m4-h2-spawn-dialog.md).
 */
export function modelOptions(catalog, { account, cli } = {}) {
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.filter(
    (row) => row?.cli === cli && row.model && (row.account == null || row.account === account),
  );
}

/** Quick picks for the working directory: the parent's cwd first, then the server's recent
 * list (newest first), unique, capped. The field stays editable by hand. */
export function cwdPicks({ recent = [], parent = null, limit = 8 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  add(parent);
  for (const value of Array.isArray(recent) ? recent : []) add(value);
  return out.slice(0, Math.max(0, limit));
}

/**
 * Drag clamp. The dialog is centred by flex, so x/y are offsets from the centre: keep the
 * whole panel inside the viewport, and stay centred when it cannot fit.
 */
export function clampOffset({
  x = 0, y = 0, width = 0, height = 0, viewportWidth = 0, viewportHeight = 0, margin = 8,
} = {}) {
  const axis = (value, size, viewport) => {
    const span = (viewport - size) / 2 - margin;
    const min = -span;
    const max = span;
    const want = Number.isFinite(value) ? value : 0;
    return min > max ? (min + max) / 2 : Math.min(Math.max(want, min), max);
  };
  return { x: axis(x, width, viewportWidth), y: axis(y, height, viewportHeight) };
}

// The dragged position lasts for the session, not the mount: <script setup> runs per instance,
// so it has to live in the module (a reopened dialog lands where the user left it).
const session = { x: 0, y: 0, set: false };

/** @returns {{x: number, y: number}|null} */
export function readDialogPosition() {
  return session.set ? { x: session.x, y: session.y } : null;
}

/** @param {{x: number, y: number}} value */
export function writeDialogPosition({ x = 0, y = 0 } = {}) {
  session.x = Number.isFinite(x) ? x : 0;
  session.y = Number.isFinite(y) ? y : 0;
  session.set = true;
}

export function resetDialogPosition() {
  session.x = 0;
  session.y = 0;
  session.set = false;
}

// Model combo (follow-up 2026-09-10): the catalog suggests, anything typed is accepted
// verbatim (people run their own or local models through someone else's harness), and the
// last custom id per CLI is remembered as the first suggestion.
export const MODELS_KEY = 'sbb-spawn-models';

/** @param {{ getItem: (k: string) => string|null }|null|undefined} storage */
export function readCustomModels(storage) {
  try {
    const raw = storage?.getItem(MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([cli, id]) => typeof cli === 'string' && cli !== '' && typeof id === 'string' && id.trim() !== '',
      ),
    );
  } catch {
    return {};
  }
}

/** @returns {Record<string, string>} the whole map, so callers can replace their copy */
export function writeCustomModel(storage, cli, id) {
  const next = { ...readCustomModels(storage) };
  const value = typeof id === 'string' ? id.trim() : '';
  if (cli && value) next[cli] = value;
  else if (cli) delete next[cli];
  try {
    storage?.setItem(MODELS_KEY, JSON.stringify(next));
  } catch {
    // a private-mode storage that refuses writes must not break 新建
  }
  return next;
}

/** Catalog models for the pair, with the remembered custom id first. */
export function modelSuggestions(catalog, { account, cli, custom = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (id, label) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label ?? id });
  };
  const remembered = typeof custom === 'string' ? custom.trim() : '';
  add(remembered, `${remembered} · 上次手输`);
  for (const row of modelOptions(catalog, { account, cli })) add(row.model, row.label);
  return out;
}

/** Footer line: the pair, the model, the effort that will be passed, and any downgrade hint. */
export function footerText({ chip = null, account = '', cli = '', model = '', effort = '', note = '' } = {}) {
  const base = chip?.label ?? `${account} · ${cli}`;
  const id = typeof model === 'string' && model.trim() !== '' ? model.trim() : '默认';
  const level = typeof effort === 'string' ? effort.trim() : '';
  const quota = chip ? (typeof chip.pct === 'number' ? `剩余 ${chip.pct}%` : '按量') : '额度未知';
  return [base, id, level, quota, typeof note === 'string' ? note.trim() : '']
    .filter((part) => part !== '').join(' · ');
}

// Effort (follow-up 2, 2026-09-10; `max` added same day): only the CLIs whose launch command has a
// thinking-effort switch take it (src/lifecycle/launch.js: claude --effort, codex
// -c model_reasoning_effort=). The server downgrades a level a CLI cannot do and records the
// level it really used as `effortApplied`; the ceiling below mirrors that rule so the dialog
// can warn before the spawn.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_CEILING = Object.freeze({ claude: 'max', codex: 'xhigh' });

/** @param {string} cli @returns {string[]} empty means "this CLI has no effort switch: hide it" */
export function effortOptions(cli) {
  return EFFORT_CEILING[String(cli ?? '')] ? [...EFFORT_LEVELS] : [];
}

/**
 * The level the CLI will actually run. Unknown levels pass through (the server decides).
 * @param {string} cli @param {string} level @returns {string} '' when the CLI takes no effort
 */
export function effortApplied(cli, level) {
  const want = typeof level === 'string' ? level.trim() : '';
  if (want === '') return '';
  const ceiling = EFFORT_CEILING[String(cli ?? '')];
  if (!ceiling) return '';
  const index = EFFORT_LEVELS.indexOf(want);
  if (index < 0) return want;
  return EFFORT_LEVELS[Math.min(index, EFFORT_LEVELS.indexOf(ceiling))];
}

/** '' when the level runs as chosen, else 「Codex 最高 xhigh，将按 xhigh 运行」. */
export function effortNote(cli, level) {
  const want = typeof level === 'string' ? level.trim() : '';
  if (want === '') return '';
  const applied = effortApplied(cli, want);
  if (!applied || applied === want) return '';
  return `${cliLabel(cli)} 最高 ${applied}，将按 ${applied} 运行`;
}

// Names are addresses too, so the server takes any script, digits, - _ . and keeps case, but
// never a space (src/registry/brains.js). The field rewrites spaces as the user types.
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;
export const NAME_RULE_HINT = '名字只能用字母、数字、中文、-、_、.，不能有空格（最长 40 个字符）';

/** @param {unknown} value @returns {string} */
export function sanitizeName(value) {
  return String(value ?? '').replace(/\s+/g, '-');
}

/** Replace the server's regex complaint with the plain rule; leave every other error alone. */
export function errorText(message) {
  const text = String(message ?? '');
  return /(^|[^a-z_])invalid_name([^a-z_]|$)/.test(text) ? NAME_RULE_HINT : text;
}

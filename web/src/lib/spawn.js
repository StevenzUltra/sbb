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

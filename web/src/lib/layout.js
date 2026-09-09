// Column widths of the console (web-console.md): the brain tree on the left and the brain
// pane on the right are dragged by the handles between the columns, remembered per browser
// (localStorage 'sbb-layout'), and a double-click on a handle puts a column back to its
// default. The stream in the middle always keeps at least MIN_STREAM.

export const LAYOUT_KEY = 'sbb-layout';
export const DEFAULTS = Object.freeze({ left: 300, right: 460 });
export const LIMITS = Object.freeze({
  left: { min: 220, max: 560 },
  right: { min: 360, max: 960 },
});
/** The conversation column never gets narrower than this. */
export const MIN_STREAM = 420;
/** Padding and the two handle columns, in px (p-3 twice + 2 x 12). */
export const CHROME = 24 + 24;

/**
 * Clamp one column to its limits and to what the viewport leaves for the stream.
 * @param {'left'|'right'} side
 * @param {number} value
 * @param {{ viewport: number, other: number, narrow?: boolean }} ctx the other side's width (0 when hidden)
 */
export function clampWidth(side, value, { viewport, other, narrow = false }) {
  const { min, max } = LIMITS[side];
  const room = viewport - CHROME - (narrow ? 0 : other) - MIN_STREAM;
  const upper = Math.max(min, Math.min(max, room));
  return Math.round(Math.min(upper, Math.max(min, Number(value) || min)));
}

/** @param {Storage|undefined} storage */
export function readLayout(storage) {
  try {
    const raw = storage?.getItem(LAYOUT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      left: Number.isFinite(parsed?.left) ? parsed.left : DEFAULTS.left,
      right: Number.isFinite(parsed?.right) ? parsed.right : DEFAULTS.right,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Storage|undefined} storage @param {{ left: number, right: number }} layout */
export function writeLayout(storage, layout) {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ left: layout.left, right: layout.right }));
  } catch {
    // storage can be unavailable (private window); the drag still works for this page load
  }
}

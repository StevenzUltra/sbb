// Terminal geometry helpers for the pane view.
//
// The console must never soft-wrap a pane's screen: xterm is told the pane's real column
// count and the pane area scrolls horizontally instead. tmux `capture-pane -p` trims
// trailing blanks, so the widest visible line is a LOWER BOUND on the pane width - which
// is the safe direction, because a terminal wider than its pane never wraps anything.

/** CSI, OSC and two-character escapes; tolerant of a chunk cut mid-sequence. */
const ESCAPE = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u001b\[[0-9;?<>=]*$/g;

/** East Asian wide / fullwidth ranges count as two columns. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** Zero-width: combining marks and format characters. */
const ZERO = /[\u0300-\u036f\u200b-\u200f\ufe00-\ufe0f]/;

/**
 * Visible column width of one line of terminal text: escape sequences removed, wide
 * characters counted as two.
 * @param {string} text
 * @returns {number}
 */
export function visibleWidth(text) {
  const plain = String(text ?? '').replace(ESCAPE, '');
  let width = 0;
  for (const char of plain) {
    if (ZERO.test(char)) continue;
    width += WIDE.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * Widest visible line in a chunk of terminal output. A chunk that ends mid-line yields a
 * lower bound for that line, which is still a safe lower bound for the pane width.
 * @param {string} chunk
 * @returns {number}
 */
export function widestLine(chunk) {
  let max = 0;
  for (const line of String(chunk ?? '').split(/\r?\n/)) {
    const width = visibleWidth(line);
    if (width > max) max = width;
  }
  return max;
}

/**
 * Monotone lower bound on a pane's column count, fed the raw output stream. tmux never
 * emits a line wider than the pane, so the widest line seen so far is always <= the pane's
 * real column count - the safe direction for a terminal that must never soft-wrap.
 * A bare carriage return is treated as a line break, which over-counts overwritten
 * progress lines; that is also the safe direction.
 */
export class ScreenWidth {
  constructor() {
    this.cols = 0;
    this.pending = 0;
  }

  /** Forget the previous pane (the terminal buffer is reset at the same time). */
  reset() {
    this.cols = 0;
    this.pending = 0;
  }

  /**
   * @param {string} chunk raw output, escape sequences allowed
   * @returns {number} the updated lower bound
   */
  feed(chunk) {
    const segments = String(chunk ?? '').split(/\r\n|\r|\n/);
    for (let i = 0; i < segments.length; i += 1) {
      const width = (i === 0 ? this.pending : 0) + visibleWidth(segments[i]);
      if (i === segments.length - 1) this.pending = width;
      else if (width > this.cols) this.cols = width;
    }
    return this.cols;
  }
}

// Appearance settings of the settings page (web-console.md, "设置"): the theme choice and the two
// numbers that tune the desktop shell's translucent window. Both live per browser; the CSS custom
// properties are set here and painted only by web/src/style.css.

export const THEME_KEY = 'sbb-theme';
export const APPEARANCE_KEY = 'sbb-appearance';
/** 深色 / 浅色 / 跟随系统. */
export const THEMES = Object.freeze(['dark', 'light', 'system']);
/** Window tint alpha of the desktop shell body (docs/spec/desktop.md). */
export const TINT = Object.freeze({ min: 0.1, max: 0.9, step: 0.01, default: 0.42 });
/** Backdrop blur of the desktop shell panels, in px. */
export const BLUR = Object.freeze({ min: 0, max: 48, step: 1, default: 28 });

/** @param {unknown} value @param {{ min: number, max: number, default: number }} range */
export function clampNumber(value, range) {
  const n = Number(value);
  if (!Number.isFinite(n)) return range.default;
  const clamped = Math.min(range.max, Math.max(range.min, n));
  return Math.round(clamped * 100) / 100;
}

/** @param {Storage|undefined} storage @returns {'dark'|'light'|'system'} */
export function readTheme(storage) {
  try {
    const value = storage?.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/** @param {Storage|undefined} storage @param {string} theme */
export function writeTheme(storage, theme) {
  try {
    storage?.setItem(THEME_KEY, THEMES.includes(theme) ? theme : 'system');
  } catch {
    // private windows have no storage; the choice still applies for this page load
  }
}

/** @param {string} theme @param {boolean} prefersDark */
export function resolveDark(theme, prefersDark) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return Boolean(prefersDark);
}

/** @param {HTMLElement} root @param {string} theme @param {boolean} prefersDark */
export function applyTheme(root, theme, prefersDark) {
  root.classList.toggle('dark', resolveDark(theme, prefersDark));
}

/** @param {Storage|undefined} storage @returns {{ tint: number, blur: number }} */
export function readAppearance(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(APPEARANCE_KEY) ?? '{}');
    return {
      tint: clampNumber(parsed?.tint, TINT),
      blur: clampNumber(parsed?.blur, BLUR),
    };
  } catch {
    return { tint: TINT.default, blur: BLUR.default };
  }
}

/** @param {Storage|undefined} storage @param {{ tint: number, blur: number }} value */
export function writeAppearance(storage, value) {
  try {
    storage?.setItem(APPEARANCE_KEY, JSON.stringify({
      tint: clampNumber(value?.tint, TINT),
      blur: clampNumber(value?.blur, BLUR),
    }));
  } catch {
    // see writeTheme
  }
}

/** @param {HTMLElement} root @param {{ tint: number, blur: number }} value */
export function applyAppearance(root, value) {
  root.style.setProperty('--sbb-tint-alpha', String(clampNumber(value?.tint, TINT)));
  root.style.setProperty('--sbb-blur', `${clampNumber(value?.blur, BLUR)}px`);
}

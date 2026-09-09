// Appearance settings of the settings page: theme choice, and the desktop shell's tint alpha and
// blur. Pure helpers, so they are tested without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_KEY, BLUR, THEME_KEY, TINT,
  applyAppearance, applyTheme, clampNumber, readAppearance, readTheme, resolveDark, writeAppearance, writeTheme,
} from '../web/src/lib/appearance.js';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

function fakeRoot() {
  const props = new Map();
  const classes = new Set();
  return {
    style: {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) ?? '',
    },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
  };
}

test('clampNumber keeps values inside the range and falls back on junk', () => {
  assert.equal(clampNumber(0.42, TINT), 0.42);
  assert.equal(clampNumber(5, TINT), TINT.max);
  assert.equal(clampNumber(-1, TINT), TINT.min);
  assert.equal(clampNumber('nope', BLUR), BLUR.default);
  assert.equal(clampNumber(12.345, BLUR), 12.35, 'rounded to two decimals');
});

test('theme choice round-trips and unknown values fall back to system', () => {
  const storage = fakeStorage();
  assert.equal(readTheme(storage), 'system');
  writeTheme(storage, 'dark');
  assert.equal(storage.dump()[THEME_KEY], 'dark');
  assert.equal(readTheme(storage), 'dark');
  writeTheme(storage, 'sepia');
  assert.equal(readTheme(storage), 'system', 'only the three documented choices are stored');
});

test('resolveDark: explicit choices win, system follows the OS', () => {
  assert.equal(resolveDark('dark', false), true);
  assert.equal(resolveDark('light', true), false);
  assert.equal(resolveDark('system', true), true);
  assert.equal(resolveDark('system', false), false);
});

test('applyTheme toggles the dark class on the root element', () => {
  const root = fakeRoot();
  applyTheme(root, 'dark', false);
  assert.equal(root.classList.contains('dark'), true);
  applyTheme(root, 'light', true);
  assert.equal(root.classList.contains('dark'), false);
  applyTheme(root, 'system', true);
  assert.equal(root.classList.contains('dark'), true);
});

test('appearance round-trips, clamps and lands as CSS variables', () => {
  const storage = fakeStorage();
  assert.deepEqual(readAppearance(storage), { tint: TINT.default, blur: BLUR.default });
  writeAppearance(storage, { tint: 0.6, blur: 36 });
  assert.deepEqual(readAppearance(storage), { tint: 0.6, blur: 36 });
  assert.equal(storage.dump()[APPEARANCE_KEY], JSON.stringify({ tint: 0.6, blur: 36 }));

  writeAppearance(storage, { tint: 99, blur: -4 });
  assert.deepEqual(readAppearance(storage), { tint: TINT.max, blur: BLUR.min }, 'out-of-range values are clamped, never stored raw');

  const root = fakeRoot();
  applyAppearance(root, { tint: 0.5, blur: 18 });
  assert.equal(root.style.getPropertyValue('--sbb-tint-alpha'), '0.5');
  assert.equal(root.style.getPropertyValue('--sbb-blur'), '18px');
});

test('a corrupt appearance entry falls back to the defaults', () => {
  const storage = fakeStorage({ [APPEARANCE_KEY]: '{not json' });
  assert.deepEqual(readAppearance(storage), { tint: TINT.default, blur: BLUR.default });
});

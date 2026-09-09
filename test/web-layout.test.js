// Console column resizing rules (web/src/lib/layout.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, readLayout, writeLayout, DEFAULTS } from '../web/src/lib/layout.js';

test('a column stays inside its limits and leaves the stream its minimum', () => {
  assert.equal(clampWidth('left', 100, { viewport: 1440, other: 460 }), 220, 'below min');
  assert.equal(clampWidth('left', 900, { viewport: 1440, other: 460 }), 512, 'the stream keeps 420px');
  assert.equal(clampWidth('right', 900, { viewport: 1440, other: 300 }), 672);
  assert.equal(clampWidth('right', 2000, { viewport: 2560, other: 300 }), 960, 'hard max');
  assert.equal(clampWidth('left', 400, { viewport: 900, other: 0, narrow: true }), 400, 'narrow mode ignores the hidden pane');
  assert.equal(clampWidth('left', 'x', { viewport: 1440, other: 460 }), 220, 'garbage becomes the minimum');
});

test('layout round-trips through storage and tolerates junk', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(readLayout(storage), DEFAULTS);
  writeLayout(storage, { left: 340, right: 520, extra: 1 });
  assert.deepEqual(readLayout(storage), { left: 340, right: 520 });
  store.set('sbb-layout', '{bad');
  assert.deepEqual(readLayout(storage), DEFAULTS);
  store.set('sbb-layout', JSON.stringify({ left: 'wide' }));
  assert.deepEqual(readLayout(storage), DEFAULTS);
  assert.deepEqual(readLayout(undefined), DEFAULTS);
  assert.doesNotThrow(() => writeLayout({ setItem: () => { throw new Error('quota'); } }, DEFAULTS));
});

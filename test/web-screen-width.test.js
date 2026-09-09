// Geometry helpers behind the pane view: the console must know how wide a pane really is
// without ever over-estimating (a terminal wider than its pane never wraps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenWidth, visibleWidth, widestLine } from '../web/src/lib/screen.js';

const ESC = '\u001b';
const WIDE_CHARS = String.fromCodePoint(0x7ffb, 0x8bd1); // two CJK characters
const MIDDLE = String.fromCodePoint(0x4e2d);

test('plain text counts one column per character', () => {
  assert.equal(visibleWidth('hello'), 5);
  assert.equal(visibleWidth(''), 0);
});

test('ANSI colour and cursor sequences do not count', () => {
  assert.equal(visibleWidth(ESC + '[32m> Message' + ESC + '[0m'), 9);
  assert.equal(visibleWidth(ESC + '[1;31mred' + ESC + '[m'), 3);
});

test('OSC window-title sequences do not count', () => {
  assert.equal(visibleWidth(ESC + ']0;window title' + ESC + '\\abc'), 3);
});

test('wide characters count as two columns', () => {
  assert.equal(visibleWidth(WIDE_CHARS), 4);
  assert.equal(visibleWidth('a' + MIDDLE + 'b'), 4);
});

test('a chunk cut mid-escape does not inflate the width', () => {
  assert.equal(visibleWidth('abc' + ESC + '[3'), 3);
  assert.equal(visibleWidth('abc' + ESC + '['), 3);
});

test('widestLine picks the longest line and ignores line breaks', () => {
  assert.equal(widestLine('ab\ncdef\ngh'), 4);
  assert.equal(widestLine('ab\r\ncdef\r\n'), 4);
  assert.equal(widestLine('one line only'), 13);
});

test('escape sequences are measured per line, not across them', () => {
  const screen = ESC + '[90m+- Codex -+' + ESC + '[0m\n' + ESC + '[90m| hi     |' + ESC + '[0m';
  assert.equal(widestLine(screen), 11);
});

test('ScreenWidth tracks the widest closed line and never decreases', () => {
  const w = new ScreenWidth();
  assert.equal(w.feed('abc'), 0); // the line is still open
  assert.equal(w.feed('def' + String.fromCharCode(10)), 6);
  assert.equal(w.feed('xy' + String.fromCharCode(10)), 6);
  assert.equal(w.feed('abcdefghij' + String.fromCharCode(10)), 10);
  assert.equal(w.feed('z' + String.fromCharCode(10)), 10);
});

test('ScreenWidth strips escapes and counts wide characters', () => {
  const w = new ScreenWidth();
  const nl = String.fromCharCode(10);
  assert.equal(w.feed(ESC + '[32m' + WIDE_CHARS + ESC + '[0m' + nl), 4);
});

test('reset() drops the previous pane geometry', () => {
  const w = new ScreenWidth();
  const nl = String.fromCharCode(10);
  w.feed('abcdef' + nl);
  w.reset();
  assert.equal(w.cols, 0);
  assert.equal(w.feed('ab' + nl), 2);
});

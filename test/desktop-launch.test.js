// The desktop shell's pure helpers (desktop/lib/launch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerCss, parseProbe, parseUiOutput, resolveCommand } from '../desktop/lib/launch.js';

test('parseUiOutput finds the pretty-printed {url, port, token} document, whole or not yet', () => {
  const doc = { url: 'http://127.0.0.1:4789/?t=ab', port: 4789, token: 'ab' };
  assert.deepEqual(parseUiOutput(JSON.stringify(doc)), doc);
  assert.deepEqual(parseUiOutput(`sbb: warning: something\n${JSON.stringify(doc, null, 2)}\n`), doc, 'multi-line output after a warning');
  assert.equal(parseUiOutput('{\n  "url": "http://127.0.0.1:4789/?t=ab",\n  "port": 4789,\n'), undefined, 'still streaming');
  assert.equal(parseUiOutput('sbb ui: http://127.0.0.1:4789/?t=ab'), undefined);
  assert.equal(parseUiOutput('{"url":1}'), undefined);
  assert.equal(parseUiOutput('{oops'), undefined);
  assert.equal(parseUiOutput(''), undefined);
  assert.deepEqual(parseUiOutput(`{"note":"first"}\n${JSON.stringify(doc)}`), doc, 'an earlier object is skipped');
});

test('resolveCommand prefers the sbb on PATH, falls back to the bundled copy with node, refuses without node', () => {
  assert.deepEqual(resolveCommand({ sbbPath: '/Users/me/bin/sbb', nodePath: '/opt/homebrew/bin/node', bundledDir: '/App/Resources/sbb' }), {
    file: '/Users/me/bin/sbb', args: ['ui', '--port', '0', '--no-open', '--json'], source: 'path',
  });
  assert.deepEqual(resolveCommand({ sbbPath: null, nodePath: '/opt/homebrew/bin/node', bundledDir: '/App/Resources/sbb', port: 4789 }), {
    file: '/opt/homebrew/bin/node', args: ['/App/Resources/sbb/bin/sbb.js', 'ui', '--port', '4789', '--no-open', '--json'], source: 'bundled',
  });
  assert.throws(() => resolveCommand({ sbbPath: null, nodePath: null, bundledDir: '/x' }), /Node\.js 22\.13/);
});

test('parseProbe reads PATH and the three lookups, missing ones become null', () => {
  assert.deepEqual(parseProbe('/opt/homebrew/bin:/usr/bin\n/opt/homebrew/bin/node\n\n/opt/homebrew/bin/tmux\n'), {
    path: '/opt/homebrew/bin:/usr/bin', node: '/opt/homebrew/bin/node', sbb: null, tmux: '/opt/homebrew/bin/tmux',
  });
  assert.deepEqual(parseProbe(''), { path: '', node: null, sbb: null, tmux: null });
  assert.match(headerCss(), /-webkit-app-region: drag/);
});

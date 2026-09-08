// src/cli/spawn.js: argument handling, including --cli-args values that start with a dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCliArgs, run } from '../src/cli/spawn.js';
import { captureLog } from './fixtures/registry/helpers.js';

test('normalizeCliArgs: a bare --cli-args takes the next token even when it starts with -', () => {
  assert.deepEqual(
    normalizeCliArgs(['--name', 'ios', '--cli-args', '--permission-mode bypassPermissions', '--force']),
    ['--name', 'ios', '--cli-args=--permission-mode bypassPermissions', '--force'],
  );
  assert.deepEqual(
    normalizeCliArgs(['--cli-args', '--verbose --add-dir /tmp/x']),
    ['--cli-args=--verbose --add-dir /tmp/x'],
  );
});

test('normalizeCliArgs: spawn own flags, the = form and plain args are left alone', () => {
  assert.deepEqual(normalizeCliArgs(['--cli-args', '--force']), ['--cli-args', '--force']);
  assert.deepEqual(normalizeCliArgs(['--cli-args=--x']), ['--cli-args=--x']);
  assert.deepEqual(normalizeCliArgs(['--name', 'ios', '--split']), ['--name', 'ios', '--split']);
  assert.deepEqual(normalizeCliArgs(['--cli-args']), ['--cli-args']);
});

test('sbb spawn: both --cli-args forms reach spawnBrain unchanged', async () => {
  const forms = [
    ['--cli-args', '--permission-mode bypassPermissions'],
    ['--cli-args=--permission-mode bypassPermissions'],
  ];
  for (const form of forms) {
    let input;
    const deps = {
      spawnBrain: async (received) => {
        input = received;
        return { brain: { id: 'SMS-1', name: 'ios', coord: '24:3.4' } };
      },
    };
    const { result } = await captureLog(() => run(
      ['--name', 'ios', '--account', 'a', '--cli', 'claude', ...form],
      deps,
    ));
    assert.equal(result, 0, form.join(' '));
    assert.equal(input.extraArgs, '--permission-mode bypassPermissions', form.join(' '));
  }
});

test('sbb spawn: a missing --cli-args value is a usage error, not a silent empty', async () => {
  const { result } = await captureLog(() => run(
    ['--name', 'ios', '--account', 'a', '--cli', 'claude', '--cli-args', '--force'],
    { spawnBrain: async () => { throw new Error('must not run'); } },
  ));
  assert.equal(result, 2);
});

test('sbb spawn: the help text shows the quoted --cli-args form', async () => {
  const { lines, result } = await captureLog(() => run(['--help']));
  assert.equal(result, 0);
  const text = lines.join('\n');
  assert.match(text, /--cli-args="<extra>"/);
  assert.match(text, /--permission-mode bypassPermissions/);
});

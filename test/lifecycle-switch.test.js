// switch.js + cli/switch.js: focus a live pane, report a gone pane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { switchTo } from '../src/lifecycle/switch.js';
import { run } from '../src/cli/switch.js';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const BRAIN = { id: 'SMS-0012', name: 'ios', role: 'sub', parent: 'SMS-0007', account: 'a', cli: 'claude', paneId: '%30', cwd: '/tmp', uuid: '3f1c9a2e-0d4b-4f7a-9c1e-5b2d8a6f0c33' };

test('switchTo: selects the pane and switches the client only when it is elsewhere', async () => {
  const tmuxApi = createFakeTmux({ clientSession: '25' });
  const result = await switchTo(BRAIN, { tmuxApi });
  assert.equal(result.paneId, '%30');
  assert.equal(result.coord, '24:3.4');
  assert.equal(result.session, '24');
  assert.deepEqual(
    tmuxApi.calls.filter((c) => Array.isArray(c) && c[0] === 'switch-client'),
    [['switch-client', '-t', '24']],
  );
  assert.deepEqual(tmuxApi.calls.filter((c) => c[0] === 'select-pane'), [['select-pane', '%30']]);
});

test('switchTo: an already-attached client is not switched again', async () => {
  const tmuxApi = createFakeTmux({ clientSession: '24' });
  await switchTo(BRAIN, { tmuxApi });
  assert.equal(tmuxApi.calls.filter((c) => Array.isArray(c) && c[0] === 'switch-client').length, 0);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 1);
});

test('switchTo: no client (outside tmux) still selects the pane', async () => {
  const tmuxApi = createFakeTmux();
  const result = await switchTo(BRAIN, { tmuxApi });
  assert.equal(result.client, null);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 1);
});

test('switchTo: a pane that no longer exists reports gone, never a guess', async () => {
  const tmuxApi = createFakeTmux({ panes: [] });
  const result = await switchTo(BRAIN, { tmuxApi });
  assert.equal(result.gone, true);
  assert.equal(result.brain.id, 'SMS-0012');
  assert.match(result.detail, /%30 is gone/);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 0);
});

test('switchTo: an unknown ref is blocked, not silently ignored', async () => {
  const result = await switchTo('nope', { getBrainFn: () => undefined });
  assert.deepEqual(result.blocked, { reason: 'target_not_found', detail: 'unknown brain "nope"' });
});

test('cli switch: prints the coord and exits 0', async () => {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(line);
  try {
    const code = await run(['ios'], {
      switchTo: async () => ({ brain: BRAIN, paneId: '%30', coord: '24:3.4', session: '24' }),
    });
    assert.equal(code, 0);
    assert.deepEqual(logged, ['switched SMS-0012 ios 24:3.4']);
  } finally {
    console.log = original;
  }
});

test('cli switch: a gone pane exits 4 and says why the record was not rewritten', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', paneId: '%29' });
    writeBrain({ id: 'SMS-0012', name: 'ios', role: 'sub', parent: 'SMS-0007', paneId: '%30' });
    const code = await run(['ios'], {
      switchTo: async () => ({ gone: true, brain: BRAIN, detail: 'pane %30 is gone' }),
    });
    assert.equal(code, 4);
    assert.match(errors[0], /brain SMS-0012 ios pane %30 is gone/);
    // docs/spec/lifecycle.md asks for paneId:null; validateBrain rejects it, and the
    // command reports the real validator message instead of writing an invalid record.
    assert.match(errors[1], /cannot mark paneId=null: invalid paneId/);
  } finally {
    console.error = original;
    restore();
  }
});

// switch.js + cli/switch.js: focus a live pane, move only the caller's own tmux client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callerTty, switchTo } from '../src/lifecycle/switch.js';
import { run } from '../src/cli/switch.js';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import { getBrain } from '../src/registry/brains.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const BRAIN = { id: 'SMS-0012', name: 'ios', role: 'sub', parent: 'SMS-0007', account: 'a', cli: 'claude', paneId: '%30', cwd: '/tmp', uuid: '3f1c9a2e-0d4b-4f7a-9c1e-5b2d8a6f0c33', createdAt: 1757000000000, origin: 'adopted' };
const MINE = '/dev/ttys004';
const THEIRS = '/dev/ttys009';

/** @param {any[]} calls */
function switchCalls(calls) {
  return calls.filter((c) => Array.isArray(c) && c[0] === 'switch-client');
}

test('switchTo: moves the caller\'s own client, never another one', async () => {
  const tmuxApi = createFakeTmux({ clients: [{ tty: THEIRS, session: '24' }, { tty: MINE, session: '25' }] });
  const result = await switchTo(BRAIN, { tmuxApi, callerTty: async () => MINE });

  assert.equal(result.paneId, '%30');
  assert.equal(result.coord, '24:3.4');
  assert.equal(result.session, '24');
  assert.equal(result.client, MINE);
  assert.equal(result.attach, undefined);
  assert.deepEqual(switchCalls(tmuxApi.calls), [['switch-client', '-c', MINE, '-t', '24']]);
  assert.deepEqual(tmuxApi.calls.filter((c) => c[0] === 'select-pane'), [['select-pane', '%30']]);
});

test('switchTo: a caller tty that owns no client moves nothing and prints the hint', async () => {
  const tmuxApi = createFakeTmux({ clients: [{ tty: THEIRS, session: '25' }] });
  const result = await switchTo(BRAIN, { tmuxApi, callerTty: async () => MINE });

  assert.equal(result.client, null);
  assert.equal(result.attach, 'attach: tmux switch-client -t 24');
  assert.deepEqual(switchCalls(tmuxApi.calls), [], 'the user\'s client is left where it is');
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 1);
});

test('switchTo: no tty at all moves nothing and prints the hint', async () => {
  const tmuxApi = createFakeTmux({ clients: [{ tty: THEIRS, session: '25' }] });
  const result = await switchTo(BRAIN, { tmuxApi, callerTty: async () => undefined });

  assert.equal(result.client, null);
  assert.equal(result.attach, 'attach: tmux switch-client -t 24');
  assert.deepEqual(switchCalls(tmuxApi.calls), []);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 1);
});

test('switchTo: a caller already on the target session is not switched again', async () => {
  const tmuxApi = createFakeTmux({ clients: [{ tty: MINE, session: '24' }] });
  const result = await switchTo(BRAIN, { tmuxApi, callerTty: async () => MINE });

  assert.equal(result.client, MINE);
  assert.equal(result.attach, undefined);
  assert.deepEqual(switchCalls(tmuxApi.calls), []);
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 1);
});

test('switchTo: a failing list-clients is blocked, not silently ignored', async () => {
  const tmuxApi = createFakeTmux({ failListClients: true });
  const result = await switchTo(BRAIN, { tmuxApi, callerTty: async () => MINE });
  assert.deepEqual(result.blocked, { reason: 'tmux_failed', detail: 'cannot list clients: no server running' });
  assert.equal(tmuxApi.calls.filter((c) => c[0] === 'select-pane').length, 0);
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

test('callerTty: the stdin/stdout tty wins, then $SSH_TTY, then the tty command', async () => {
  assert.equal(
    await callerTty({ isatty: (fd) => fd === 1, readlink: (path) => (path === '/dev/fd/1' ? MINE : '/dev/null'), env: {} }),
    MINE,
  );
  assert.equal(
    await callerTty({ isatty: () => false, env: { SSH_TTY: '/dev/pts/2' }, exec: async () => ({ stdout: '' }) }),
    '/dev/pts/2',
  );
  assert.equal(
    await callerTty({ isatty: () => false, env: {}, exec: async (file, args) => {
      assert.equal(file, 'tty');
      assert.deepEqual(args, []);
      return { stdout: '/dev/ttys010\n' };
    } }),
    '/dev/ttys010',
  );
  assert.equal(
    await callerTty({ isatty: () => false, env: {}, exec: async () => ({ stdout: 'not a tty\n' }) }),
    undefined,
  );
  assert.equal(
    await callerTty({ isatty: () => false, env: {}, exec: async () => { throw new Error('exit 1'); } }),
    undefined,
  );
  assert.equal(
    await callerTty({ isatty: (fd) => fd === 1, readlink: () => { throw new Error('ENOENT'); }, env: { SSH_TTY: '' }, exec: async () => ({ stdout: 'not a tty' }) }),
    undefined,
  );
});

test('cli switch: prints the coord and, without a client, the attach hint', async () => {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(line);
  try {
    assert.equal(await run(['ios'], {
      switchTo: async () => ({ brain: BRAIN, paneId: '%30', coord: '24:3.4', session: '24', client: MINE }),
    }), 0);
    assert.deepEqual(logged, ['switched SMS-0012 ios 24:3.4']);
    logged.length = 0;
    assert.equal(await run(['ios'], {
      switchTo: async () => ({ brain: BRAIN, paneId: '%30', coord: '24:3.4', session: '24', client: null, attach: 'attach: tmux switch-client -t 24' }),
    }), 0);
    assert.deepEqual(logged, ['switched SMS-0012 ios 24:3.4', 'attach: tmux switch-client -t 24']);
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
    writeBrain({ id: 'SMS-0012', name: 'ios', role: 'sub', parent: 'SMS-0007', paneId: '%30', uuid: BRAIN.uuid });
    const code = await run(['ios'], {
      switchTo: async () => ({ gone: true, brain: BRAIN, detail: 'pane %30 is gone' }),
    });
    assert.equal(code, 4);
    assert.match(errors[0], /brain SMS-0012 ios pane %30 is gone/);
    // docs/spec/lifecycle.md: the gone pane is persisted as paneId:null, so `sbb ls` can
    // report `gone` instead of a stale coordinate.
    assert.match(errors[1], /record marked paneId=null/);
    assert.equal(getBrain('SMS-0012').paneId, null, 'the record no longer names a live pane');
  } finally {
    console.error = original;
    restore();
  }
});

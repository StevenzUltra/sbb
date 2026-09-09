// Go-to-terminal: which client may be moved, and what happens when the user has none.
// The osascript opener is always stubbed here; no window is ever opened by a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeTmux } from './fixtures/lifecycle/fake-tmux.js';
import {
  TERMINALS,
  attachCommand,
  goToTerminal,
  humanClients,
  openTerminal,
  readTerminalPreference,
  shellQuote,
} from '../src/ui/switch.js';

const BRAIN = { id: 'b1', name: 'one', paneId: '%1', session: 'work' };

/** @param {{ panes?: any[], clients?: any[] }} [opts] */
function makeHost(opts = {}) {
  const api = createFakeTmux({
    paneId: '%1',
    panes: opts.panes ?? [{ paneId: '%1', session: 'work', windowId: '@1', coord: 'work:0.0', command: 'zsh' }],
    clients: opts.clients ?? [],
  });
  api.switchClient = async (tty, session) => {
    api.calls.push(['switch-client', tty, session]);
  };
  return api;
}

/** Never read the user's real ~/.sbb/config.json unless a test asks for it. */
const NO_CONFIG = { readFile: () => { throw new Error('no config'); } };

/** @param {Record<string, any>} [extra] */
function osascriptStub(extra = {}) {
  /** @type {any[]} */
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run, ...extra };
}

test('shellQuote leaves simple tokens alone and quotes the rest', () => {
  assert.equal(shellQuote('work'), 'work');
  assert.equal(shellQuote('-L'), '-L');
  assert.equal(shellQuote('/tmp/a-b_c.d'), '/tmp/a-b_c.d');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote(''), "''");
});

test('attachCommand keeps the private-server args and quotes the session', () => {
  assert.equal(attachCommand({ session: 'work' }), 'tmux attach -t work');
  assert.equal(attachCommand({ session: 'work', args: ['-L', 'sbb-h1'] }), 'tmux -L sbb-h1 attach -t work');
  assert.equal(attachCommand({ session: 'a b', args: ['-S', '/tmp/s'] }), "tmux -S /tmp/s attach -t 'a b'");
  assert.equal(attachCommand({ session: 'work', args: [undefined, ''] }), 'tmux attach -t work');
});

test('readTerminalPreference reads the raw config and ignores unknown values', () => {
  const read = (body) => readTerminalPreference({ dir: '/tmp', readFile: () => body });
  assert.equal(read('{"terminal":"ghostty"}'), 'ghostty');
  assert.equal(read('{"terminal":"iTerm2"}'), 'iterm2');
  assert.equal(read('{"terminal":"kitty"}'), undefined);
  assert.equal(read('{"policy":{"terminal":"ghostty"}}'), undefined);
  assert.equal(read('not json'), undefined);
  assert.equal(readTerminalPreference({ dir: '/tmp', readFile: () => { throw new Error('ENOENT'); } }), undefined);
});

test('humanClients drops control clients and ttys running sbb', async () => {
  const clients = [
    { tty: '/dev/ttys001', session: 'work' },
    { tty: '', session: 'work', controlMode: true },
    { tty: '/dev/ttys002', session: 'work' },
    { tty: '/dev/ttys003', session: 'other' },
  ];
  const ps = async () => ({
    stdout: [
      'ttys001  node /Users/steven/developer/sbb/bin/sbb.js ui',
      'ttys002  -zsh',
      'ttys003  -zsh',
      'ttys004  claude',
    ].join('\n'),
  });
  const humans = await humanClients({ listClients: async () => clients, ps });
  assert.deepEqual(humans, [{ tty: '/dev/ttys002', session: 'work' }, { tty: '/dev/ttys003', session: 'other' }]);
});

test('humanClients skips the ps call when no candidate client exists', async () => {
  let called = false;
  const humans = await humanClients({
    listClients: async () => [{ tty: '', session: 'work', controlMode: true }],
    ps: async () => {
      called = true;
      return { stdout: '' };
    },
  });
  assert.deepEqual(humans, []);
  assert.equal(called, false);
});

test('openTerminal refuses unknown or uninstalled terminals', async () => {
  const unknown = await openTerminal({ session: 'work', terminal: 'kitty', deps: { installed: () => true } });
  assert.equal(unknown.opened, false);
  assert.match(unknown.detail, /unknown terminal/);
  const missing = await openTerminal({ session: 'work', terminal: 'ghostty', deps: { installed: () => false } });
  assert.equal(missing.opened, false);
  assert.match(missing.detail, /Ghostty\.app is not installed/);
});

test('openTerminal drives Ghostty and iTerm2 with the attach command', async () => {
  for (const [terminal, app, marker] of [['ghostty', 'Ghostty', 'send key "enter"'], ['iterm2', 'iTerm2', 'write text']]) {
    const stub = osascriptStub();
    const result = await openTerminal({
      session: 'work',
      terminal,
      deps: { installed: () => true, run: stub.run, tmuxArgs: ['-L', 'sbb-h1'] },
    });
    assert.equal(result.opened, true, terminal);
    assert.equal(result.terminal, terminal);
    assert.equal(result.command, 'tmux -L sbb-h1 attach -t work');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].file, 'osascript');
    const script = stub.calls[0].args.join('\n');
    assert.match(script, new RegExp(`tell application "${app}"`));
    assert.match(script, /activate/);
    assert.ok(script.includes(marker), script);
    assert.match(script, /tmux -L sbb-h1 attach -t work/);
  }
});

test('openTerminal reports an osascript failure instead of pretending it opened', async () => {
  const result = await openTerminal({
    session: 'work',
    terminal: 'ghostty',
    deps: { installed: () => true, run: async () => ({ code: 1, stdout: '', stderr: 'not authorised' }) },
  });
  assert.equal(result.opened, false);
  assert.equal(result.detail, 'not authorised');
});

test('goToTerminal needs a brain and a live pane', async () => {
  assert.equal((await goToTerminal({ brain: null })).reason, 'target_not_found');
  const goneHost = {
    resolvePaneId: async () => { throw new Error("can't find pane %99"); },
    listPanes: async () => [],
  };
  const gone = await goToTerminal({ brain: { id: 'x', paneId: '%99' }, deps: { host: goneHost } });
  assert.equal(gone.switched, false);
  assert.equal(gone.reason, 'pane_gone');
});

test('goToTerminal moves the one human client and selects the pane', async () => {
  const host = makeHost({ clients: [{ tty: '/dev/ttys001', session: 'other' }] });
  const result = await goToTerminal({
    brain: BRAIN,
    deps: { host, listClients: async () => [{ tty: '/dev/ttys001', session: 'other' }], ps: async () => ({ stdout: 'ttys001  -zsh' }) },
  });
  assert.equal(result.switched, true);
  assert.equal(result.paneId, '%1');
  assert.deepEqual(host.calls.filter((c) => c[0] === 'switch-client'), [['switch-client', '/dev/ttys001', 'work']]);
  assert.deepEqual(host.calls.filter((c) => c[0] === 'select-pane'), [['select-pane', '%1']]);
});

test('goToTerminal does not move a client already on the session', async () => {
  const host = makeHost({ clients: [{ tty: '/dev/ttys001', session: 'work' }] });
  const result = await goToTerminal({
    brain: BRAIN,
    deps: { host, listClients: async () => [{ tty: '/dev/ttys001', session: 'work' }], ps: async () => ({ stdout: 'ttys001  -zsh' }) },
  });
  assert.equal(result.switched, true);
  assert.equal(host.calls.filter((c) => c[0] === 'switch-client').length, 0);
  assert.deepEqual(host.calls.filter((c) => c[0] === 'select-pane'), [['select-pane', '%1']]);
});

test('goToTerminal refuses to choose between several human clients', async () => {
  const clients = [
    { tty: '/dev/ttys001', session: 'work' },
    { tty: '/dev/ttys002', session: 'other' },
  ];
  const host = makeHost({ clients });
  const result = await goToTerminal({
    brain: BRAIN,
    deps: { host, listClients: async () => clients, ps: async () => ({ stdout: 'ttys001  -zsh\nttys002  -zsh' }) },
  });
  assert.equal(result.switched, false);
  assert.deepEqual(result.clients, clients);
  assert.equal(host.calls.filter((c) => c[0] === 'select-pane').length, 0);
});

test('goToTerminal reports tmux_failed when clients cannot be listed', async () => {
  const host = makeHost();
  const result = await goToTerminal({
    brain: BRAIN,
    deps: { host, listClients: async () => { throw new Error('no server'); }, ...NO_CONFIG },
  });
  assert.equal(result.switched, false);
  assert.equal(result.reason, 'tmux_failed');
});

test('goToTerminal opens a terminal when no human client exists, without touching any client', async () => {
  const host = makeHost({ clients: [] });
  const stub = osascriptStub();
  const result = await goToTerminal({
    brain: BRAIN,
    deps: {
      host,
      listClients: async () => [],
      ps: async () => ({ stdout: '' }),
      platform: 'darwin',
      installed: () => true,
      run: stub.run,
      tmuxArgs: ['-L', 'sbb-h1'],
      ...NO_CONFIG,
    },
  });
  assert.equal(result.switched, false);
  assert.equal(result.opened, 'ghostty');
  assert.equal(result.command, 'tmux -L sbb-h1 attach -t work');
  assert.equal(stub.calls.length, 1);
  assert.equal(host.calls.filter((c) => c[0] === 'select-pane').length, 0);
  assert.equal(host.calls.filter((c) => c[0] === 'switch-client').length, 0);
});

test('goToTerminal honours the configured terminal and the installed order', async () => {
  const withConfig = await goToTerminal({
    brain: BRAIN,
    deps: {
      host: makeHost(),
      listClients: async () => [],
      platform: 'darwin',
      installed: () => true,
      run: osascriptStub().run,
      readFile: () => '{"terminal":"iterm2"}',
    },
  });
  assert.equal(withConfig.opened, 'iterm2');
  assert.deepEqual(TERMINALS, ['ghostty', 'iterm2']);
});

test('goToTerminal reports no_client off macOS and no_terminal with nothing installed', async () => {
  const base = { host: makeHost(), listClients: async () => [], ...NO_CONFIG };
  const linux = await goToTerminal({ brain: BRAIN, deps: { ...base, platform: 'linux' } });
  assert.equal(linux.reason, 'no_client');
  const bare = await goToTerminal({ brain: BRAIN, deps: { ...base, platform: 'darwin', installed: () => false } });
  assert.equal(bare.reason, 'no_terminal');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainsDir } from '../src/lib/paths.js';
import { ResolveError, resolve } from '../src/registry/resolve.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const ACCOUNTS = [
  { name: 'a', baseDir: '/x/.ai-account-a', claudeDir: '/x/.ai-account-a/claude', codexDir: '/x/.ai-account-a/codex' },
  { name: 'b', baseDir: '/x/.ai-account-b', claudeDir: '/x/.ai-account-b/claude', codexDir: '/x/.ai-account-b/codex' },
];

/** @param {Record<string, any>} over */
function row(over = {}) {
  return {
    brain: null, brainId: null, role: null, parent: null, account: 'a', cli: 'claude', model: null,
    status: 'idle', where: '24:3.4', name: 'lead', cwd: '/Users/dev/proj',
    paneId: '%30', coord: '24:3.4', pid: 1234, threadId: null, hasRollout: null,
    threadUncertain: false, sock: '/tmp/cc-socks/1234.sock', keyFile: '/tmp/1234.key',
    source: 'pane', claude: { pid: 1234, sock: '/tmp/cc-socks/1234.sock' }, codex: undefined,
    ...over,
  };
}

const ROWS = [
  row(),
  row({ account: 'b', paneId: '%73', coord: '24:3.7', name: 'h3', pid: 4321 }),
  row({ account: 'b', cli: 'codex', paneId: '%14', coord: '24:1.1', name: 'Reply with PONG', pid: 9003, claude: undefined, codex: { id: 't1', name: 'Reply with PONG', hasRollout: true } }),
  row({ account: 'b', cli: 'agy', paneId: '%29', coord: '24:3.2', name: null, pid: 9005, claude: undefined }),
];

/** @param {{ resolvePaneId?: Function }} [over] */
function deps(over = {}) {
  return { rows: ROWS, accounts: ACCOUNTS, resolvePaneId: async () => '%30', ...over };
}

test('resolve: a brain name re-resolves the pane and keeps the live row data', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: `${home}/.sbb` });
  try {
    writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead', model: 'claude-fable-5-1' });
    const target = await resolve('lead', deps());
    assert.equal(target.brain, 'lead');
    assert.equal(target.brainId, 'TST-0001');
    assert.equal(target.account, 'a');
    assert.equal(target.cli, 'claude');
    assert.equal(target.paneId, '%30');
    assert.equal(target.coord, '24:3.4');
    assert.equal(target.address, 'lead');
    assert.ok(target.claude, 'the Claude session is refreshed');
  } finally {
    restore();
  }
});

test('resolve: a brain whose pane is gone is target_not_found, not a guess', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: `${home}/.sbb` });
  try {
    writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead' });
    await assert.rejects(
      () => resolve('lead', deps({ resolvePaneId: async () => { throw new Error('no such pane'); } })),
      (err) => err instanceof ResolveError && err.reason === 'target_not_found',
    );
  } finally {
    restore();
  }
});

test('resolve: an unknown brain is target_not_found', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: `${home}/.sbb` });
  try {
    await assert.rejects(() => resolve('ghost', deps()), (err) => err.reason === 'target_not_found');
  } finally {
    restore();
  }
});

test('resolve: a brain id resolves like a name, case-insensitively and with #', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: `${home}/.sbb` });
  try {
    writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead' });
    for (const address of ['#TST-0001', 'TST-0001', 'tst-0001', '#tst-0001']) {
      const target = await resolve(address, deps());
      assert.equal(target.brainId, 'TST-0001', address);
      assert.equal(target.brain, 'lead', address);
      assert.equal(target.paneId, '%30', address);
    }
    await assert.rejects(() => resolve('#TST-9999', deps()), (err) => err instanceof ResolveError && err.reason === 'target_not_found');
    await assert.rejects(() => resolve('#SMS-1', deps()), (err) => err.reason === 'target_not_found');
  } finally {
    restore();
  }
});

test('resolve: a duplicated id or uuid is a hard error, not a coin flip', async () => {
  const home = tempDir();
  const restore = withEnv({ SBB_HOME_OVERRIDE: home, SBB_DIR: `${home}/.sbb` });
  try {
    const brain = writeBrain({ id: 'TST-0001', uuid: 'uuid-lead', name: 'lead' });
    writeFileSync(join(brainsDir(), 'TST-0001b.json'), `${JSON.stringify({ ...brain, name: 'lead-two', paneId: '%31' })}\n`);
    await assert.rejects(
      () => resolve('#TST-0001', deps()),
      (err) => err instanceof ResolveError && err.reason === 'duplicate_identity',
    );
    await assert.rejects(
      () => resolve('lead', deps()),
      (err) => err.reason === 'duplicate_identity',
      'the name path refuses too',
    );
  } finally {
    restore();
  }
});

test('resolve: <account>/<cli>:<name>', async () => {
  const target = await resolve('a/claude:lead', deps());
  assert.equal(target.account, 'a');
  assert.equal(target.cli, 'claude');
  assert.equal(target.paneId, '%30');

  const codex = await resolve('b/codex:Reply with PONG', deps());
  assert.equal(codex.cli, 'codex');
  assert.equal(codex.paneId, '%14');
  assert.ok(codex.codex, 'the Codex thread is refreshed');

  await assert.rejects(() => resolve('b/claude:lead', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('a/claude:no-such-name', deps()), (err) => err.reason === 'target_not_found');
});

test('resolve: a duplicate name is target_ambiguous with the coordinates listed', async () => {
  const rows = [
    row(),
    row({ paneId: '%31', coord: '24:3.5', pid: 1235 }),
  ];
  await assert.rejects(
    () => resolve('a/claude:lead', { rows, accounts: ACCOUNTS, resolvePaneId: async () => '%30' }),
    (err) => err instanceof ResolveError && err.reason === 'target_ambiguous' && err.detail === '24:3.4, 24:3.5',
  );
});

test('resolve: <account>/<cli>:<%pane> checks account and cli against the roster', async () => {
  const ok = await resolve('a/claude:%30', deps());
  assert.equal(ok.paneId, '%30');

  await assert.rejects(() => resolve('b/claude:%30', deps()), (err) => err.reason === 'target_not_found' && /account/.test(err.message));
  await assert.rejects(() => resolve('a/codex:%30', deps()), (err) => err.reason === 'target_not_found' && /is claude, not codex/.test(err.message));
  await assert.rejects(() => resolve('a/claude:%99', deps()), (err) => err.reason === 'target_not_found');
});

test('resolve: bare pane ids and coordinates infer account and cli', async () => {
  const pane = await resolve('%29', deps());
  assert.equal(pane.cli, 'agy');
  assert.equal(pane.account, 'b');

  const coord = await resolve('24:1.1', deps());
  assert.equal(coord.cli, 'codex');
  assert.equal(coord.paneId, '%14');

  await assert.rejects(() => resolve('%99', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('24:9.9', deps()), (err) => err.reason === 'target_not_found');
});

test('resolve: unknown account, unknown cli and unparseable addresses fail closed', async () => {
  await assert.rejects(() => resolve('z/claude:lead', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('a/gpt:lead', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('a/lead', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('', deps()), (err) => err.reason === 'target_not_found');
  await assert.rejects(() => resolve('   ', deps()), (err) => err.reason === 'target_not_found');
});

test('resolve: an agy address is a pane address; agy has no name registry', async () => {
  const target = await resolve('b/agy:%29', deps());
  assert.equal(target.cli, 'agy');
  await assert.rejects(() => resolve('b/agy:something', deps()), (err) => err.reason === 'target_not_found');
});

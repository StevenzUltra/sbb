// spawn.js: validation, quota floor, pane setup, readiness and the parent notification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listBrains } from '../src/registry/brains.js';
import { firstMessageText, spawnBrain, checkQuotaFloor, quotaFloor } from '../src/lifecycle/spawn.js';
import { createTmuxKeys } from '../src/transports/tmux-keys.js';
import { probeOf } from '../src/transports/cli-profiles.js';
import { createFakeTmux, screen, tmuxCommands, typedLiterals } from './fixtures/lifecycle/fake-tmux.js';
import { tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

const ACCOUNTS = [{
  name: 'a',
  baseDir: '/tmp/home/.ai-account-a',
  claudeDir: '/tmp/home/.ai-account-a/claude',
  codexDir: '/tmp/home/.ai-account-a/codex',
  kimiDir: '/tmp/home/.ai-account-a/kimi',
}];
const PARENT = { id: 'SMS-0007', name: 'lead', role: 'main', parent: null, account: 'a', cli: 'claude' };

/** A sub brain needs its parent on disk: saveBrain validates that the record exists. */
function seedParent() {
  writeBrain({ id: 'SMS-0007', name: 'lead', role: 'main', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' });
}

/** @param {Record<string, any>} [over] */
function baseDeps(over = {}) {
  const tmuxApi = createFakeTmux();
  const delivered = [];
  const deps = {
    accounts: ACCOUNTS,
    listBrains: () => [],
    getBrain: (ref) => (ref === 'lead' ? PARENT : undefined),
    which: async () => true,
    readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 50 }],
    allocateId: () => 'SMS-0042',
    newUuid: () => 'uuid-42',
    tmuxApi,
    awaitReady: async () => ({ ready: true, session: { pid: 4242 } }),
    resolve: async () => ({ address: 'lead', account: 'a', cli: 'claude', paneId: '%29', coord: '24:3.3' }),
    // No real inbox in unit tests; a test that cares injects its own.
    openInbox: async () => undefined,
    deliver: async (input) => {
      delivered.push(input);
      return { receipt: { status: 'delivered', via: 'uds', msgId: 'm1', elapsedMs: 1 } };
    },
    config: {},
    tmuxApiRef: tmuxApi,
    delivered,
    ...over,
  };
  return deps;
}

/** @param {Record<string, any>} [over] */
function spawnInput(over = {}) {
  return {
    name: 'ios',
    role: 'sub',
    parent: 'lead',
    account: 'a',
    cli: 'claude',
    model: 'claude-haiku-4-5-20251001',
    cwd: '/tmp/proj',
    ...over,
  };
}

test('spawnBrain: happy path registers the brain and notifies the parent', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    const inbox = { sockPath: '/tmp/cc-socks/999.sock', close: async () => {} };
    const deps = baseDeps({ openInbox: async () => inbox });
    const result = await spawnBrain(spawnInput(), deps);

    assert.ok(result.brain, JSON.stringify(result));
    assert.deepEqual(
      { id: result.brain.id, name: result.brain.name, role: result.brain.role, parent: result.brain.parent, origin: result.brain.origin, pid: result.brain.pid, coord: result.brain.coord },
      { id: 'SMS-0042', name: 'ios', role: 'sub', parent: 'SMS-0007', origin: 'spawned', pid: 4242, coord: '24:3.4' },
    );
    const record = JSON.parse(readFileSync(join(dir, 'brains', 'SMS-0042.json'), 'utf8'));
    assert.equal(record.uuid, 'uuid-42');
    assert.equal(record.account, 'a');

    const options = tmuxCommands(deps.tmuxApiRef).filter((c) => c[0] === 'set-option').map((c) => c.slice(4));
    assert.deepEqual(options, [
      ['@ai_account', 'a'],
      ['@sbb_brain', 'SMS-0042'],
      ['@codex_home', '/tmp/home/.ai-account-a/codex'],
    ]);
    const created = tmuxCommands(deps.tmuxApiRef)[0];
    assert.deepEqual(created.slice(0, 9), ['new-window', '-t', '=sbb:', '-n', 'ai-a', '-c', '/tmp/proj', '-P', '-F'], 'the pane goes to the sbb session');
    assert.deepEqual(created.slice(9, 12), ['#{pane_id}', 'sh', '-c'], 'the CLI is the pane command');
    assert.match(created[12], /^exec env /);
    assert.match(created[12], /--append-system-prompt-file/);
    assert.match(created[12], /SMS-0042\.md/);
    assert.equal(
      deps.tmuxApiRef.calls.filter((c) => Array.isArray(c) && c[0].startsWith('send-')).length,
      0,
      'nothing is typed into the pane',
    );

    assert.equal(deps.delivered.length, 1);
    assert.equal(deps.delivered[0].body, '已上线，上级 lead');
    assert.equal(deps.delivered[0].identity.id, 'SMS-0042');
    assert.equal(deps.delivered[0].identity.role, '子脑');
    assert.equal(deps.delivered[0].inbox, inbox, 'the notification carries an inbox, so fromSock is set');
    assert.equal(result.notification.status, 'delivered');
  } finally {
    restore();
  }
});

test('spawnBrain: --split uses split-window in the caller window', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    const deps = baseDeps();
    await spawnBrain(spawnInput({ split: true }), deps);
    const created = tmuxCommands(deps.tmuxApiRef)[0];
    assert.deepEqual(created.slice(0, 5), ['split-window', '-c', '/tmp/proj', '-P', '-F']);
    assert.deepEqual(created.slice(5, 8), ['#{pane_id}', 'sh', '-c']);
  } finally {
    restore();
  }
});

test('spawnBrain: the brief always goes to ~/.sbb/briefs and the pane command only points at it', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    const deps = baseDeps();
    const result = await spawnBrain(spawnInput({ brief: 'x'.repeat(20000) }), deps);
    assert.equal(result.briefFile, join(dir, 'briefs', 'SMS-0042.md'));
    assert.equal(readFileSync(result.briefFile, 'utf8').length, 20001);
    const created = tmuxCommands(deps.tmuxApiRef)[0];
    assert.match(created[12], /SMS-0042\.md/);
    assert.ok(created[12].length < 4000, 'the pane command stays small');
  } finally {
    restore();
  }
});

test('spawnBrain: a failed readiness kills the pane and registers nothing', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const deps = baseDeps({ awaitReady: async () => ({ ready: false, reason: 'not_ready', detail: 'no session', screen: 'last screen lines' }) });
    const result = await spawnBrain(spawnInput(), deps);
    assert.equal(result.blocked.reason, 'not_ready');
    assert.match(result.blocked.detail, /no session/);
    assert.equal(result.screen, 'last screen lines');
    assert.ok(tmuxCommands(deps.tmuxApiRef).some((c) => c[0] === 'kill-pane'), 'the pane is cleaned up');
    assert.equal(existsSync(join(dir, 'brains', 'SMS-0042.json')), false);
    assert.equal(deps.delivered.length, 0);
  } finally {
    restore();
  }
});

test('spawnBrain: validation refusals are blocked, never guessed', async () => {
  const cases = [
    [{ name: 'BAD NAME' }, 'invalid_name'],
    [{ name: 'lead' }, 'duplicate_name'],
    [{ role: 'main', parent: 'lead' }, 'invalid_parent'],
    [{ parent: 'nope' }, 'unknown_parent'],
    [{ account: 'zz' }, 'unknown_account'],
    [{ cli: 'gpt' }, 'invalid_cli'],
  ];
  for (const [over, reason] of cases) {
    const deps = baseDeps({ listBrains: () => [{ id: 'SMS-0001', name: 'lead' }] });
    const result = await spawnBrain(spawnInput(over), deps);
    assert.equal(result.blocked?.reason, reason, `${JSON.stringify(over)} -> ${reason}`);
  }
});

test('spawnBrain: a missing CLI binary is blocked before any pane exists', async () => {
  const deps = baseDeps({ which: async () => false });
  const result = await spawnBrain(spawnInput(), deps);
  assert.equal(result.blocked.reason, 'cli_missing');
  assert.equal(tmuxCommands(deps.tmuxApiRef).length, 0);
});

test('spawnBrain: a tmux failure is blocked with the tmux error', async () => {
  const deps = baseDeps({ tmuxApi: createFakeTmux({ failNewWindow: true }) });
  deps.tmuxApiRef = deps.tmuxApi;
  const result = await spawnBrain(spawnInput(), deps);
  assert.equal(result.blocked.reason, 'tmux_failed');
  assert.match(result.blocked.detail, /no current session/);
});

test('spawnBrain: the quota floor blocks only a known shortfall', async () => {
  const short = baseDeps({ readQuota: async () => [{ account: 'a', window: 'weekly', remaining: 4 }] });
  const blocked = await spawnBrain(spawnInput(), short);
  assert.equal(blocked.blocked.reason, 'quota');
  assert.match(blocked.blocked.detail, /4% is below floor 10%/);

  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    const unknown = baseDeps({ readQuota: async () => [{ account: 'a', window: 'weekly', remaining: null, note: 'unavailable' }] });
    assert.ok((await spawnBrain(spawnInput(), unknown)).brain, 'unknown never blocks');

    let read = false;
    const forced = baseDeps({ readQuota: async () => { read = true; return []; } });
    const result = await spawnBrain(spawnInput({ force: true }), forced);
    assert.ok(result.brain);
    assert.equal(read, false, '--force skips the quota read');
    assert.equal(result.quota, 'skipped (--force)');
  } finally {
    restore();
  }
});

test('spawnBrain: codex in an untrusted cwd is blocked before any pane exists', async () => {
  let quotaRead = false;
  const deps = baseDeps({
    readQuota: async () => { quotaRead = true; return []; },
    readCodexTrust: () => ({ configPath: '/tmp/home/.ai-account-a/codex/config.toml', found: true, level: 'untrusted', trusted: false }),
  });
  const result = await spawnBrain(spawnInput({ cli: 'codex' }), deps);
  assert.equal(result.blocked.reason, 'codex_untrusted_cwd');
  assert.match(result.blocked.detail, /codex 未信任 \/tmp\/proj/);
  assert.match(result.blocked.detail, /trust_level=untrusted/);
  assert.match(result.blocked.detail, /手动信任/);
  assert.equal(tmuxCommands(deps.tmuxApiRef).length, 0, 'no pane is created');
  assert.equal(quotaRead, false, 'the trust check runs before the quota read');
  assert.equal(deps.delivered.length, 0);
});

test('spawnBrain: codex in a trusted cwd starts and hands the brief to readiness', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    let readyInput;
    const deps = baseDeps({
      readCodexTrust: ({ cwd }) => {
        assert.equal(cwd, '/tmp/proj');
        return { configPath: '/tmp/home/.ai-account-a/codex/config.toml', found: true, level: 'trusted', trusted: true };
      },
      awaitReady: async (input) => { readyInput = input; return { ready: true, session: { pid: 4242 } }; },
    });
    const result = await spawnBrain(spawnInput({ cli: 'codex' }), deps);
    assert.ok(result.brain, JSON.stringify(result));
    assert.equal(result.brain.cli, 'codex');
    assert.equal(readyInput.cli, 'codex');
    assert.match(readyInput.brief, /你是 ios#SMS-0042/);
    assert.match(readyInput.brief, /不要再执行 `sbb adopt`/);
  } finally {
    restore();
  }
});

test('spawnBrain: a same-pane record is retired in favour of the spawn record', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    writeBrain({ id: 'SMS-0099', name: 'self-adopted', paneId: '%30', uuid: 'uuid-99' });
    writeBrain({ id: 'SMS-0098', name: 'other-pane', paneId: '%31', uuid: 'uuid-98' });
    const deps = baseDeps({ listBrains: () => listBrains() });
    const result = await spawnBrain(spawnInput(), deps);

    assert.deepEqual(result.retiredDuplicates, [{ id: 'SMS-0099', name: 'self-adopted' }]);
    assert.equal(existsSync(join(dir, 'brains', 'SMS-0099.json')), false);
    const retired = JSON.parse(readFileSync(join(dir, 'brains', '_retired', 'SMS-0099.json'), 'utf8'));
    assert.ok(retired.retiredAt, 'the extra record is retired, not deleted');
    assert.ok(existsSync(join(dir, 'brains', 'SMS-0042.json')), 'the spawn record wins');
    assert.ok(existsSync(join(dir, 'brains', 'SMS-0098.json')), 'another pane is untouched');
  } finally {
    restore();
  }
});

test('checkQuotaFloor: unknown rows and unknown windows never block', () => {
  assert.deepEqual(checkQuotaFloor({ account: 'a', floor: 10, rows: [] }), { ok: true, note: 'unknown' });
  assert.deepEqual(
    checkQuotaFloor({ account: 'a', floor: 10, rows: [{ account: 'a', window: 'session', remaining: 1 }] }),
    { ok: true, note: 'unknown' },
  );
  assert.equal(checkQuotaFloor({ account: 'a', floor: 10, rows: [{ account: 'a', window: 'weekly', remaining: 10 }] }).ok, true);
  assert.equal(checkQuotaFloor({ account: 'a', floor: 10, rows: [{ account: 'a', window: 'weekly', remaining: 9.9 }] }).ok, false);
});

test('quotaFloor: config default is 10, a configured value wins', () => {
  assert.equal(quotaFloor({}), 10);
  assert.equal(quotaFloor({ quota: { floorWeekly: 25 } }), 25);
  assert.equal(quotaFloor({ quota: { floorWeekly: 'nonsense' } }), 10);
});

test('firstMessageText: the brief collapses to the one line the typed channel carries', () => {
  assert.equal(firstMessageText('a\nb'), 'a b');
  assert.equal(firstMessageText('  '), undefined);
  assert.equal(firstMessageText(undefined), undefined);
});

test('spawnBrain: a CLI without a brief channel gets the brief as its first message', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const sent = [];
    const deps = baseDeps({
      sendFirstMessage: async (target, message) => {
        sent.push({ target, message });
        return { status: 'delivered', via: 'send-keys', msgId: message.msgId };
      },
    });
    const result = await spawnBrain(spawnInput({ cli: 'kimi', role: 'main', parent: undefined }), deps);
    assert.ok(result.brain, JSON.stringify(result));
    assert.equal(result.firstMessage.status, 'delivered');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.paneId, result.brain.paneId);
    assert.equal(sent[0].target.cli, 'kimi');
    assert.match(sent[0].message.text, /^你是 /);
    assert.equal(/\n/.test(sent[0].message.text), false, 'the typed channel carries one line');
  } finally { restore(); }
});

test('spawnBrain: a CLI that takes the brief on its argv is never typed into', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    seedParent();
    const deps = baseDeps({
      sendFirstMessage: async () => { throw new Error('must not be called for claude'); },
    });
    const result = await spawnBrain(spawnInput({ cli: 'claude' }), deps);
    assert.ok(result.brain, JSON.stringify(result));
    assert.equal(result.firstMessage, undefined);
  } finally { restore(); }
});

test('spawnBrain: the kimi first message goes through the typed transport and is verified', async () => {
  const dir = tempDir();
  const restore = withEnv({ SBB_DIR: dir });
  try {
    const brief = 'FIRST-LINE-OF-BRIEF reply with OK';
    const idle = screen('kimi-idle');
    const tmuxApi = createFakeTmux({
      panes: [{ paneId: '%30', session: '24', windowId: '@16', coord: '24:3.4', command: 'kimi' }],
      screens: [idle, `${probeOf(brief)}\n${idle}`],
    });
    const deps = baseDeps({
      tmuxApi,
      tmuxKeys: createTmuxKeys({ tmuxApi, sleep: async () => {}, settleMs: 50 }),
    });
    const result = await spawnBrain(
      spawnInput({ cli: 'kimi', role: 'main', parent: undefined, brief }),
      deps,
    );
    assert.ok(result.brain, JSON.stringify(result));
    assert.equal(result.firstMessage.status, 'delivered');
    assert.equal(result.firstMessage.via, 'send-keys');
    assert.deepEqual(typedLiterals(tmuxApi), [brief]);
  } finally { restore(); }
});

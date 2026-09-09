// Team channels: addresses, membership, the revised talk table, fan-out, the team log,
// read marks and the `--team` / `--teams` / `#channel` CLI surfaces. docs/spec/teams.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as askRun } from '../src/cli/ask.js';
import { run as collectRun } from '../src/cli/collect.js';
import { run as lsRun } from '../src/cli/ls.js';
import { run as tellRun } from '../src/cli/tell.js';
import {
  allChannels, channelForBrain, channelName, checkChannel, isChannelAddress,
  resolveChannel, teamMembers,
} from '../src/teams/channels.js';
import { channelRole, sendToChannel } from '../src/teams/fanout.js';
import { appendTeamLog, listTeamLogIds, readTeamLog, teamLogPath } from '../src/teams/log.js';
import { readMark, resetTeamMarks, unreadTeamLog, writeMark } from '../src/teams/marks.js';
import { check, teamOf } from '../src/policy/rules.js';
import { mergeConfig } from '../src/policy/config.js';
import { getBrain } from '../src/registry/brains.js';
import { readReceiptEntries } from '../src/registry/receipts.js';
import { writeInboxEntry } from '../src/registry/inbox.js';
import { ResolveError } from '../src/registry/resolve.js';
import { captureLog, tempDir, withEnv, writeBrain } from './fixtures/registry/helpers.js';

/** lead (main) + fe-a, be-a (its subs) and lead-b (main) + fe-b (its sub). */
function teamFixture() {
  writeBrain({ id: 'TST-0001', name: 'lead', role: 'main', parent: null, account: 'a' });
  writeBrain({ id: 'TST-0002', name: 'fe-a', role: 'sub', parent: 'TST-0001', account: 'a' });
  writeBrain({ id: 'TST-0003', name: 'be-a', role: 'sub', parent: 'TST-0001', account: 'b' });
  writeBrain({ id: 'TST-0004', name: 'lead-b', role: 'main', parent: null, account: 'b' });
  writeBrain({ id: 'TST-0005', name: 'fe-b', role: 'sub', parent: 'TST-0004', account: 'b' });
}

function sbbEnv(home) {
  return {
    SBB_HOME_OVERRIDE: home,
    SBB_DIR: join(home, '.sbb'),
    TMUX_PANE: undefined,
    SBB_FROM_MODE: undefined,
    SBB_FORCE: undefined,
  };
}

/** @param {string} id @param {string} name @param {'main'|'sub'} role @param {string|null} parent */
function row(id, name, role, parent, paneId = '%30') {
  return {
    brain: name, brainId: id, role, parent, account: 'a', cli: 'claude', model: null,
    status: 'idle', name, cwd: '/Users/dev/proj', paneId, coord: '24:3.7', pid: 4321,
    source: 'pane', where: '24:3.7',
  };
}

function fakeInbox(sockPath = '/tmp/cc-socks/9999.sock') {
  return { sockPath, closes: 0, on() {}, off() {}, async close() { this.closes += 1; } };
}

/** deps that keep the channel path entirely in memory but use the real team log and marks. */
function channelDeps(home, over = {}) {
  return {
    paneId: undefined,
    rows: [],
    startInbox: async () => fakeInbox(),
    closeInboxes: async () => {},
    resolve: async (ref) => ({
      address: ref, brain: getBrain(ref)?.name, brainId: ref, account: 'a', cli: 'claude',
      paneId: '%30', coord: '24:3.7', claude: { sock: `/tmp/cc-socks/${ref}.sock` },
    }),
    deliver: async (input) => ({
      text: `envelope ${input.msgId}`,
      receipt: { status: 'delivered', via: 'uds', msgId: input.msgId, elapsedMs: 1 },
    }),
    sbbDir: join(home, '.sbb'),
    ...over,
  };
}

test('channels: addresses, membership, #all is user-only', () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();

    assert.equal(channelName('#lead'), 'lead');
    assert.equal(channelName('  #LEAD '), 'lead');
    assert.equal(channelName('#all'), 'all');
    assert.equal(channelName('#TST-0001'), undefined, 'a brain id is not a channel');
    assert.equal(channelName('#'), undefined);
    assert.equal(channelName('lead'), undefined, 'a plain name is a brain, not a channel');
    assert.equal(isChannelAddress('#lead'), true);
    assert.equal(isChannelAddress('lead'), false);

    const lead = resolveChannel('#lead');
    assert.equal(lead.id, 'team:TST-0001');
    assert.equal(lead.kind, 'team');
    assert.equal(lead.postable, 'member');
    assert.deepEqual(lead.members.map((m) => m.id), ['TST-0001', 'TST-0002', 'TST-0003']);
    assert.deepEqual(teamMembers(getBrain('TST-0001')).map((m) => m.name), ['lead', 'fe-a', 'be-a'], 'sorted by id');

    const all = resolveChannel('#all');
    assert.equal(all.id, 'team:all');
    assert.equal(all.main, null);
    assert.equal(all.postable, 'user');
    assert.deepEqual(all.members.map((m) => m.id), ['TST-0001', 'TST-0004'], 'every main brain');

    assert.equal(channelForBrain('TST-0003').id, 'team:TST-0001', 'a sub resolves to its own team');
    assert.equal(channelForBrain('TST-0004').name, 'lead-b');
    assert.equal(channelForBrain('TST-9999'), null, 'unknown brain, no team');
    assert.deepEqual(allChannels().map((c) => c.name), ['lead', 'lead-b']);

    assert.throws(() => resolveChannel('#nope'), (err) => err instanceof ResolveError && err.reason === 'target_not_found');
    assert.throws(() => resolveChannel('nope'), (err) => err instanceof ResolveError && err.reason === 'not_a_channel');

    assert.deepEqual(checkChannel(lead, {}), { ok: true }, 'the user may post anywhere');
    assert.deepEqual(checkChannel(all, {}), { ok: true });
    assert.deepEqual(checkChannel(lead, { id: 'TST-0002' }), { ok: true }, 'a member may post');
    assert.deepEqual(checkChannel(lead, { id: 'TST-0005' }), { ok: false, detail: 'not_a_member' });
    assert.deepEqual(checkChannel(all, { id: 'TST-0001' }), { ok: false, detail: 'channel_user_only' });
  } finally {
    restore();
  }
});

test('talk table: same-team sub <-> sub is on, subsDirect false restores via-parent', () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    const v = (sender, target, config) => check(sender, target, config, { getBrain });
    const cfg = (over) => mergeConfig(over ?? {});

    assert.equal(teamOf('TST-0001', getBrain), 'TST-0001', 'a main is its own team');
    assert.equal(teamOf('TST-0002', getBrain), 'TST-0001');
    assert.equal(teamOf('TST-0005', getBrain), 'TST-0004');
    assert.equal(teamOf('TST-9999', getBrain), null);

    assert.deepEqual(v(getBrain('TST-0002'), getBrain('TST-0003'), cfg()), { ok: true }, 'same-team subs, default');
    assert.deepEqual(v(getBrain('TST-0003'), getBrain('TST-0002'), cfg()), { ok: true }, 'either direction');
    assert.deepEqual(v(getBrain('TST-0002'), getBrain('TST-0005'), cfg()), { ok: false, reason: 'policy', detail: 'cross_team' });
    assert.deepEqual(v(getBrain('TST-0002'), getBrain('TST-0004'), cfg()), { ok: false, reason: 'policy', detail: 'cross_team' }, 'escalate through own main');
    assert.deepEqual(
      v(getBrain('TST-0002'), getBrain('TST-0003'), cfg({ teams: { subsDirect: false } })),
      { ok: false, reason: 'policy', detail: 'same_team_via_parent' },
    );
    assert.deepEqual(v(getBrain('TST-0001'), getBrain('TST-0003'), cfg()), { ok: true }, 'parent <-> child never off');
    assert.deepEqual(
      v(getBrain('TST-0002'), getBrain('TST-0003'), cfg({ teams: { subsDirect: false }, allow: [['TST-0002', 'TST-0003']] })),
      { ok: true }, 'allow beats the via-parent rule',
    );
  } finally {
    restore();
  }
});

test('team log: one line per channel message, since/limit, malformed line skipped', () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    const first = appendTeamLog('TST-0001', { t: 1000, msgId: 'MSG-1', from: 'lead', fromId: 'TST-0001', text: 'one', receipts: [] });
    appendTeamLog('TST-0001', { t: 2000, msgId: 'MSG-2', from: 'lead', fromId: 'TST-0001', text: 'two', receipts: [] });

    assert.equal(first.file, teamLogPath('TST-0001'));
    assert.deepEqual(readTeamLog('TST-0001').map((e) => e.msgId), ['MSG-1', 'MSG-2']);
    assert.deepEqual(readTeamLog('TST-0001', { since: 1000 }).map((e) => e.msgId), ['MSG-2'], 'strictly newer');
    assert.deepEqual(readTeamLog('TST-0001', { limit: 1 }).map((e) => e.msgId), ['MSG-2']);
    assert.deepEqual(readTeamLog('TST-9999'), [], 'no log, no error');
    assert.deepEqual(listTeamLogIds(), ['TST-0001']);

    // A half-written line is skipped, and the complete lines before it still read.
    const raw = readFileSync(teamLogPath('TST-0001'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 2);
    appendTeamLog('TST-0001', { t: 3000, msgId: 'MSG-3', from: 'lead', fromId: 'TST-0001', text: 'three', receipts: [] });
    assert.deepEqual(readTeamLog('TST-0001').map((e) => e.msgId), ['MSG-1', 'MSG-2', 'MSG-3']);
  } finally {
    restore();
  }
});

test('read marks: unread window, reset on move', () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    appendTeamLog('TST-0001', { t: 1000, msgId: 'MSG-1', text: 'one', receipts: [] });
    appendTeamLog('TST-0001', { t: 2000, msgId: 'MSG-2', text: 'two', receipts: [] });
    appendTeamLog('TST-0004', { t: 3000, msgId: 'MSG-3', text: 'other team', receipts: [] });

    assert.equal(readMark('TST-0001', 'TST-0002'), 0, 'no mark means everything is unread');
    writeMark('TST-0001', 'TST-0002', 1000);
    assert.equal(readMark('TST-0001', 'TST-0002'), 1000);
    assert.deepEqual(unreadTeamLog('TST-0001', 'TST-0002').map((e) => e.msgId), ['MSG-2']);
    assert.deepEqual(unreadTeamLog('TST-0001', 'TST-0003').map((e) => e.msgId), ['MSG-1', 'MSG-2'], 'per caller');

    writeMark('TST-0004', 'TST-0002', 3000);
    assert.equal(resetTeamMarks('TST-0002'), 2, 'forgotten in every team');
    assert.equal(readMark('TST-0001', 'TST-0002'), 0);
    assert.equal(readMark('TST-0004', 'TST-0002'), 0);
    assert.equal(resetTeamMarks('TST-0002'), 0, 'idempotent');
  } finally {
    restore();
  }
});

test('fan-out: one delivery per member except the sender, one log line, team on every delivery', async () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    const sent = [];
    const deps = {
      getBrain,
      resolve: async (ref) => ({ address: ref, brainId: ref, account: 'a', cli: 'claude', claude: { sock: `/tmp/cc-socks/${ref}.sock` } }),
      deliver: async (input) => {
        sent.push(input);
        return { text: `env ${input.msgId}`, receipt: { status: 'delivered', via: 'uds', msgId: input.msgId, elapsedMs: 1 } };
      },
      openInbox: async () => fakeInbox(),
      closeInboxes: async () => {},
    };
    const out = await sendToChannel({
      channel: resolveChannel('#lead'),
      body: 'all hands',
      identity: { id: 'TST-0001', brain: 'lead', role: 'main', account: 'a', cli: 'claude' },
      msgId: 'MSG-CHANNEL-1',
      deps,
    });

    assert.equal(sent.length, 2, 'the sender does not receive its own message');
    assert.deepEqual(sent.map((s) => s.target.brainId), ['TST-0002', 'TST-0003']);
    assert.ok(sent.every((s) => s.team === 'TST-0001'), 'every mirror carries the team');
    assert.equal(sent[0].identity.role, '主脑 → #lead', 'the envelope role block');
    assert.equal(channelRole({ role: '子脑' }, resolveChannel('#lead')), '子脑 → #lead');
    assert.equal(channelRole({}, resolveChannel('#lead')), '用户 → #lead');

    assert.deepEqual(out.entry.receipts, [
      { to: 'fe-a', toId: 'TST-0002', status: 'delivered', via: 'uds' },
      { to: 'be-a', toId: 'TST-0003', status: 'delivered', via: 'uds' },
    ]);
    const logged = readTeamLog('TST-0001');
    assert.equal(logged.length, 1, 'one log line per channel message');
    assert.equal(logged[0].msgId, 'MSG-CHANNEL-1');
    assert.equal(logged[0].channel, '#lead');
    assert.equal(logged[0].receipts.length, 2);
    assert.equal(out.logFile, teamLogPath('TST-0001'));

    // #all is not a team: it fans out to the other mains and has no log.
    const all = await sendToChannel({
      channel: resolveChannel('#all'),
      body: 'everyone',
      identity: { sender: 'user', role: '用户' },
      msgId: 'MSG-ALL-1',
      deps,
    });
    assert.equal(all.results.length, 2, 'both mains');
    assert.equal(all.logFile, null);
    assert.equal(readTeamLog('TST-0004').length, 0);
  } finally {
    restore();
  }
});

test('tell #lead: user fan-out with one receipt each, blocked for a non-member and for a brain on #all', async () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    const deps = channelDeps(home);

    const { lines, result } = await captureLog(() => tellRun(['#lead', 'all hands'], deps));
    assert.equal(result, 0);
    assert.equal(lines[0], 'channel   #lead  team:TST-0001  members=3  sent=3');
    assert.match(lines[1], /^envelope  /);
    assert.equal(lines.filter((l) => / delivered\s+via=uds/.test(l)).length, 3);
    assert.match(lines.at(-1), /^log       /);
    const logged = readTeamLog('TST-0001');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].receipts.length, 3);

    const dry = await captureLog(() => tellRun(['#lead', 'preview', '--dry-run'], deps));
    assert.equal(dry.result, 0);
    assert.match(dry.lines[0], /^channel   #lead  team:TST-0001  members=3$/);
    assert.equal(dry.lines.filter((l) => /^  \w/.test(l)).length, 3);
    assert.match(dry.lines.at(-1), /^sender    \[user@cli\]\[用户 → #lead\]$/, 'the sender block names the channel role');
    assert.equal(readTeamLog('TST-0001').length, 1, 'dry-run writes nothing');

    // A brain outside the team may not post to it.
    const outsider = channelDeps(home, { paneId: '%40', rows: [row('TST-0005', 'fe-b', 'sub', 'TST-0004', '%40')] });
    const blocked = await captureLog(() => tellRun(['#lead', 'sneak in'], outsider));
    assert.equal(blocked.result, 4);
    assert.match(blocked.lines[0], /^blocked\s+msg=\w{8}  via=policy  reason=policy  detail=not_a_member/);
    const receipt = readReceiptEntries().at(-1);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.toId, 'team:TST-0001');
    assert.equal(receipt.detail, 'not_a_member');
    assert.equal(readTeamLog('TST-0001').length, 1, 'a blocked post is not a team message');

    // #all is the user's channel.
    const brainOnAll = channelDeps(home, { paneId: '%73', rows: [row('TST-0001', 'lead', 'main', null, '%73')] });
    const refused = await captureLog(() => tellRun(['#all', 'hello'], brainOnAll));
    assert.equal(refused.result, 4);
    assert.match(refused.lines[0], /detail=channel_user_only/);

    const allRun = await captureLog(() => tellRun(['#all', 'status?'], channelDeps(home)));
    assert.equal(allRun.result, 0);
    assert.match(allRun.lines[0], /^channel   #all  team:all  members=2  sent=2$/);
    assert.ok(!allRun.lines.some((l) => l.startsWith('log ')), '#all has no team log');
  } finally {
    restore();
  }
});

test('ask #lead: prints every reply before the deadline, mirror as fallback, timeout is exit 5', async () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    const reply = (input, text) => writeInboxEntry({
      owner: 'user',
      entry: { msgId: `reply-${text}`, replyTo: input.msgId, from: 'fe-a', fromId: 'TST-0002', text, t: Date.now() },
    });
    const deps = channelDeps(home, {
      deliver: async (input) => {
        if (input.target.brainId === 'TST-0002') reply(input, 'pong');
        return { text: `env ${input.msgId}`, receipt: { status: 'delivered', via: 'uds', msgId: input.msgId, elapsedMs: 1 } };
      },
    });
    const ok = await captureLog(() => askRun(['#lead', 'status?', '--wait', '300'], deps));
    assert.equal(ok.result, 0);
    assert.match(ok.lines[0], /^channel   #lead  team:TST-0001  members=3  sent=3$/);
    assert.ok(ok.lines.some((l) => /^reply     msg=reply-po from=fe-a  via=replyTo$/.test(l)), ok.lines.join(' | '));
    assert.equal(ok.lines.at(-1), 'pong');
    assert.equal(readTeamLog('TST-0001').length, 1, 'the ask is logged like a tell');

    const silent = channelDeps(home, { deliver: async (input) => ({ text: 'env', receipt: { status: 'delivered', via: 'uds', msgId: input.msgId, elapsedMs: 1 } }) });
    const timedOut = await captureLog(() => askRun(['#lead', 'anyone?', '--wait', '150'], silent));
    assert.equal(timedOut.result, 5);
    assert.equal(timedOut.lines.at(-1), 'timeout');
  } finally {
    restore();
  }
});

test('collect --team: reads the thread since the mark and advances it', async () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    appendTeamLog('TST-0001', { t: 1000, msgId: 'MSG-1', from: 'lead', fromId: 'TST-0001', text: 'one', receipts: [] });
    appendTeamLog('TST-0001', { t: 2000, msgId: 'MSG-2', from: 'lead', fromId: 'TST-0001', text: 'two', receipts: [] });
    writeMark('TST-0001', 'TST-0002', 1000);
    const deps = { paneId: '%30', rows: [row('TST-0002', 'fe-a', 'sub', 'TST-0001')], sbbDir: join(home, '.sbb') };

    const first = await captureLog(() => collectRun(['--team'], deps));
    assert.equal(first.result, 0);
    assert.equal(first.lines.length, 1);
    assert.match(first.lines[0], /^msg=MSG-2  from=lead  /);
    assert.ok(first.lines[0].endsWith('two'));
    assert.equal(readMark('TST-0001', 'TST-0002'), 2000, 'the mark advances to the newest entry');

    const again = await captureLog(() => collectRun(['--team'], deps));
    assert.equal(again.lines[0], 'no new messages in #lead');

    const all = await captureLog(() => collectRun(['--team', '--all'], deps));
    assert.equal(all.lines.length, 2, '--all ignores the mark');
    assert.equal(readMark('TST-0001', 'TST-0002'), 2000, 'and leaves it alone');

    const json = await captureLog(() => collectRun(['--team', 'lead', '--json'], deps));
    const payload = JSON.parse(json.lines[0]);
    assert.equal(payload.channel, 'team:TST-0001');
    assert.equal(payload.name, '#lead');
    assert.equal(payload.since, 2000);
    assert.deepEqual(payload.entries.map((e) => e.msgId), []);

    const other = await captureLog(() => collectRun(['--team'], { paneId: '%40', rows: [row('TST-0005', 'fe-b', 'sub', 'TST-0004', '%40')], sbbDir: join(home, '.sbb') }));
    assert.equal(other.lines[0], 'no new messages in #lead-b', 'a sub reads its own team by default');
  } finally {
    restore();
  }
});

test('ls --teams: channels with member and unread counts for the caller', async () => {
  const home = tempDir('sbb-teams-');
  const restore = withEnv(sbbEnv(home));
  try {
    teamFixture();
    appendTeamLog('TST-0001', { t: 1000, msgId: 'MSG-1', text: 'one', receipts: [] });
    appendTeamLog('TST-0001', { t: 2000, msgId: 'MSG-2', text: 'two', receipts: [] });
    appendTeamLog('TST-0004', { t: 3000, msgId: 'MSG-3', text: 'three', receipts: [] });
    writeMark('TST-0001', 'TST-0002', 1000);
    const deps = { paneId: '%30', roster: async () => [row('TST-0002', 'fe-a', 'sub', 'TST-0001')], sbbDir: join(home, '.sbb') };

    const { lines, result } = await captureLog(() => lsRun(['--teams'], deps));
    assert.equal(result, 0);
    const table = lines[0].split('\n');
    assert.match(table[0], /^CHANNEL\s+ID\s+MAIN\s+MEMBERS\s+UNREAD$/);
    assert.match(table[1], /^#lead\s+team:TST-0001\s+TST-0001\s+3\s+1$/);
    assert.match(table[2], /^#lead-b\s+team:TST-0004\s+TST-0004\s+2\s+1$/, 'no mark, so its one entry is unread');

    const json = await captureLog(() => lsRun(['--teams', '--json'], deps));
    const payload = JSON.parse(json.lines[0]);
    assert.deepEqual(payload.map((t) => [t.name, t.members, t.unread]), [['#lead', 3, 1], ['#lead-b', 2, 1]]);
  } finally {
    restore();
  }
});

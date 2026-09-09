// TPS: window math and the two real log readers. Fixtures in test/fixtures/ui are cuts
// of real session logs (Claude JSONL, Codex rollout) with every text field redacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TURN_MS,
  MAX_TURN_MS,
  WINDOW_MS,
  claudeLogPath,
  claudeTurns,
  codexRolloutPath,
  codexTokenEvents,
  createTps,
  createTpsWindow,
  encodeCwd,
  parseInferenceSeconds,
  parseTimestamp,
} from '../src/metrics/tps.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'ui');
const CLAUDE = readFileSync(join(FIXTURES, 'claude-session.jsonl'), 'utf8');
const CODEX = readFileSync(join(FIXTURES, 'codex-rollout.jsonl'), 'utf8');
const PANE = readFileSync(join(FIXTURES, 'codex-pane.txt'), 'utf8');

/** @param {string} text */
function records(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** First occurrence of each assistant message id that carries output tokens. */
function uniqueAssistantTurns(text) {
  /** @type {{id: string, tokens: number, at: number}[]} */
  const out = [];
  for (const record of records(text)) {
    if (record.type !== 'assistant') continue;
    const tokens = Number(record.message?.usage?.output_tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    if (out.some((t) => t.id === record.message.id)) continue;
    out.push({ id: record.message.id, tokens, at: Date.parse(record.timestamp) });
  }
  return out;
}

test('fixture really contains repeated assistant messages', () => {
  const all = records(CLAUDE).filter(
    (r) => r.type === 'assistant' && Number(r.message?.usage?.output_tokens) > 0,
  );
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map((r) => r.message.id)).size, 5);
});

test('claudeTurns counts each message id once and measures the gap to the previous record', () => {
  const turns = claudeTurns(CLAUDE);
  const unique = uniqueAssistantTurns(CLAUDE);
  assert.equal(turns.length, unique.length);
  assert.deepEqual(turns.map((t) => t.tokens), unique.map((t) => t.tokens));
  assert.deepEqual(turns.map((t) => t.at), unique.map((t) => t.at));
  // The duration is the gap to the immediately preceding record in the log, so the first
  // counted turn already has a real gap when a non-assistant record comes first.
  const firstAt = turns[0].at;
  const earlier = records(CLAUDE).map((r) => Date.parse(r.timestamp)).filter((at) => Number.isFinite(at) && at < firstAt);
  assert.equal(turns[0].durationMs, Math.min(firstAt - earlier[earlier.length - 1], MAX_TURN_MS));
  for (const turn of turns) {
    assert.ok(turn.durationMs > 0 && turn.durationMs <= MAX_TURN_MS);
  }
  assert.ok(turns.some((t) => t.durationMs !== DEFAULT_TURN_MS));
});

test('claudeTurns collapses a duplicate id even when the copies differ in timestamp', () => {
  const line = (id, tokens, at) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id, usage: { output_tokens: tokens } } });
  const text = [
    line('m1', 10, '2026-09-09T07:00:00.000Z'),
    line('m1', 10, '2026-09-09T07:00:01.000Z'),
    line('m2', 20, '2026-09-09T07:00:05.000Z'),
  ].join('\n');
  const turns = claudeTurns(text);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.tokens), [10, 20]);
  assert.equal(turns[1].durationMs, 5000);
});

test('claudeTurns ignores unparseable lines and records without usage', () => {
  const text = [
    '{"type":"assistant"',
    JSON.stringify({ type: 'user', timestamp: '2026-09-09T07:00:00.000Z', message: { content: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: 'not-a-date', message: { id: 'm', usage: { output_tokens: 5 } } }),
  ].join('\n');
  assert.deepEqual(claudeTurns(text), []);
  assert.deepEqual(claudeTurns(''), []);
});

test('codexTokenEvents reads last_token_usage from the rollout fixture', () => {
  const events = codexTokenEvents(CODEX);
  assert.equal(events.length, 14);
  for (const event of events) {
    assert.ok(event.tokens > 0);
    assert.ok(Number.isFinite(event.at));
  }
  assert.deepEqual(codexTokenEvents('not json\n'), []);
});

test('parseInferenceSeconds sums every line on screen', () => {
  assert.equal(parseInferenceSeconds(PANE), 4.7);
  assert.equal(parseInferenceSeconds('no inference here'), null);
  assert.equal(parseInferenceSeconds(''), null);
});

test('parseTimestamp and encodeCwd follow the measured formats', () => {
  assert.equal(parseTimestamp('2026-09-09T07:00:00.000Z'), Date.parse('2026-09-09T07:00:00.000Z'));
  assert.equal(parseTimestamp(1234), 1234);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(encodeCwd('/Users/steven/developer/sbb-worktrees/h1'), '-Users-steven-developer-sbb-worktrees-h1');
});

test('createTpsWindow drops samples older than the window and computes tps', () => {
  let now = 1_000_000;
  const window = createTpsWindow({ windowMs: 60000, now: () => now });
  window.add('b1', { at: now - 1000, tokens: 100, activeMs: 500, source: 'claude-jsonl' });
  window.add('b1', { at: now - 30000, tokens: 300, activeMs: 1500, source: 'claude-jsonl' });
  let value = window.value('b1');
  assert.equal(value.tokens60s, 400);
  assert.equal(value.activeMs, 2000);
  assert.equal(value.tps, 200);
  assert.equal(value.source, 'claude-jsonl');
  now += 40000; // the older sample (t-30000) is now outside the 60s window
  value = window.value('b1');
  assert.equal(value.tokens60s, 100);
  assert.equal(value.activeMs, 500);
  assert.equal(value.tps, 200);
  now += 40000; // nothing left
  value = window.value('b1');
  assert.equal(value.tokens60s, 0);
  assert.equal(value.tps, null);
  assert.equal(value.source, null);
});

test('sampleBrain reads a Claude log from a real path and reports tps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbb-h1-tps-'));
  const claudeDir = join(root, 'claude');
  const cwd = '/tmp/h1-tps-worktree';
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const dir = join(claudeDir, 'projects', encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), CLAUDE);
  const turns = claudeTurns(CLAUDE);
  const now = turns[0].at + 1000; // every turn is inside the 60s window
  const tps = createTps({ now: () => now, accounts: () => [{ name: 'x', claudeDir }] });
  const result = await tps.sampleBrain(
    { id: 'b1', name: 'one', cli: 'claude', account: 'x', cwd },
    { sessionId },
  );
  const tokens = turns.reduce((sum, t) => sum + t.tokens, 0);
  const activeMs = turns.reduce((sum, t) => sum + t.durationMs, 0);
  assert.equal(result.brainId, 'b1');
  assert.equal(result.tokens60s, tokens);
  assert.equal(result.activeMs, activeMs);
  assert.equal(result.tps, Number((tokens / (activeMs / 1000)).toFixed(2)));
  assert.ok(result.tps > 0);
  assert.equal(result.source, 'claude-jsonl');
});

test('sampleBrain returns a null rate for a Claude brain with no log', async () => {
  const tps = createTps({ accounts: () => [{ name: 'x', claudeDir: join(tmpdir(), 'sbb-h1-missing') }] });
  const result = await tps.sampleBrain({ id: 'b2', cli: 'claude', account: 'x', cwd: '/nope' });
  assert.deepEqual(result, { brainId: 'b2', tps: null, tokens60s: 0, activeMs: 0, source: null });
});

test('sampleBrain divides Codex tokens by the pane inference seconds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbb-h1-tps-'));
  const codexDir = join(root, 'codex');
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = join(codexDir, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-09-09T07-00-00-${threadId}.jsonl`), CODEX);
  const events = codexTokenEvents(CODEX);
  const now = events[events.length - 1].at + 1; // only the last 60s of events count
  const inWindow = events.filter((e) => e.at >= now - WINDOW_MS);
  const tokens = inWindow.reduce((sum, e) => sum + e.tokens, 0);
  const tps = createTps({ now: () => now, accounts: () => [{ name: 'x', codexDir }] });
  const result = await tps.sampleBrain(
    { id: 'b3', cli: 'codex', account: 'x', threadId, paneId: '%1' },
    { screen: PANE },
  );
  assert.equal(result.tokens60s, tokens);
  assert.equal(result.tps, Number((tokens / 4.7).toFixed(2)));
  assert.equal(result.source, 'codex-inference');
});

test('sampleBrain captures the pane when no screen is passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbb-h1-tps-'));
  const codexDir = join(root, 'codex');
  const threadId = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = join(codexDir, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-09-09T07-00-00-${threadId}.jsonl`), CODEX);
  const calls = [];
  const events = codexTokenEvents(CODEX);
  const now = events[events.length - 1].at + 1;
  const tps = createTps({
    now: () => now,
    accounts: () => [{ name: 'x', codexDir }],
    host: { capturePane: async (pane, lines) => { calls.push([pane, lines]); return PANE; } },
  });
  const result = await tps.sampleBrain({ id: 'b4', cli: 'codex', account: 'x', threadId, paneId: '%9' });
  assert.deepEqual(calls, [['%9', 200]]);
  assert.equal(result.source, 'codex-inference');
});

test('sampleBrain never guesses for agy or cursor', async () => {
  const tps = createTps({ accounts: () => [] });
  const result = await tps.sampleBrain({ id: 'b5', cli: 'agy', account: 'x' });
  assert.deepEqual(result, { brainId: 'b5', tps: null, tokens60s: 0, activeMs: 0, source: 'unsupported' });
});

test('sampleAll returns one row per brain in order', async () => {
  const tps = createTps({ accounts: () => [] });
  const rows = await tps.sampleAll([
    { id: 'a', cli: 'agy' },
    { id: 'b', cli: 'cursor' },
  ]);
  assert.deepEqual(rows.map((r) => r.brainId), ['a', 'b']);
  assert.deepEqual(rows.map((r) => r.source), ['unsupported', 'unsupported']);
});

test('start emits per-brain rows and a total, then stop clears the timer', async () => {
  const tps = createTps({ intervalMs: 5, accounts: () => [] });
  /** @type {Record<string, any>[]} */
  const events = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    tps.start(
      (event) => {
        events.push(event);
        if (events.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      },
      () => [{ id: 'a', cli: 'agy' }],
    );
  });
  tps.stop();
  assert.ok(events.some((e) => e.brainId === 'a'));
  assert.ok(events.some((e) => e.total === null && e.tokens60s === 0));
});

test('claudeLogPath prefers the session id and falls back to the newest log', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbb-h1-tps-'));
  const claudeDir = join(root, 'claude');
  const cwd = '/tmp/h1-fallback';
  const dir = join(claudeDir, 'projects', encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aaa.jsonl'), '{}\n');
  writeFileSync(join(dir, 'bbb.jsonl'), '{}\n');
  assert.equal(claudeLogPath({ claudeDir, cwd, sessionId: 'bbb' }), join(dir, 'bbb.jsonl'));
  assert.equal(claudeLogPath({ claudeDir, cwd }), join(dir, 'bbb.jsonl'));
  assert.equal(claudeLogPath({ claudeDir, cwd, sessionId: 'missing' }), join(dir, 'bbb.jsonl'));
  assert.equal(claudeLogPath({}), undefined);
});

test('codexRolloutPath finds the rollout by thread id', () => {
  const root = mkdtempSync(join(tmpdir(), 'sbb-h1-tps-'));
  const codexDir = join(root, 'codex');
  const dir = join(codexDir, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-09-09T07-00-00-thread-1.jsonl');
  writeFileSync(file, '{}\n');
  assert.equal(codexRolloutPath({ codexDir, threadId: 'thread-1' }), file);
  assert.equal(codexRolloutPath({ codexDir, threadId: 'other' }), undefined);
  assert.equal(codexRolloutPath({ codexDir }), undefined);
});

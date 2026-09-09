// Tokens per second, per brain, over a rolling window (docs/spec/ui-server.md "TPS").
// Read-only: it tails the CLI's own logs and never talks to a provider.
//
// Sources:
//   claude  <claudeDir>/projects/<encoded cwd>/<sessionId>.jsonl
//   codex   <codexDir>/sessions/**/rollout-<thread>.jsonl + the pane's inference line
//   agy/cursor  null, never guessed
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { host as defaultHost } from '../host/index.js';
import { discoverAccounts } from '../lib/paths.js';

/** Rolling window length. */
export const WINDOW_MS = 60000;

/** Used when a turn has no preceding user record to measure against. */
export const DEFAULT_TURN_MS = 1000;

/** `tps` events are emitted on this cadence. */
export const EMIT_MS = 5000;

/** A turn's measured duration is capped so a session left open overnight cannot skew the rate. */
export const MAX_TURN_MS = 30 * 60 * 1000;

/** Codex prints this in its pane while it streams. */
export const INFERENCE_RE = /Responses API inference:\s*([0-9]+(?:\.[0-9]+)?)\s*s/g;

/**
 * Claude Code's project directory name for a cwd: every `/` and `.` becomes `-`
 * (`/Users/x/proj` -> `-Users-x-proj`), confirmed against a live ~/.claude/projects on 2026-09-09.
 * @param {string} cwd
 */
export function encodeCwd(cwd) {
  return String(cwd ?? '').replace(/[/.]/g, '-');
}

/** @param {string} value @returns {number|null} epoch ms */
export function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Assistant turns with token counts, read from a Claude session JSONL.
 * Each record's duration is the gap to the record before it, which for the first assistant
 * message of a turn is the preceding user record (the spec's rule). Later messages in the
 * same turn measure against the previous message, so a turn's time is never counted twice.
 * @param {string} text
 * @returns {{at: number, tokens: number, durationMs: number}[]}
 */
export function claudeTurns(text) {
  /** @type {{at: number, tokens: number, durationMs: number}[]} */
  const out = [];
  /** Assistant message ids already counted; see the duplicate note below. */
  const seen = new Set();
  let previousAt = null;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // a half-written line at the tail of a live log
    }
    if (!record || typeof record !== 'object') continue;
    const at = parseTimestamp(record.timestamp);
    if (at === null) continue;
    // A live session log repeats the same assistant message (same message.id) two or
    // three times as it streams; counting every copy nearly doubles the tokens.
    // Measured 2026-09-09 on a real session: 8 unique ids in the last 16 records.
    const id = record.type === 'assistant' && typeof record.message?.id === 'string' ? record.message.id : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const usage = record.type === 'assistant' ? record.message?.usage : undefined;
    const tokens = Number(usage?.output_tokens);
    if (Number.isFinite(tokens) && tokens > 0) {
      const gap = previousAt === null ? DEFAULT_TURN_MS : at - previousAt;
      const durationMs = gap > 0 ? Math.min(gap, MAX_TURN_MS) : DEFAULT_TURN_MS;
      out.push({ at, tokens, durationMs });
    }
    previousAt = at;
  }
  return out;
}

/**
 * `token_count` events from a Codex rollout. `last_token_usage` is the per-request delta.
 * @param {string} text
 * @returns {{at: number, tokens: number}[]}
 */
export function codexTokenEvents(text) {
  /** @type {{at: number, tokens: number}[]} */
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const payload = record.payload;
    if (!payload || payload.type !== 'token_count') continue;
    const at = parseTimestamp(record.timestamp);
    if (at === null) continue;
    const info = payload.info ?? {};
    const tokens = Number(info.last_token_usage?.output_tokens ?? info.total_token_usage?.output_tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    out.push({ at, tokens });
  }
  return out;
}

/**
 * Inference seconds printed in a Codex pane, summed over every match on screen.
 * @param {string} screen
 * @returns {number|null}
 */
export function parseInferenceSeconds(screen) {
  const matches = [...String(screen ?? '').matchAll(INFERENCE_RE)];
  if (!matches.length) return null;
  const seconds = matches.reduce((sum, m) => sum + Number(m[1]), 0);
  return seconds > 0 ? seconds : null;
}

/**
 * @param {{ windowMs?: number, now?: () => number }} [opts]
 */
export function createTpsWindow(opts = {}) {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  /** @type {Map<string, {at: number, tokens: number, activeMs: number, source: string}[]>} */
  const samples = new Map();

  /** @param {string} brainId @param {{at?: number, tokens: number, activeMs?: number, source?: string}} sample */
  function add(brainId, sample) {
    const id = String(brainId);
    const list = samples.get(id) ?? [];
    list.push({
      at: sample.at ?? now(),
      tokens: Number(sample.tokens) || 0,
      activeMs: Number(sample.activeMs) || 0,
      source: sample.source ?? 'unknown',
    });
    samples.set(id, list);
    return list[list.length - 1];
  }

  /** @param {string} brainId */
  function value(brainId) {
    const id = String(brainId);
    const list = samples.get(id) ?? [];
    const cutoff = now() - windowMs;
    const live = list.filter((s) => s.at >= cutoff);
    samples.set(id, live);
    if (!live.length) return { brainId: id, tps: null, tokens60s: 0, activeMs: 0, source: null };
    const tokens60s = live.reduce((sum, s) => sum + s.tokens, 0);
    const activeMs = live.reduce((sum, s) => sum + s.activeMs, 0);
    const source = live[live.length - 1].source;
    return {
      brainId: id,
      tps: activeMs > 0 ? Number((tokens60s / (activeMs / 1000)).toFixed(2)) : null,
      tokens60s,
      activeMs,
      source,
    };
  }

  return {
    add,
    value,
    /** @returns {Record<string, any>[]} */
    snapshot() {
      return [...samples.keys()].map((id) => value(id));
    },
  };
}

/** Newest `.jsonl` in a directory, or undefined. @param {string} dir */
function newestJsonl(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  let best;
  for (const name of names) {
    const file = join(dir, name);
    let info;
    try {
      info = statSync(file);
    } catch {
      continue;
    }
    if (!best || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs };
  }
  return best?.file;
}

/**
 * Path of a Claude session log: `<claudeDir>/projects/<encoded cwd>/<sessionId>.jsonl`, or the
 * newest log in that directory when the session id is unknown.
 * @param {{ claudeDir?: string, cwd?: string, sessionId?: string }} input
 */
export function claudeLogPath({ claudeDir, cwd, sessionId } = {}) {
  if (!claudeDir) return undefined;
  const dir = join(claudeDir, 'projects', encodeCwd(cwd));
  if (sessionId) {
    const exact = join(dir, `${sessionId}.jsonl`);
    try {
      statSync(exact);
      return exact;
    } catch {
      // fall through to the newest log in the same directory
    }
  }
  return newestJsonl(dir);
}

/**
 * Path of a Codex rollout for a thread id: `<codexDir>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
 * @param {{ codexDir?: string, threadId?: string }} input
 */
export function codexRolloutPath({ codexDir, threadId } = {}) {
  if (!codexDir || !threadId) return undefined;
  const root = join(codexDir, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  /** @type {string[]} */
  const stack = [root];
  let best;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.name.endsWith(suffix)) continue;
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (!best || info.mtimeMs > best.mtimeMs) best = { file: path, mtimeMs: info.mtimeMs };
    }
  }
  return best?.file;
}

/**
 * The TPS engine. `sampleBrain` reads whatever the brain's CLI wrote; `start` re-samples every
 * `EMIT_MS` and hands each result to `onEvent`.
 * @param {{ windowMs?: number, now?: () => number, readFile?: Function, host?: typeof defaultHost,
 *           accounts?: Function, intervalMs?: number }} [opts]
 */
export function createTps(opts = {}) {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const readFile = opts.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const host = opts.host ?? defaultHost;
  const accountsFn = opts.accounts ?? discoverAccounts;
  const intervalMs = opts.intervalMs ?? EMIT_MS;
  const window = createTpsWindow({ windowMs, now });
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  /**
   * @param {import('../types.js').Brain} brain
   * @param {{ screen?: string, sessionId?: string, accounts?: import('../types.js').Account[],
   *           capture?: boolean }} [ctx]
   */
  async function sampleBrain(brain, ctx = {}) {
    const id = brain?.id ?? brain?.name ?? 'unknown';
    const accounts = ctx.accounts ?? accountsFn();
    const account = accounts.find((a) => a.name === brain?.account) ?? {};

    if (brain?.cli === 'claude') {
      const path = claudeLogPath({ claudeDir: account.claudeDir, cwd: brain.cwd, sessionId: ctx.sessionId });
      if (!path) return window.value(id);
      const turns = claudeTurns(readFile(path));
      for (const turn of turns) {
        window.add(id, { at: turn.at, tokens: turn.tokens, activeMs: turn.durationMs, source: 'claude-jsonl' });
      }
      return window.value(id);
    }

    if (brain?.cli === 'codex') {
      const path = codexRolloutPath({ codexDir: account.codexDir, threadId: brain.threadId });
      if (path) {
        for (const event of codexTokenEvents(readFile(path))) {
          window.add(id, { at: event.at, tokens: event.tokens, activeMs: 0, source: 'codex-rollout' });
        }
      }
      let screen = ctx.screen;
      if (screen === undefined && ctx.capture !== false && brain.paneId) {
        try {
          screen = await host.capturePane(brain.paneId, 200);
        } catch {
          screen = '';
        }
      }
      const seconds = parseInferenceSeconds(screen ?? '');
      const pending = window.value(id);
      if (seconds === null || pending.tokens60s <= 0) {
        return { ...pending, tps: null, source: seconds === null ? pending.source : 'codex-inference' };
      }
      return { ...pending, tps: Number((pending.tokens60s / seconds).toFixed(2)), source: 'codex-inference' };
    }

    return { brainId: id, tps: null, tokens60s: 0, activeMs: 0, source: 'unsupported' };
  }

  /**
   * @param {import('../types.js').Brain[]} brains
   * @param {{ screens?: Record<string, string>, sessionIds?: Record<string, string>,
   *           accounts?: import('../types.js').Account[] }} [ctx]
   */
  async function sampleAll(brains, ctx = {}) {
    const accounts = ctx.accounts ?? accountsFn();
    /** @type {Record<string, any>[]} */
    const out = [];
    for (const brain of brains) {
      out.push(await sampleBrain(brain, {
        accounts,
        screen: ctx.screens?.[brain.id ?? brain.name],
        sessionId: ctx.sessionIds?.[brain.id ?? brain.name],
      }));
    }
    return out;
  }

  /** @param {(event: Record<string, any>) => void} onEvent @param {() => any[]} listBrains */
  function start(onEvent, listBrains) {
    if (timer) return;
    timer = setInterval(async () => {
      try {
        const results = await sampleAll(listBrains());
        const active = results.filter((r) => r.activeMs > 0);
        const tokens = results.reduce((sum, r) => sum + r.tokens60s, 0);
        const activeMs = results.reduce((sum, r) => sum + r.activeMs, 0);
        for (const result of results) onEvent(result);
        onEvent({
          total: active.length && activeMs > 0 ? Number((tokens / (activeMs / 1000)).toFixed(2)) : null,
          tokens60s: tokens,
          activeMs,
        });
      } catch (err) {
        onEvent({ error: String(err?.message ?? err) });
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { window, sampleBrain, sampleAll, start, stop, value: window.value };
}

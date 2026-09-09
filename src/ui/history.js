// Read-only readers behind the console's GET routes (docs/spec/ui-server.md). They only
// read what the CLIs and SBB already wrote; a malformed trailing line is skipped, never
// thrown.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { claudeLogPath, codexRolloutPath, parseTimestamp } from '../metrics/tps.js';
import { listInbox } from '../registry/inbox.js';
import { readReceiptEntries } from '../registry/receipts.js';

/** Default page size for every reader. */
export const DEFAULT_LIMIT = 200;

/** Team channel logs live next to the rest of SBB's state. */
export function teamsDir() {
  return join(sbbDir(), 'teams');
}

/** @param {string} mainId */
export function teamLogPath(mainId) {
  return join(teamsDir(), `${mainId}.jsonl`);
}

/**
 * @param {string} path
 * @param {{ limit?: number, readFile?: (path: string) => string }} [opts]
 * @returns {Record<string, any>[]} the last `limit` well-formed records, oldest first
 */
export function readJsonl(path, opts = {}) {
  const read = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let raw;
  try {
    raw = read(path);
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // a line still being appended is not a record
    }
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return limit > 0 ? out.slice(-limit) : out;
}

/** @param {unknown} content */
function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Turns from a Claude session JSONL: user prompts and assistant text. Sidechains and meta
 * records are left out so the console shows the same conversation the user had.
 * @param {string} text
 * @param {{ limit?: number }} [opts]
 */
export function claudeTranscript(text, opts = {}) {
  /** @type {{role: string, at: number, text: string, model?: string}[]} */
  const turns = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) continue;
    if (record.isSidechain === true || record.isMeta === true) continue;
    const body = claudeText(record.message?.content).trim();
    if (!body) continue;
    turns.push({
      role: record.type,
      at: parseTimestamp(record.timestamp) ?? 0,
      text: body,
      model: record.message?.model,
    });
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return limit > 0 ? turns.slice(-limit) : turns;
}

/**
 * Turns from a Codex rollout: `response_item/message` records with a user or assistant role.
 * The `developer` role is the system briefing, not part of the conversation.
 * @param {string} text
 * @param {{ limit?: number }} [opts]
 */
export function codexTranscript(text, opts = {}) {
  /** @type {{role: string, at: number, text: string}[]} */
  const turns = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!payload || payload.type !== 'message') continue;
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const body = (Array.isArray(payload.content) ? payload.content : [])
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
    if (!body) continue;
    turns.push({ role, at: parseTimestamp(record.timestamp) ?? 0, text: body });
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return limit > 0 ? turns.slice(-limit) : turns;
}

/**
 * The brain's own conversation log, mirrored read-only.
 * @param {{ brain: import('../types.js').Brain, account?: import('../types.js').Account,
 *           sessionId?: string, limit?: number, readFile?: Function }} input
 * @returns {{ source: string, path: string|null, turns: Record<string, any>[] }}
 */
export function transcriptFor({ brain, account, sessionId, limit, readFile } = {}) {
  if (!brain) return { source: 'unknown', path: null, turns: [] };
  if (brain.cli === 'claude') {
    const path = claudeLogPath({ claudeDir: account?.claudeDir, cwd: brain.cwd, sessionId });
    if (!path) return { source: 'claude-jsonl', path: null, turns: [] };
    const text = readFile ? readFile(path) : readFileSync(path, 'utf8');
    return { source: 'claude-jsonl', path, turns: claudeTranscript(text, { limit }) };
  }
  if (brain.cli === 'codex') {
    const path = codexRolloutPath({ codexDir: account?.codexDir, threadId: brain.threadId });
    if (!path) return { source: 'codex-rollout', path: null, turns: [] };
    const text = readFile ? readFile(path) : readFileSync(path, 'utf8');
    return { source: 'codex-rollout', path, turns: codexTranscript(text, { limit }) };
  }
  return { source: 'unsupported', path: null, turns: [] };
}

/** @param {Record<string, any>} entry */
function receiptLine(entry) {
  return {
    kind: entry.kind === 'peer-status' ? 'peer-status' : 'receipt',
    t: entry.t ?? 0,
    msgId: entry.msgId ?? null,
    from: entry.from ?? entry.owner ?? null,
    fromId: entry.fromId ?? null,
    to: entry.to ?? null,
    toId: entry.toId ?? null,
    status: entry.status ?? null,
    via: entry.via ?? null,
    replyTo: entry.replyTo ?? null,
    text: entry.textPreview ?? null,
  };
}

/**
 * The private thread between the user and one brain: the receipt log plus the inbox mirrors
 * that name the brain.
 * @param {{ brainId?: string, brainName?: string, limit?: number,
 *           receipts?: Record<string, any>[], inbox?: Function }} input
 */
export function messagesFor({ brainId, brainName, limit, receipts, inbox } = {}) {
  const ids = new Set([brainId, brainName].filter(Boolean));
  const matches = (value) => value !== null && value !== undefined && ids.has(String(value));
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const entry of receipts ?? readReceiptEntries()) {
    if (entry.kind === 'peer-status') continue;
    if (!matches(entry.fromId) && !matches(entry.from) && !matches(entry.toId) && !matches(entry.to)) continue;
    out.push(receiptLine(entry));
  }
  const readInbox = inbox ?? listInbox;
  for (const owner of ids) {
    for (const { entry } of readInbox(owner)) {
      if (!matches(entry.fromId) && !matches(entry.from) && !entry.replyTo) continue;
      out.push({
        kind: 'inbox',
        t: entry.t ?? 0,
        msgId: entry.msgId ?? null,
        from: entry.from ?? null,
        fromId: entry.fromId ?? null,
        to: owner,
        toId: null,
        status: entry.status ?? null,
        via: entry.via ?? null,
        replyTo: entry.replyTo ?? null,
        text: entry.text ?? null,
        read: entry.read === true,
      });
    }
  }
  out.sort((a, b) => a.t - b.t);
  const max = limit ?? DEFAULT_LIMIT;
  return max > 0 ? out.slice(-max) : out;
}

/**
 * One team channel log (docs/spec/teams.md).
 * @param {{ mainId: string, limit?: number, readFile?: Function }} input
 */
export function teamLog({ mainId, limit, readFile } = {}) {
  if (!mainId) return [];
  return readJsonl(teamLogPath(mainId), { limit, readFile });
}

/** Every channel log on disk, newest first. */
export function listTeamLogs() {
  let names;
  try {
    names = readdirSync(teamsDir()).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const path = join(teamsDir(), name);
      let info;
      try {
        info = statSync(path);
      } catch {
        return null;
      }
      return { mainId: name.slice(0, -'.jsonl'.length), path, bytes: info.size, mtimeMs: info.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

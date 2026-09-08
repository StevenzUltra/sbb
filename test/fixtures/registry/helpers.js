// Test helpers: temp homes, fake Claude registries and fake SQLite databases.
// Fixtures live in test/fixtures/registry/; everything else is built per test.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { allocateId } from '../../../src/registry/brain-id.js';
import { saveBrain } from '../../../src/registry/brains.js';

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
export function fixture(name) {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function fixtureJson(name) {
  return JSON.parse(fixture(name));
}

export function tempDir(prefix = 'sbb-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Create `<home>/.ai-account-<name>/claude/sessions/<pid>.json` plus its key file.
 * @param {string} home
 * @param {string} account
 * @param {{ pid: number, tmux: string, name: string, status?: string, sock?: string, sessionId?: string }} opts
 */
export function writeClaudeSession(home, account, opts) {
  const dir = join(home, `.ai-account-${account}`, 'claude', 'sessions');
  mkdirSync(dir, { recursive: true });
  const body = fixture('claude-session.template.json')
    .replace('__PID__', String(opts.pid))
    .replace('__SESSION_ID__', opts.sessionId ?? `session-${opts.pid}`)
    .replace('__TMUX__', opts.tmux)
    .replace('__SOCK__', opts.sock ?? `/tmp/cc-socks/${opts.pid}.sock`)
    .replace('__NAME__', opts.name)
    .replace('__STATUS__', opts.status ?? 'idle');
  writeFileSync(join(dir, `${opts.pid}.json`), body);
  writeFileSync(
    join(dir, `${opts.pid}.2f7c4de00f9148e900f1038443843e16.key`),
    fixture('claude-key.template.json'),
  );
  return dir;
}

/**
 * Write a brain record through the real store. Pass `id`/`uuid` to keep a test
 * deterministic; otherwise the id comes from the machine counter.
 * @param {Record<string, any>} over
 */
export function writeBrain(over = {}) {
  return saveBrain({
    id: over.id ?? allocateId(),
    uuid: over.uuid ?? `uuid-${over.name ?? 'brain'}-${Math.random().toString(16).slice(2)}`,
    name: over.name ?? 'lead',
    role: over.role ?? 'main',
    parent: over.parent ?? null,
    account: over.account ?? 'a',
    cli: over.cli ?? 'claude',
    model: over.model,
    cwd: over.cwd ?? '/Users/dev/proj',
    paneId: over.paneId ?? '%30',
    coord: over.coord ?? '24:3.4',
    pid: over.pid,
    ...(over.threadId === undefined ? {} : { threadId: over.threadId }),
    createdAt: over.createdAt ?? Date.now(),
    origin: over.origin ?? 'adopted',
  });
}

/**
 * Build a minimal CODEX_HOME state_5.sqlite with the `threads` columns SBB reads.
 * @param {string} codexDir
 * @param {{ id: string, name?: string, cwd: string, rolloutPath: string, updatedAt: number }[]} threads
 */
export function buildCodexDb(codexDir, threads) {
  mkdirSync(codexDir, { recursive: true });
  const dbPath = join(codexDir, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER,
    created_at_ms INTEGER,
    updated_at INTEGER NOT NULL,
    updated_at_ms INTEGER,
    cwd TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    name TEXT
  )`);
  const insert = db.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, cwd, archived, name)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
  );
  for (const thread of threads) {
    const createdAt = thread.createdAt ?? thread.updatedAt;
    insert.run(thread.id, thread.rolloutPath, createdAt, createdAt * 1000, thread.updatedAt, thread.updatedAt * 1000, thread.cwd, thread.name ?? null);
  }
  db.close();
  return dbPath;
}

/**
 * Build a minimal Usage Guard database with the usage_snapshot table.
 * @param {string} dbPath
 * @param {Record<string, any>[]} snapshots
 */
export function buildUsageDb(dbPath, snapshots) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE usage_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    account_alias TEXT NOT NULL,
    captured_at REAL NOT NULL,
    status TEXT NOT NULL,
    session_used REAL, session_resets_at REAL,
    weekly_used REAL, weekly_resets_at REAL,
    fable_used REAL, fable_resets_at REAL,
    credit_count INTEGER, earliest_credit_expiry REAL,
    error_code TEXT
  )`);
  const insert = db.prepare(`INSERT INTO usage_snapshot
    (provider, account_alias, captured_at, status, session_used, session_resets_at,
     weekly_used, weekly_resets_at, fable_used, fable_resets_at, credit_count, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of snapshots) {
    insert.run(
      s.provider, s.account_alias, s.captured_at, s.status,
      s.session_used ?? null, s.session_resets_at ?? null,
      s.weekly_used ?? null, s.weekly_resets_at ?? null,
      s.fable_used ?? null, s.fable_resets_at ?? null,
      s.credit_count ?? null, s.error_code ?? null,
    );
  }
  db.close();
  return dbPath;
}

/** Capture console.log lines for the duration of `fn`. */
export async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.log = original;
  }
}

/** Set env vars, return a restore function. */
export function withEnv(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Resource claims: ~/.sbb/claims/<brainId>.json = `{ id, claims: [{ resource, at, note? }] }`.
// A brain claims branch:/path:/port:/device:/worktree: resources before it works, so two
// brains never fight over the same thing. docs/spec/policy.md "Claims".
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sbbDir } from '../lib/paths.js';
import { assertBrainId } from '../registry/brains.js';

/** Resource kinds the spec defines. */
export const RESOURCE_KINDS = Object.freeze(['branch', 'path', 'port', 'device', 'worktree']);

/** Invalid claim input. */
export class ClaimError extends Error {
  /** @param {string} message @param {string} [reason] */
  constructor(message, reason = 'invalid_claim') {
    super(message);
    this.name = 'ClaimError';
    this.reason = reason;
  }
}

/**
 * `branch:feat/x` -> `{ kind: 'branch', value: 'feat/x' }`.
 * @param {string} raw @returns {{ kind: string, value: string }}
 */
export function parseResource(raw) {
  const text = String(raw ?? '').trim();
  const idx = text.indexOf(':');
  if (idx < 1) throw new ClaimError(`invalid resource "${raw}": expected <kind>:<value> (${RESOURCE_KINDS.join('|')})`);
  const kind = text.slice(0, idx).toLowerCase();
  const value = text.slice(idx + 1).trim();
  if (!RESOURCE_KINDS.includes(kind)) {
    throw new ClaimError(`unknown resource kind "${kind}": expected ${RESOURCE_KINDS.join('|')}`, 'unknown_kind');
  }
  if (!value) throw new ClaimError(`invalid resource "${raw}": empty value`);
  return { kind, value };
}

/** Canonical form used for storage and comparison. */
export function normalizeResource(raw) {
  const { kind, value } = parseResource(raw);
  if (kind === 'port') return `${kind}:${value.replace(/^0+/, '') || '0'}`;
  if (kind === 'path' || kind === 'worktree') return `${kind}:${value.replace(/\/+$/, '') || '/'}`;
  return `${kind}:${value}`;
}

/**
 * Two resources of the same kind collide when equal; `path:`/`worktree:` also collide when
 * one is a prefix of the other (directory containment).
 * @param {string} a @param {string} b
 */
export function conflicts(a, b) {
  const x = parseResource(a);
  const y = parseResource(b);
  if (x.kind !== y.kind) return false;
  const left = normalizeResource(a).slice(x.kind.length + 1);
  const right = normalizeResource(b).slice(y.kind.length + 1);
  if (x.kind === 'path' || x.kind === 'worktree') {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
  return left === right;
}

/** @param {{ sbbDir?: string }} [opts] */
export function claimsDir(opts = {}) {
  return join(opts.sbbDir ?? sbbDir(), 'claims');
}

/** @param {string} brainId @param {{ sbbDir?: string }} [opts] */
export function claimsPath(brainId, opts = {}) {
  return join(claimsDir(opts), `${assertBrainId(brainId)}.json`);
}

/**
 * @param {string} brainId @param {{ sbbDir?: string }} [opts]
 * @returns {{ id: string, claims: { resource: string, at: number, note?: string }[] }}
 */
export function readClaims(brainId, opts = {}) {
  const id = assertBrainId(brainId);
  try {
    const raw = JSON.parse(readFileSync(claimsPath(id, opts), 'utf8'));
    return { id, claims: Array.isArray(raw.claims) ? raw.claims : [] };
  } catch {
    return { id, claims: [] };
  }
}

/** @param {{ id: string, claims: object[] }} record @param {{ sbbDir?: string }} [opts] */
export function writeClaims(record, opts = {}) {
  const dir = claimsDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = claimsPath(record.id, opts);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return record;
}

/** @param {string} brainId @param {{ sbbDir?: string }} [opts] */
export function removeClaims(brainId, opts = {}) {
  try {
    unlinkSync(claimsPath(brainId, opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a claim. Re-claiming the same resource is a no-op; the caller decides what to do
 * about conflicts (the claim is kept either way, per the spec).
 * @param {string} brainId @param {string} rawResource
 * @param {{ note?: string, now?: number, sbbDir?: string }} [opts]
 * @returns {{ claim: { resource: string, at: number, note?: string }, record: Record<string, any>, added: boolean }}
 */
export function addClaim(brainId, rawResource, opts = {}) {
  const resource = normalizeResource(rawResource);
  const record = readClaims(brainId, opts);
  const existing = record.claims.find((c) => c.resource === resource);
  if (existing) return { claim: existing, record, added: false };
  /** @type {{ resource: string, at: number, note?: string }} */
  const claim = { resource, at: opts.now ?? Date.now() };
  if (opts.note) claim.note = String(opts.note);
  record.claims.push(claim);
  writeClaims(record, opts);
  return { claim, record, added: true };
}

/**
 * @param {string} brainId @param {string} rawResource @param {{ sbbDir?: string }} [opts]
 * @returns {{ released: boolean, record: Record<string, any> }}
 */
export function releaseClaim(brainId, rawResource, opts = {}) {
  const resource = normalizeResource(rawResource);
  const record = readClaims(brainId, opts);
  const before = record.claims.length;
  record.claims = record.claims.filter((c) => c.resource !== resource);
  const released = record.claims.length !== before;
  if (released) {
    if (record.claims.length) writeClaims(record, opts);
    else removeClaims(brainId, opts);
  }
  return { released, record };
}

/**
 * Drop every claim a brain holds. Lifecycle calls this when a brain is killed or retired.
 * @param {string} brainId @param {{ sbbDir?: string }} [opts]
 * @returns {{ released: number }}
 */
export function releaseClaims(brainId, opts = {}) {
  const record = readClaims(brainId, opts);
  const n = record.claims.length;
  if (n) removeClaims(brainId, opts);
  return { released: n };
}

/**
 * Every claim on disk, brain id ascending.
 * @param {{ sbbDir?: string }} [opts]
 * @returns {{ brain: string, resource: string, at: number, note?: string }[]}
 */
export function listAllClaims(opts = {}) {
  const dir = claimsDir(opts);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const brain = name.slice(0, -'.json'.length);
    for (const claim of readClaims(brain, opts).claims) out.push({ brain, ...claim });
  }
  return out;
}

/**
 * Claims of `brainId` that collide with another brain's claims.
 * @param {string} brainId
 * @param {{ sbbDir?: string, brains?: { id: string, name?: string }[] }} [opts]
 * @returns {{ brain: string, name: string, resource: string }[]}
 */
export function detectConflicts(brainId, opts = {}) {
  const id = assertBrainId(brainId);
  const mine = readClaims(id, opts).claims;
  if (!mine.length) return [];
  const others = listAllClaims(opts).filter((c) => c.brain !== id);
  const out = [];
  for (const claim of mine) {
    for (const other of others) {
      if (!conflicts(claim.resource, other.resource)) continue;
      out.push({
        brain: other.brain,
        name: (opts.brains ?? []).find((b) => b.id === other.brain)?.name ?? other.brain,
        resource: claim.resource,
      });
    }
  }
  return out;
}

/**
 * Brain ids holding at least one claim that collides with another brain's.
 * @param {{ sbbDir?: string }} [opts] @returns {Set<string>}
 */
export function conflictedBrainIds(opts = {}) {
  const all = listAllClaims(opts);
  const hit = new Set();
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (all[i].brain === all[j].brain) continue;
      if (conflicts(all[i].resource, all[j].resource)) {
        hit.add(all[i].brain);
        hit.add(all[j].brain);
      }
    }
  }
  return hit;
}

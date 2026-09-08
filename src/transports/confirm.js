// Screen confirmation for transports that cannot obtain a protocol receipt:
// Claude `uds` (measured 2026-09-09: a normal delivery sends no `peer_message_status`)
// and `codex queue` (no receipt exists). Polls the target pane and the Claude session
// registry. Never sends keys. See docs/spec/protocols.md sections 1 and 2.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as tmuxLib from '../lib/tmux.js';
import { accountByName } from '../lib/paths.js';
import { collapse, profileFor } from './cli-profiles.js';

/** @typedef {import('../types.js').Target} Target */

export const CONFIRMED = 'delivered';
export const PENDING = 'pending';

/** How much of the body to look for on screen. */
export const BODY_PROBE_CHARS = 60;
const CAPTURE_LINES = 60;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Whitespace-insensitive form: a wrapped pane line breaks the text, and sometimes inserts
 * a space at the break, so exact matching on the raw capture would miss it.
 */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * Registry file of the live Claude session behind this target, or undefined when the
 * target carries no Claude session or its account has no config dir.
 * @param {Target} target
 * @returns {string|undefined}
 */
export function claudeSessionFile(target) {
  const pid = target?.claude?.pid;
  if (!pid) return undefined;
  const dir = accountByName(target.account)?.claudeDir;
  return dir ? join(dir, 'sessions', `${pid}.json`) : undefined;
}

/**
 * Live `status` ('busy' | 'idle') from the session registry, or undefined when the file
 * is gone (session exited) or mid-write. Unknown is not an error: the screen signals
 * still decide, and a failed read never counts as a signal.
 * @param {Target} target
 * @param {{ file?: string }} [opts]
 * @returns {Promise<string|undefined>}
 */
export async function readClaudeStatus(target, { file } = {}) {
  const path = file ?? claudeSessionFile(target);
  if (!path) return undefined;
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined; // partial write; the next poll reads it again
  }
}

/**
 * Confirm that a message reached the target's screen.
 *
 * Delivered when any of these holds:
 *  - the screen shows `Message from @<fromName>` (the wrapper line Claude draws)
 *  - an idle pane already shows the first 60 chars of the body (an idle composer is
 *    empty, so that text cannot be an unsent draft)
 *  - the CLI profile's own `submitted()` verdict for baseline -> current is delivered or
 *    queued: a new transcript echo, a newly queued follow-up, or idle -> busy
 *  - the Claude session registry status goes idle -> not idle
 *
 * Otherwise 'pending' at the timeout. Never sends keys, and never reports delivered from
 * a pane it could not read.
 *
 * @param {Target} target
 * @param {{ text: string, fromName?: string }} message
 * @param {{
 *   tmuxApi?: typeof tmuxLib,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   readStatus?: (target: Target) => Promise<string|undefined>,
 * }} [opts]
 * @returns {Promise<'delivered'|'pending'>}
 */
export async function confirmOnScreen(target, { text, fromName } = {}, {
  tmuxApi = tmuxLib,
  sleep = defaultSleep,
  timeoutMs = 4000,
  pollMs = 500,
  readStatus = readClaudeStatus,
} = {}) {
  const paneId = target?.paneId;
  if (!paneId) return PENDING;

  const profile = profileFor(target?.cli);
  const probe = squash(collapse(text).slice(0, BODY_PROBE_CHARS));
  const marker = fromName ? squash(`Message from @${fromName}`) : undefined;

  // Nothing this transport sends contains the wrapper line, so a match means it is on the
  // pane. Squashed, because the terminal may wrap the line between '@' and the name.
  const markerHit = (screen) => Boolean(marker) && squash(screen).includes(marker);
  const landedHit = (screen) => Boolean(probe) && profile.idle(screen) && squash(screen).includes(probe);
  const verdictHit = (before, after) => ['delivered', 'queued'].includes(profile.submitted(before, after, text));

  const capture = async () => {
    try {
      return await tmuxApi.capturePane(paneId, CAPTURE_LINES);
    } catch {
      return undefined; // unreachable pane contributes no signal, never a fake delivered
    }
  };

  const baseline = await capture();
  if (baseline === undefined) return PENDING;
  if (markerHit(baseline) || landedHit(baseline)) return CONFIRMED;

  const trackStatus = Boolean(target?.claude?.pid);
  const baselineStatus = trackStatus ? await readStatus(target) : undefined;
  const statusHit = (current) => baselineStatus === 'idle' && current !== undefined && current !== 'idle';

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const screen = await capture();
    if (screen !== undefined && (markerHit(screen) || verdictHit(baseline, screen))) return CONFIRMED;
    if (trackStatus && statusHit(await readStatus(target))) return CONFIRMED;
  }
  return PENDING;
}

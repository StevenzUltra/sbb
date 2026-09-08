// Shared CLI helpers: argument parsing, exit codes, receipt printing and the
// send path (envelope -> router -> receipt log). Not a command itself.
import { parseArgs } from 'node:util';
import { send as defaultSend, transports as defaultTransports } from '../transports/index.js';
import { newMsgId } from '../lib/ids.js';
import { buildEnvelope, identityFromRows } from '../registry/envelope.js';
import { appendReceipt, formatReceiptLine } from '../registry/receipts.js';
import { roster as defaultRoster } from '../registry/roster.js';

/** Exit codes from docs/spec/receipts.md. */
export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  UNVERIFIED: 3,
  BLOCKED: 4,
  TIMEOUT: 5,
});

/** Bad command line. The caller prints `message` and returns EXIT.USAGE. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * util.parseArgs with strict unknown-option checking.
 * @param {string[]} argv
 * @param {Record<string, any>} options
 */
export function parse(argv, options = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err?.message ?? String(err));
  }
}

/** @param {unknown} value */
export function writeJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * @param {string[]} headers
 * @param {(string|number|null|undefined)[][]} rows
 * @param {{ align?: ('l'|'r')[] }} [opts]
 */
export function renderTable(headers, rows, opts = {}) {
  const cells = rows.map((row) => row.map((c) => (c === null || c === undefined ? '-' : String(c))));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (row) =>
    row
      .map((cell, i) => {
        const text = String(cell ?? '-');
        return opts.align?.[i] === 'r' ? text.padStart(widths[i]) : text.padEnd(widths[i]);
      })
      .join('  ')
      .replace(/\s+$/, '');
  return [line(headers), ...cells.map(line)].join('\n');
}

/** `30s`, `5m`, `1h`, `500ms` -> milliseconds. */
export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!match) throw new UsageError(`invalid duration "${text}" (use 30s, 5m, 1h)`);
  const unit = match[2] ?? 's';
  const factor = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return Number(match[1]) * factor;
}

/**
 * Preferred transport ids per CLI. Mirrors CHAIN in src/transports/index.js; update
 * both if the router changes. Used by --dry-run, which must not send anything.
 */
export const CHAIN_PREVIEW = Object.freeze({
  claude: ['uds', 'send-keys'],
  codex: ['codex-queue', 'send-keys'],
  agy: ['send-keys'],
  cursor: ['send-keys'],
  other: ['send-keys'],
});

/**
 * @param {import('../types.js').Target} target
 * @param {Record<string, any>} [transports]
 */
export function previewTransport(target, transports = defaultTransports) {
  const order = CHAIN_PREVIEW[target.cli] ?? CHAIN_PREVIEW.other;
  const byId = Object.values(transports).filter((t) => t && typeof t.id === 'string');
  for (const id of order) {
    const transport = byId.find((t) => t.id === id);
    if (transport?.supports?.(target)) return { id, available: true };
  }
  return { id: order[order.length - 1], available: false };
}

/**
 * The caller's identity from $TMUX_PANE, or the user when not inside tmux.
 * @param {{ rows?: any[], roster?: Function, paneId?: string }} [deps]
 */
export async function callerIdentity(deps = {}) {
  const paneId = deps.paneId ?? process.env.TMUX_PANE;
  const rows = deps.rows ?? (await (deps.roster ?? defaultRoster)({ withStatus: false, onWarn: deps.onWarn }));
  const identity = identityFromRows({ paneId, rows });
  const address = identity.brain
    ?? (identity.account && identity.cli && identity.coord
      ? `${identity.account}/${identity.cli}:${identity.coord}`
      : null);
  return { ...identity, address, paneId: paneId ?? null };
}

/**
 * Build the envelope, route it and log the receipt.
 * @param {{ target: import('../types.js').Target, body: string, msgId?: string,
 *           priority?: import('../types.js').Priority, replyTo?: string,
 *           fromSock?: string|null, verifyTimeoutMs?: number, dryRun?: boolean,
 *           identity?: Record<string, any>, send?: Function }} input
 */
export async function deliver(input) {
  const send = input.send ?? defaultSend;
  const msgId = input.msgId ?? newMsgId();
  const identity = input.identity ?? (await callerIdentity(input.deps ?? {}));
  const text = buildEnvelope({ ...identity, body: input.body, msgId });
  const message = {
    msgId,
    text,
    priority: input.priority ?? 'next',
    replyTo: input.replyTo,
    fromBrain: identity.brain ?? 'user',
    fromSock: input.fromSock ?? undefined,
  };
  const receipt = await send(input.target, message, { verifyTimeoutMs: input.verifyTimeoutMs });
  const entry = {
    msgId,
    from: identity.brain ?? identity.sender,
    fromAddress: identity.address ?? null,
    fromSock: input.fromSock ?? null,
    to: input.target.brain ?? input.target.address,
    address: input.target.address,
    status: receipt.status,
    via: receipt.via,
    elapsedMs: receipt.elapsedMs,
    reason: receipt.reason ?? null,
    textPreview: text.slice(0, 200),
  };
  if (!input.dryRun) appendReceipt(entry);
  return { receipt, text, identity, entry, message };
}

/** @param {import('../types.js').Receipt} receipt */
export function receiptExitCode(receipt) {
  if (receipt.status === 'delivered' || receipt.status === 'queued') return EXIT.OK;
  if (receipt.status === 'unverified') return EXIT.UNVERIFIED;
  return EXIT.BLOCKED;
}

/** @param {import('../types.js').Receipt} receipt @param {{json?: boolean}} [opts] */
export function printReceipt(receipt, opts = {}) {
  if (opts.json) writeJson(receipt);
  else console.log(formatReceiptLine(receipt));
}

/** Wrap a command body so ResolveError/UsageError map to the documented exit codes. */
export async function main(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`sbb: ${err.message}`);
      return EXIT.USAGE;
    }
    if (err?.name === 'ResolveError') {
      console.error(`sbb: blocked: ${err.reason}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      return EXIT.BLOCKED;
    }
    console.error(`sbb: ${err?.stack ?? err}`);
    return EXIT.INTERNAL;
  }
}

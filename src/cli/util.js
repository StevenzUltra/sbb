// Shared CLI helpers: argument parsing, exit codes, receipt printing and the
// send path (envelope -> sender inbox -> router -> receipt log). Not a command itself.
import { parseArgs } from 'node:util';
import { send as defaultSend, transports as defaultTransports } from '../transports/index.js';
import { sendToInbox as defaultSendToInbox } from '../transports/claude-uds.js';
import { newMsgId, shortId } from '../lib/ids.js';
import { claudeSocksDirs, claudeSessionsDir, discoverAccounts } from '../lib/paths.js';
import { formatCoordFull } from '../lib/coord.js';
import { serverSocketPath } from '../lib/tmux.js';
import { findKeyFile } from '../registry/claude-sessions.js';
import { buildEnvelope, identityFromRows, senderName } from '../registry/envelope.js';
import { appendReceipt, formatReceiptLine } from '../registry/receipts.js';
import { writeInboxEntry } from '../registry/inbox.js';
import { roster as defaultRoster } from '../registry/roster.js';
import { getBrain as defaultGetBrain } from '../registry/brains.js';
import { readConfig } from '../policy/config.js';
import { writeHold } from '../policy/held.js';
import { checkQuotaFloor } from '../policy/quota.js';
import { check as checkPolicy } from '../policy/rules.js';
import { readQuota } from '../quota/usage-guard.js';

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

/** A delivery refused by the policy or quota gate. `main` prints the canonical blocked line. */
export class PolicyBlockedError extends Error {
  /** @param {import('../types.js').Receipt} receipt */
  constructor(receipt) {
    super(`blocked: ${receipt.reason}`);
    this.name = 'PolicyBlockedError';
    this.receipt = receipt;
  }
}

/** `blocked  msg=… via=policy reason=<why> detail=<detail>; 请向上级或用户上报` (policy.md). */
export function policyBlockLine(receipt) {
  const detail = receipt.detail ? `  detail=${receipt.detail}` : '';
  return `blocked     msg=${shortId(receipt.msgId)}  via=policy  reason=${receipt.reason}${detail}; 请向上级或用户上报`;
}

/** @param {Record<string, any>} input @param {{reason: string, detail: string}} why */
function blockResult(input, why, sender, targetInfo) {
  const receipt = {
    status: 'blocked',
    via: 'policy',
    msgId: input.msgId,
    elapsedMs: 0,
    reason: why.reason,
    detail: why.detail,
  };
  return {
    receipt,
    entry: {
      msgId: input.msgId,
      from: sender.name,
      fromId: sender.id,
      fromAddress: sender.address,
      fromSock: input.message?.fromSock ?? null,
      to: targetInfo.brain ?? targetInfo.address,
      toId: targetInfo.brainId,
      address: targetInfo.address,
      status: 'blocked',
      via: 'policy',
      elapsedMs: 0,
      reason: why.reason,
      detail: why.detail,
      textPreview: String(input.text ?? '').slice(0, 200),
      senderSock: input.senderSession?.senderSock ?? null,
      senderPid: input.senderSession?.senderPid ?? null,
      fromCoordFull: formatCoordFull(sender.coord, input.serverPath),
      toCoordFull: formatCoordFull(targetInfo.coord, input.serverPath),
    },
  };
}

/**
 * The gate every outbound delivery passes: policy verdict first (moderated messages are
 * parked in ~/.sbb/held), then the weekly quota floor of the target's account. Returns a
 * `{receipt, entry}` to refuse with, or null to send. `skipPolicy` is for protocol notices
 * SBB itself sends; `force` (CLI `--force` or `SBB_FORCE=1`) bypasses the quota floor only,
 * never moderation. `senderSession`/`serverPath` are recorded on the blocked receipt exactly
 * as `deliver` records them on a sent one.
 * @param {{ target: import('../types.js').Target, identity: Record<string, any>,
 *           message: Record<string, any>, text: string, msgId: string, replyTo?: string,
 *           force?: boolean, skipPolicy?: boolean, deps?: Record<string, any>, sbbDir?: string,
 *           senderSession?: { senderSock: string|null, senderPid: number|null },
 *           serverPath?: string|null }} input
 */
export async function enforceDelivery(input) {
  const deps = input.deps ?? {};
  const env = deps.env ?? process.env;
  const target = input.target;
  const getBrain = deps.getBrain ?? defaultGetBrain;
  const targetBrain = target?.brainId ? getBrain(target.brainId) ?? null : null;
  if (!targetBrain) return null;
  const sender = {
    name: input.identity?.brain ?? input.identity?.sender ?? 'user',
    id: input.identity?.id ?? null,
    address: input.identity?.address ?? null,
    account: input.identity?.account ?? null,
    cli: input.identity?.cli ?? null,
    coord: input.identity?.coord ?? null,
    role: input.identity?.role ?? null,
  };
  const targetInfo = {
    address: target.address,
    brain: target.brain ?? null,
    brainId: target.brainId ?? null,
    account: target.account,
    cli: target.cli,
    paneId: target.paneId,
    coord: target.coord,
  };
  const config = await (deps.readConfig ?? readConfig)({ sbbDir: input.sbbDir });

  if (!input.skipPolicy) {
    const senderBrain = sender.id ? getBrain(sender.id) ?? null : null;
    const verdict = (deps.checkPolicy ?? checkPolicy)(senderBrain, targetBrain, config, { getBrain });
    if (!verdict.ok) {
      if (verdict.moderated) {
        writeHold({
          msgId: input.msgId,
          message: input.message,
          target: targetInfo,
          sender,
          verdict,
          sbbDir: input.sbbDir,
        });
        return blockResult(input, {
          reason: 'moderated',
          detail: `held for user approval: sbb approve ${shortId(input.msgId)}`,
        }, sender, targetInfo);
      }
      return blockResult(input, { reason: 'policy', detail: verdict.detail }, sender, targetInfo);
    }
  }

  const force = input.force ?? deps.force ?? env?.SBB_FORCE === '1';
  if (force || input.replyTo) return null; // answers are not new outbound work
  let rows = [];
  try {
    rows = (await (deps.readQuota ?? readQuota)({ env })) ?? [];
  } catch {
    rows = []; // Usage Guard unavailable: an unknown reading never blocks
  }
  const quota = checkQuotaFloor({ account: target.account, config, rows });
  if (!quota.ok) return blockResult(input, { reason: 'quota', detail: quota.detail }, sender, targetInfo);
  return null;
}

/**
 * util.parseArgs with strict unknown-option checking.
 * @param {string[]} argv
 * @param {Record<string, any>} options
 * @param {{ allowNegative?: boolean }} [extra] `allowNegative` lets a boolean option be
 *   spelled `--no-<name>` (used by `sbb ui --no-open`).
 */
export function parse(argv, options = {}, extra = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true, ...extra });
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

/**
 * `6000` (milliseconds: docs/spec/cli.md documents `--timeout <ms>`), `500ms`, `30s`, `5m`,
 * `1h` -> milliseconds. A bare number is milliseconds, never seconds: `--timeout 6000` means
 * 6 s, and reading it as 6000 s once left `sbb tell` waiting 100 minutes for a receipt.
 */
export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!match) throw new UsageError(`invalid duration "${text}" (use 6000, 30s, 5m, 1h)`);
  const unit = match[2] ?? 'ms';
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
 * The sending session's own Claude socket. `CLAUDE_CODE_MESSAGING_SOCKET` is set inside a
 * Claude session's Bash and outlives the transient ask/tell inbox a receipt records as
 * `fromSock`, so it survives a restarted ask and a stale coord.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ senderSock: string|null, senderPid: number|null }}
 */
export function senderSessionFromEnv(env = process.env) {
  const raw = env?.CLAUDE_CODE_MESSAGING_SOCKET;
  const path = typeof raw === 'string' ? raw.trim() : '';
  if (!path) return { senderSock: null, senderPid: null };
  const sock = path.startsWith('uds:') ? path : `uds:${path}`;
  const match = /(\d+)\.sock$/.exec(path);
  return { senderSock: sock, senderPid: match ? Number(match[1]) : null };
}

/**
 * A Claude target built from a live session socket: the account whose sessions directory
 * holds `<pid>.*.key` names the account, and that key file carries the peer token the uds
 * transport authenticates with. Null when no account owns the pid.
 * @param {string} sockPath
 * @param {{ accounts?: import('../types.js').Account[] }} [opts]
 * @returns {import('../types.js').Target|null}
 */
export function targetFromSessionSock(sockPath, opts = {}) {
  const path = String(sockPath ?? '').trim();
  if (!path) return null;
  const pid = Number(/(\d+)\.sock$/.exec(path)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  for (const account of opts.accounts ?? discoverAccounts()) {
    const dir = claudeSessionsDir(account);
    const keyFile = dir ? findKeyFile(dir, pid) : undefined;
    if (!keyFile) continue;
    return {
      address: `uds:${path}`,
      account: account.name,
      cli: 'claude',
      paneId: null,
      coord: null,
      claude: { sock: path, keyFile },
    };
  }
  return null;
}

/**
 * The tmux server this process talks to, or null. `input.serverPath` / `deps.serverPath`
 * (string or null) win so tests never have to reach a real tmux server.
 * @param {Record<string, any>} input
 * @returns {Promise<string|null>}
 */
async function resolveServerPath(input) {
  const dep = input.serverPath ?? input.deps?.serverPath;
  if (dep !== undefined) return dep ?? null;
  try {
    return await serverSocketPath();
  } catch {
    return null;
  }
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

/** Permission modes a peer understands; the spec says omit `from-mode` when unknown. */
export const FROM_MODES = Object.freeze(['bypass', 'prompting']);

/**
 * `SBB_FROM_MODE` is the only way a caller can declare its own permission mode; a value
 * outside the protocol vocabulary is refused rather than sent to the peer.
 * @param {Record<string, string|undefined>} [env]
 * @returns {'bypass'|'prompting'|undefined}
 */
export function fromModeFromEnv(env = process.env) {
  const raw = env?.SBB_FROM_MODE;
  if (!raw) return undefined;
  if (FROM_MODES.includes(raw)) return /** @type {'bypass'|'prompting'} */ (raw);
  console.error(`sbb: warning: ignoring SBB_FROM_MODE="${raw}" (expected ${FROM_MODES.join('|')})`);
  return undefined;
}

/** Directory the sender inbox listens in: the primary Claude socket dir. */
export function deliveryInboxDir() {
  return claudeSocksDirs()[0];
}

/**
 * Split a received `user` frame into an inbox entry. Claude peers wrap the body in
 * `<cross-session-message from="..." from-name="...">`; plain content is kept as is.
 * @param {Record<string, any>} frame
 */
export function parsePeerFrame(frame) {
  const raw = typeof frame?.message?.content === 'string' ? frame.message.content : '';
  const match = /^<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>\s*$/.exec(raw.trim());
  const attrs = match ? parseAttrs(match[1]) : {};
  return {
    msgId: String(frame?.msg_id ?? '') || newMsgId(),
    from: attrs['from-name'] ?? null,
    fromSock: attrs.from ?? null,
    fromAddress: attrs.from ?? null,
    replyTo: frame?.reply_to ?? frame?.replyTo ?? null,
    text: (match ? match[2] : raw).trim(),
    source: 'uds',
  };
}

/** @param {string} text */
function parseAttrs(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of String(text).matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Start the sender-side inbox. Only a `claude` target can send receipts back over uds;
 * everything else gets no inbox and no `fromSock`. A socket that cannot be created is
 * reported once and the send continues (the receipt will say `queued`).
 * @param {{ target: import('../types.js').Target, owner: string, deps?: Record<string, any> }} input
 * @returns {Promise<import('../transports/uds-inbox.js').Inbox|undefined>}
 */
export async function openDeliveryInbox({ target, owner, deps = {} }) {
  if (target?.cli !== 'claude') return undefined;
  let inbox;
  try {
    if (deps.startInbox) inbox = await deps.startInbox({ dir: deliveryInboxDir() });
    else {
      const mod = await import('../transports/uds-inbox.js');
      inbox = await mod.startInbox({ dir: deliveryInboxDir() });
    }
  } catch (err) {
    console.error(`sbb: warning: inbox unavailable (${err?.message ?? err}); receipts cannot be received`);
    return undefined;
  }
  if (!inbox) return undefined;
  attachInboxHandlers(inbox, { owner, deps });
  return inbox;
}

/**
 * Persist what the inbox receives while the send is in flight: peer status frames go to
 * the receipt log, peer `user` frames become inbox entries for this brain (or the user).
 * @param {import('../transports/uds-inbox.js').Inbox} inbox
 * @param {{ owner: string, deps?: Record<string, any> }} input
 */
export function attachInboxHandlers(inbox, { owner, deps = {} }) {
  const append = deps.appendReceipt ?? appendReceipt;
  const writeEntry = deps.writeInboxEntry ?? writeInboxEntry;
  inbox.on('receipt', (frame) => {
    append({
      kind: 'peer-status',
      msgId: frame?.orig_msg_id ?? null,
      status: frame?.status ?? null,
      statusDetail: frame?.status_detail ?? null,
      dropReason: frame?.drop_reason ?? null,
      fromSock: frame?.from ?? null,
      owner,
    });
  });
  inbox.on('message', (frame) => {
    writeEntry({ owner, entry: parsePeerFrame(frame) });
  });
  inbox.on('error', (err) => {
    console.error(`sbb: warning: inbox: ${err?.message ?? err}`);
  });
}

/**
 * Build the envelope, start the sender inbox, route it and log the receipt.
 * @param {{ target: import('../types.js').Target, body: string, msgId?: string,
 *           priority?: import('../types.js').Priority, replyTo?: string,
 *           inbox?: import('../transports/uds-inbox.js').Inbox, verifyTimeoutMs?: number,
 *           inboxSock?: string|null, sendToInbox?: Function,
 *           dryRun?: boolean, identity?: Record<string, any>, send?: Function,
 *           deps?: Record<string, any> }} input
 */
export async function deliver(input) {
  const send = input.send ?? defaultSend;
  const msgId = input.msgId ?? newMsgId();
  const identity = input.identity ?? (await callerIdentity(input.deps ?? {}));
  const env = input.deps?.env ?? process.env;
  const senderSession = input.senderSession ?? senderSessionFromEnv(env);
  const serverPath = await resolveServerPath(input);
  const text = buildEnvelope({ ...identity, body: input.body, msgId });
  const fromName = senderName(identity);
  const inbox = input.inbox;
  const message = {
    msgId,
    text,
    priority: input.priority ?? 'next',
    replyTo: input.replyTo,
    fromBrain: identity.brain ?? 'user',
    fromSock: inbox?.sockPath ? `uds:${inbox.sockPath}` : undefined,
    fromName,
    fromMode: fromModeFromEnv(env),
  };
  const blocked = await (input.enforceDelivery ?? enforceDelivery)({
    target: input.target,
    identity,
    message,
    text,
    msgId,
    replyTo: input.replyTo,
    force: input.force,
    skipPolicy: input.skipPolicy,
    senderSession,
    serverPath,
    deps: input.deps ?? {},
    sbbDir: input.sbbDir,
  });
  if (blocked) {
    if (!input.dryRun) appendReceipt(blocked.entry);
    throw new PolicyBlockedError(blocked.receipt);
  }
  // Screen confirmation is the router's job (src/transports/index.js); deliver only
  // carries the inbox and the from* fields the transports need.
  // `inboxSock` is a waiting listener found in the receipt log (src/cli/reply.js). A plain
  // inbox answers with nothing, so that path can only report `queued`.
  const receipt = input.inboxSock
    ? (await (input.sendToInbox ?? defaultSendToInbox)({ sockPath: input.inboxSock, message })).receipt
    : await send(input.target, message, { verifyTimeoutMs: input.verifyTimeoutMs, inbox });
  const entry = {
    msgId,
    from: identity.brain ?? identity.sender,
    fromId: identity.id ?? null,
    fromAddress: identity.address ?? null,
    fromSock: message.fromSock ?? null,
    senderSock: senderSession.senderSock,
    senderPid: senderSession.senderPid,
    fromCoordFull: formatCoordFull(identity.coord, serverPath),
    to: input.target.brain ?? input.target.address,
    toId: input.target.brainId ?? null,
    address: input.target.address,
    toCoordFull: formatCoordFull(input.target.coord, serverPath),
    status: receipt.status,
    via: receipt.via,
    elapsedMs: receipt.elapsedMs,
    reason: receipt.reason ?? null,
    textPreview: text.slice(0, 200),
  };
  if (!input.dryRun) appendReceipt(entry);
  // Mirror every delivery to a registered brain into that brain's inbox. The transports
  // cannot tell the recipient's own `ask`/`collect` that a message arrived: a codex-queue
  // answer lands in the target's session, never on its socket (rehearsal 2026-09-09).
  // docs/spec/receipts.md "Inbox".
  if (!input.dryRun && input.target?.brainId && receipt.status !== 'blocked') {
    (input.deps?.writeInboxEntry ?? writeInboxEntry)({
      owner: input.target.brainId,
      entry: {
        msgId,
        from: identity.brain ?? identity.sender ?? 'user',
        fromId: identity.id ?? null,
        fromAddress: identity.address ?? null,
        replyTo: input.replyTo ?? null,
        text,
        t: Date.now(),
        via: receipt.via,
        status: receipt.status,
      },
    });
  }
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
    if (err instanceof PolicyBlockedError) {
      console.log(policyBlockLine(err.receipt));
      return EXIT.BLOCKED;
    }
    if (err?.name === 'ResolveError') {
      console.error(`sbb: blocked: ${err.reason}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      return EXIT.BLOCKED;
    }
    console.error(`sbb: ${err?.stack ?? err}`);
    return EXIT.INTERNAL;
  }
}

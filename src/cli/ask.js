// sbb ask: tell, then wait for a reply or a peer idle notice. docs/spec/cli.md.
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { newMsgId } from '../lib/ids.js';
import { appendReceipt } from '../registry/receipts.js';
import { findReply, listInbox } from '../registry/inbox.js';
import { checkChannel, isChannelAddress, resolveChannel, sendToChannel } from '../teams/index.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  channelBlockEntry,
  deliver,
  main,
  openDeliveryInbox,
  openSenderInbox,
  parse,
  parseDuration,
  policyBlockLine,
  previewTransport,
} from './util.js';

const USAGE = `usage: sbb ask <address|#channel> <text...> [--wait <ms|30s|5m|1h>] [--priority now|next|later] [--role <text>] [--force]

A #channel ask fans out to every member and then prints every reply that arrives before
--wait expires, exiting 0 as soon as at least one did.

Waits (default 10m) for a reply carrying replyTo = the message id, a frame from the
target's own socket, a body carrying the envelope marker, or a Claude
peer_idle_notice. A delivery merely mirrored from the target is a fallback candidate:
it is printed as via=mirror-fallback only if nothing exact arrives before --wait
expires. Exit 0 on reply or idle, 5 on timeout.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      wait: { type: 'string' },
      priority: { type: 'string' },
      role: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length < 2) throw new UsageError('ask needs <address> and text');
    const address = positionals[0];
    const body = positionals.slice(1).join(' ').trim();
    const waitMs = values.wait ? parseDuration(values.wait) : 10 * 60 * 1000;
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = deps.now ?? (() => Date.now());

    const identity = await callerIdentity(deps);
    if (values.role) identity.role = values.role;

    if ((deps.isChannelAddress ?? isChannelAddress)(address)) {
      return askChannel({ address, body, identity, waitMs, values, deps });
    }

    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn, rows: deps.rows });
    const owner = identity.brain ?? 'user';
    // A reply may land in the brain-id mirror instead of the name-keyed inbox; read both.
    const owners = [identity.id, owner].filter((v, i, a) => v && a.indexOf(v) === i);
    // The inbox stays open for the whole wait: replies and idle notices arrive while polling.
    const inbox = await openDeliveryInbox({ target, owner, deps });

    /** @type {string[]} */
    const idleNotices = [];
    inbox?.on?.('idle', (notice) => idleNotices.push(notice));

    // Only what arrives after this point can be the answer: an older message from the
    // target is not a reply to this question.
    const since = now();
    const targetSock = peerSock(target?.claude?.sock);

    try {
      const { receipt, text, message } = await deliver({
        target,
        body,
        priority: values.priority ?? 'next',
        identity,
        force: values.force,
        deps,
        send: deps.send,
        msgId: deps.msgId,
        inbox,
      });
      console.log(`${receipt.status.padEnd(10)} msg=${receipt.msgId.slice(0, 8)}  via=${receipt.via}  ${(receipt.elapsedMs / 1000).toFixed(1)}s${receipt.reason ? `  reason=${receipt.reason}` : ''}`);
      console.log(`envelope  ${text}`);

      const deadline = now() + waitMs;
      const pollMs = deps.pollMs ?? 500;
      /** A mirror match is only a fallback: it is held until the deadline. */
      let candidate = null;
      for (;;) {
        const reply = matchReply(owners, message.msgId, {
          since,
          targetSock,
          from: [target?.brain, target?.brainId].filter(Boolean),
        });
        // The exact tiers (replyTo, target socket, body marker) are the answer. A mirror
        // entry - any delivery from the target into our id inbox - is not: in rehearsal
        // run 15 the target's progress note "翻译任务已分派给 ios" arrived that way and ask
        // returned it 12 s before the real summary, which never got read.
        if (reply && reply.match !== 'mirror') {
          printReply(reply.entry, reply.match);
          return EXIT.OK;
        }
        if (reply) candidate = reply;
        const idle = idleNotices.find((n) => n?.orig_msg_id === message.msgId) ?? idleNotices[0];
        if (idle) {
          console.log(`idle      state=${idle.state ?? '-'}${idle.detail ? `  ${idle.detail}` : ''}`);
          return EXIT.OK;
        }
        if (now() >= deadline) {
          if (candidate) {
            printReply(candidate.entry, 'mirror-fallback');
            return EXIT.OK;
          }
          console.log('timeout');
          return EXIT.TIMEOUT;
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      }
    } finally {
      await inbox?.close?.();
      await (deps.closeInboxes ?? closeInboxes)();
    }
  });
}

/**
 * A `uds:` address is compared without its prefix: one side may carry it and the other not.
 * @param {string|undefined} sock
 * @returns {string|null}
 */
function peerSock(sock) {
  const value = String(sock ?? '');
  if (!value) return null;
  return value.startsWith('uds:') ? value.slice('uds:'.length) : value;
}

/**
 * The peer's answer, four ways, strongest first. A `sbb reply` carries `replyTo`; a peer
 * answering with Claude's own SendMessage carries no reply id at all (measured 2026-09-09:
 * the frame for "好" had replyTo null), so the first frame in the window from the target's
 * own socket counts, and so does any body carrying the envelope's own `sbb:<msgId first 8>`
 * marker. Last, the newest delivery mirror entry (`~/.sbb/inbox/<brain id>/`) whose `from` is
 * the target itself: a codex-queue answer arrives that way with no socket and no marker. That
 * tier is only a candidate - the caller keeps waiting and reports it as `mirror-fallback` at
 * the deadline, because a target also mirrors its intermediate progress notes.
 * @param {string|string[]} owners name-keyed inbox and the brain-id mirror
 * @param {string} msgId
 * @param {{ since?: number, targetSock?: string|string[]|null, from?: string[] }} [ctx]
 * @returns {{ entry: Record<string, any>, match: 'replyTo'|'fromSock'|'body'|'mirror' }|undefined}
 */
export function matchReply(owners, msgId, { since = 0, targetSock = null, from = [] } = {}) {
  const list = (Array.isArray(owners) ? owners : [owners]).filter(Boolean);
  const all = list.flatMap((owner) => listInbox(owner));
  const exact = all.find(({ entry }) => entry.replyTo === msgId);
  if (exact) return { entry: exact.entry, match: 'replyTo' };
  const marker = `sbb:${String(msgId).slice(0, 8)}`;
  const fromSet = new Set(from.filter(Boolean));
  const socks = new Set((Array.isArray(targetSock) ? targetSock : [targetSock]).filter(Boolean).map(peerSock));
  for (const { entry } of all) {
    if ((entry.t ?? 0) < since) continue;
    if (socks.size && socks.has(peerSock(entry.fromSock))) return { entry, match: 'fromSock' };
    if (String(entry.text ?? '').includes(marker)) return { entry, match: 'body' };
  }
  let newest;
  for (const { entry } of all) {
    if ((entry.t ?? 0) < since) continue;
    if (!(fromSet.has(entry.from) || fromSet.has(entry.fromId))) continue;
    if (newest === undefined || (entry.t ?? 0) > (newest.entry.t ?? 0)) newest = { entry, match: 'mirror' };
  }
  return newest;
}

/** @param {Record<string, any>} entry @param {string} via */
function printReply(entry, via) {
  console.log(`reply     msg=${String(entry.msgId).slice(0, 8)} from=${entry.from ?? '-'}  via=${via}`);
  console.log(String(entry.text ?? ''));
}

/**
 * Every answer to one channel message: the exact tiers (replyTo, a member's own socket, the
 * envelope marker) and, separately, the mirror candidates a member's delivery left behind.
 * Mirrors are never printed as answers until the deadline, exactly like the single-target
 * ask (docs/spec/cli.md).
 * @param {string|string[]} owners
 * @param {string} msgId
 * @param {{ since?: number, socks?: string[], from?: string[] }} [ctx]
 * @returns {{ exact: { entry: Record<string, any>, match: string }[], mirrors: { entry: Record<string, any>, match: string }[] }}
 */
export function collectChannelReplies(owners, msgId, { since = 0, socks = [], from = [] } = {}) {
  const list = (Array.isArray(owners) ? owners : [owners]).filter(Boolean);
  const all = list
    .flatMap((owner) => listInbox(owner))
    .sort((a, b) => (a.entry.t ?? 0) - (b.entry.t ?? 0));
  const marker = `sbb:${String(msgId).slice(0, 8)}`;
  const sockSet = new Set(socks.map(peerSock).filter(Boolean));
  const fromSet = new Set(from.filter(Boolean));
  /** @type {{ entry: Record<string, any>, match: string }[]} */
  const exact = [];
  /** @type {{ entry: Record<string, any>, match: string }[]} */
  const mirrors = [];
  const seen = new Set();
  for (const { entry } of all) {
    if (entry.msgId) {
      if (seen.has(entry.msgId)) continue;
      seen.add(entry.msgId);
    }
    if (entry.replyTo === msgId) exact.push({ entry, match: 'replyTo' });
    else if ((entry.t ?? 0) >= since && sockSet.size && sockSet.has(peerSock(entry.fromSock))) exact.push({ entry, match: 'fromSock' });
    else if ((entry.t ?? 0) >= since && String(entry.text ?? '').includes(marker)) exact.push({ entry, match: 'body' });
    else if ((entry.t ?? 0) >= since && (fromSet.has(entry.from) || fromSet.has(entry.fromId))) mirrors.push({ entry, match: 'mirror' });
  }
  return { exact, mirrors };
}

/**
 * `sbb ask #<main>` / `#all`: fan out, then print every reply that arrives before `--wait`
 * expires. Exit 0 when at least one did, 5 on timeout.
 * @returns {Promise<number>} exit code
 */
async function askChannel({ address, body, identity, waitMs, values, deps }) {
  const channel = (deps.resolveChannel ?? resolveChannel)(address, {
    getBrain: deps.getBrain,
    listBrains: deps.listBrains,
  });
  const gate = checkChannel(channel, identity);
  const msgId = deps.msgId ?? newMsgId();
  if (!gate.ok) {
    const entry = channelBlockEntry({ identity, channel, address, body, msgId, detail: gate.detail, deps });
    (deps.appendReceipt ?? appendReceipt)(entry);
    if (values.json) writeJson({ ...entry, receipts: [] });
    else console.log(policyBlockLine({ msgId, reason: 'policy', detail: gate.detail }));
    return EXIT.BLOCKED;
  }
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const owner = identity.brain ?? 'user';
  // A reply may land in the brain-id mirror instead of the name-keyed inbox; read both.
  const owners = [identity.id, owner].filter((v, i, a) => v && a.indexOf(v) === i);
  const since = now();
  const inbox = await openSenderInbox({ owner, deps });
  try {
    const out = await (deps.sendToChannel ?? sendToChannel)({
      channel, body, identity, priority: values.priority ?? 'next', force: values.force,
      msgId, inbox, deps,
    });
    console.log(`channel   #${channel.name}  ${channel.id}  members=${channel.members.length}  sent=${out.entry.receipts.length}`);
    console.log(`envelope  ${out.text}`);
    for (const { member, receipt } of out.results) {
      console.log(`  ${member.name.padEnd(12)} ${member.id}  ${String(receipt.status).padEnd(10)} via=${receipt.via}${receipt.reason ? `  reason=${receipt.reason}` : ''}`);
    }
    if (out.logFile) console.log(`log       ${out.logFile}`);

    const socks = out.results.map((r) => r.target?.claude?.sock).filter(Boolean);
    const from = out.results.flatMap((r) => [r.member.name, r.member.id]);
    const deadline = now() + waitMs;
    const pollMs = deps.pollMs ?? 500;
    const printed = new Set();
    /** @type {{ entry: Record<string, any>, match: string }[]} */
    let mirrors = [];
    for (;;) {
      const { exact, mirrors: fresh } = collectChannelReplies(owners, out.msgId, { since, socks, from });
      for (const reply of exact) {
        if (printed.has(reply.entry.msgId)) continue;
        printed.add(reply.entry.msgId);
        printReply(reply.entry, reply.match);
      }
      if (fresh.length) mirrors = fresh;
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    if (printed.size) return EXIT.OK;
    if (mirrors.length) {
      printReply(mirrors[mirrors.length - 1].entry, 'mirror-fallback');
      return EXIT.OK;
    }
    console.log('timeout');
    return EXIT.TIMEOUT;
  } finally {
    await inbox?.close?.();
    await (deps.closeInboxes ?? closeInboxes)();
  }
}

export { listInbox, previewTransport };

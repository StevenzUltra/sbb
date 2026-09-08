// sbb ask: tell, then wait for a reply or a peer idle notice. docs/spec/cli.md.
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { findReply, listInbox } from '../registry/inbox.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  deliver,
  main,
  openDeliveryInbox,
  parse,
  parseDuration,
  previewTransport,
} from './util.js';

const USAGE = `usage: sbb ask <address> <text...> [--wait <ms|30s|5m|1h>] [--priority now|next|later] [--role <text>]

Waits (default 10m) for a reply carrying replyTo = the message id, or a Claude
peer_idle_notice. Exit 0 on reply or idle, 5 on timeout.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      wait: { type: 'string' },
      priority: { type: 'string' },
      role: { type: 'string' },
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
    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn, rows: deps.rows });
    const owner = identity.brain ?? 'user';
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
        deps,
        send: deps.send,
        msgId: deps.msgId,
        inbox,
      });
      console.log(`${receipt.status.padEnd(10)} msg=${receipt.msgId.slice(0, 8)}  via=${receipt.via}  ${(receipt.elapsedMs / 1000).toFixed(1)}s${receipt.reason ? `  reason=${receipt.reason}` : ''}`);
      console.log(`envelope  ${text}`);

      const deadline = now() + waitMs;
      const pollMs = deps.pollMs ?? 500;
      for (;;) {
        const reply = matchReply(owner, message.msgId, { since, targetSock });
        if (reply) {
          console.log(`reply     msg=${String(reply.entry.msgId).slice(0, 8)} from=${reply.entry.from ?? '-'}  via=${reply.match}`);
          console.log(String(reply.entry.text ?? ''));
          return EXIT.OK;
        }
        const idle = idleNotices.find((n) => n?.orig_msg_id === message.msgId) ?? idleNotices[0];
        if (idle) {
          console.log(`idle      state=${idle.state ?? '-'}${idle.detail ? `  ${idle.detail}` : ''}`);
          return EXIT.OK;
        }
        if (now() >= deadline) {
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
 * The peer's answer, three ways. A `sbb reply` carries `replyTo`; a peer answering with
 * Claude's own SendMessage carries no reply id at all (measured 2026-09-09: the frame for
 * "好" had replyTo null), so the first frame in the window from the target's own socket
 * counts, and so does any body carrying the envelope's own `sbb:<msgId first 8>` marker.
 * @param {string} owner
 * @param {string} msgId
 * @param {{ since?: number, targetSock?: string|null }} [ctx]
 * @returns {{ entry: Record<string, any>, match: 'replyTo'|'fromSock'|'body' }|undefined}
 */
export function matchReply(owner, msgId, { since = 0, targetSock = null } = {}) {
  const exact = findReply(owner, msgId);
  if (exact) return { entry: exact.entry, match: 'replyTo' };
  const marker = `sbb:${String(msgId).slice(0, 8)}`;
  for (const { entry } of listInbox(owner)) {
    if ((entry.t ?? 0) < since) continue;
    if (targetSock && peerSock(entry.fromSock) === targetSock) return { entry, match: 'fromSock' };
    if (String(entry.text ?? '').includes(marker)) return { entry, match: 'body' };
  }
  return undefined;
}

export { listInbox, previewTransport };

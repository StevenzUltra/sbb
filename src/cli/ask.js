// sbb ask: tell, then wait for a reply or a peer idle notice. docs/spec/cli.md.
import { resolve as defaultResolve } from '../registry/resolve.js';
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

const USAGE = `usage: sbb ask <address> <text...> [--wait <duration>] [--priority now|next|later]

Waits (default 10m) for a reply carrying replyTo = the message id, or a Claude
peer_idle_notice. Exit 0 on reply or idle, 5 on timeout.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      wait: { type: 'string' },
      priority: { type: 'string' },
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
    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn, rows: deps.rows });
    const owner = identity.brain ?? 'user';
    // The inbox stays open for the whole wait: replies and idle notices arrive while polling.
    const inbox = await openDeliveryInbox({ target, owner, deps });

    /** @type {string[]} */
    const idleNotices = [];
    inbox?.on?.('idle', (notice) => idleNotices.push(notice));

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
        const reply = findReply(owner, message.msgId);
        if (reply) {
          console.log(`reply     msg=${String(reply.entry.msgId).slice(0, 8)} from=${reply.entry.from ?? '-'}`);
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
    }
  });
}

export { listInbox, previewTransport };

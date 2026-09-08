// sbb reply: route a reply back to the original sender. docs/spec/cli.md.
import { getBrain, isValidBrainName } from '../registry/brains.js';
import { writeInboxEntry } from '../registry/inbox.js';
import { findReceipt } from '../registry/receipts.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import {
  canConnect,
  closeInboxes,
  sendToInbox as defaultSendToInbox,
  waitingInboxPath,
} from '../transports/claude-uds.js';
import { splitCoordFull } from '../lib/coord.js';
import { serverSocketPath } from '../lib/tmux.js';
import { newMsgId, shortId } from '../lib/ids.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  deliver,
  main,
  openDeliveryInbox,
  parse,
  printReceipt,
  receiptExitCode,
  targetFromSessionSock,
} from './util.js';

const USAGE = `usage: sbb reply <msgId8|msgId> <text...> [--role <text>]

Looks the id up in the receipt log, then routes the reply with replyTo set, in this
order: the waiting ask/tell inbox the receipt recorded (fromSock), the sender
session's own socket (senderSock), the brain record or the address recorded at send
time, and finally the bare coord - only when it belongs to this tmux server. If the
original sender was the user, the reply is written to ~/.sbb/inbox/user/ instead.`;

/** `a/claude:24:3.4` and a bare `24:3.4` both end in the coord. */
const COORD_TAIL_RE = /(?:^|:)([^:/]+:\d+\.\d+)$/;

/**
 * Last-resort routing: the coord recorded at send time, never the account or cli (both can
 * change under a live pane). Refused when the receipt names another tmux server - two
 * servers can host the same coord, and the wrong one must never receive the reply.
 * @param {Record<string, any>} original
 * @param {Record<string, any>} deps
 * @returns {Promise<import('../types.js').Target|null>}
 */
async function coordFallback(original, deps) {
  const full = splitCoordFull(original.fromCoordFull);
  const coord = full.coord ?? COORD_TAIL_RE.exec(String(original.fromAddress ?? ''))?.[1] ?? null;
  if (!coord) return null;
  if (full.serverPath) {
    const mine = deps.serverPath ?? (await serverSocketPath());
    if (!mine || mine !== full.serverPath) return null;
  }
  try {
    return await (deps.resolve ?? defaultResolve)(coord, {
      accounts: deps.accounts,
      onWarn: deps.onWarn,
      rows: deps.rows,
    });
  } catch {
    return null;
  }
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      role: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length < 2) throw new UsageError('reply needs <msgId> and text');
    const idArg = positionals[0];
    const text = positionals.slice(1).join(' ').trim();

    let original;
    try {
      original = (deps.findReceipt ?? findReceipt)(idArg);
    } catch (err) {
      throw new UsageError(err?.message ?? String(err));
    }
    if (!original) {
      console.error(`sbb: no receipt matching ${idArg}`);
      return EXIT.BLOCKED;
    }

    const identity = await callerIdentity(deps);
    if (values.role) identity.role = values.role;
    const sender = original.from;
    if (!sender || sender === 'user') {
      const entry = {
        msgId: newMsgId(),
        from: identity.brain ?? identity.sender,
        fromId: identity.id ?? null,
        fromAddress: identity.address ?? null,
        fromSock: null,
        replyTo: original.msgId,
        text,
      };
      const { file } = writeInboxEntry({ owner: 'user', entry });
      console.log(`inbox     user  msg=${shortId(entry.msgId)}  replyTo=${shortId(original.msgId)}  file=${file}`);
      return EXIT.OK;
    }

    const address = isValidBrainName(sender) && (deps.getBrain ?? getBrain)(sender)
      ? sender
      : original.fromAddress;
    const connectable = deps.canConnect ?? canConnect;

    // Resolution order (docs/spec/receipts.md "Reply routing"): the waiting ask/tell inbox
    // wins while the process that asked is still listening; a dead one falls through to the
    // sender session's own socket, which survives a restarted ask and a stale coord/account.
    const waitingSock = waitingInboxPath(original.fromSock);
    const liveWaiting = waitingSock && (await connectable(waitingSock)) ? waitingSock : null;
    const sessionSock = liveWaiting ? null : waitingInboxPath(original.senderSock);
    const liveSession = sessionSock && (await connectable(sessionSock)) ? sessionSock : null;
    const sessionTarget = liveSession
      ? (deps.targetFromSessionSock ?? targetFromSessionSock)(liveSession, { accounts: deps.accounts })
      : null;
    if (!liveWaiting && !sessionTarget && !address) {
      console.error(`sbb: cannot route a reply to "${sender}": no address in the receipt log`);
      return EXIT.BLOCKED;
    }

    let target;
    let inboxSock = null;
    if (liveWaiting) {
      // The sender's session address injects the reply into their conversation, where the
      // process that asked is not listening. The receipt's fromSock is that listener, so it
      // wins when it is still up.
      target = {
        address,
        cli: 'claude',
        brain: undefined,
        brainId: undefined,
        paneId: null,
        coord: null,
        claude: { sock: liveWaiting },
        codex: undefined,
      };
      inboxSock = liveWaiting;
    } else if (sessionTarget) {
      target = sessionTarget;
    } else {
      try {
        target = await (deps.resolve ?? defaultResolve)(address, {
          accounts: deps.accounts,
          onWarn: deps.onWarn,
          rows: deps.rows,
        });
      } catch (err) {
        const fallback = await coordFallback(original, deps);
        if (!fallback) throw err;
        target = fallback;
      }
    }
    const inbox = await openDeliveryInbox({ target, owner: identity.brain ?? 'user', deps });
    // The receiving SBB inbox acks a frame that carries reply_to; wait for it so a real
    // delivery reports `delivered via=uds-inbox` instead of queued (lifecycle.md).
    const sendToInbox = deps.sendToInbox
      ?? (inboxSock && inbox ? (input) => defaultSendToInbox({ ...input, inbox }) : undefined);
    try {
      const { receipt } = await deliver({
        target,
        body: text,
        replyTo: original.msgId,
        identity,
        deps,
        send: deps.send,
        sendToInbox,
        inboxSock,
        inbox,
      });
      printReceipt(receipt, { json: values.json });
      return receiptExitCode(receipt);
    } finally {
      await inbox?.close?.();
      await (deps.closeInboxes ?? closeInboxes)();
    }
  });
}

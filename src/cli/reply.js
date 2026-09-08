// sbb reply: route a reply back to the original sender. docs/spec/cli.md.
import { getBrain, isValidBrainName } from '../registry/brains.js';
import { writeInboxEntry } from '../registry/inbox.js';
import { findReceipt } from '../registry/receipts.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { canConnect, closeInboxes, waitingInboxPath } from '../transports/claude-uds.js';
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
} from './util.js';

const USAGE = `usage: sbb reply <msgId8|msgId> <text...> [--role <text>]

Looks the id up in the receipt log, then sends the reply to the original sender
with replyTo set. If the receipt carries a fromSock that is still listening, the
reply goes there (the process that asked is waiting on it); otherwise it goes to
the sender's session address. If the original sender was the user, the reply is
written to ~/.sbb/inbox/user/ instead.`;

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
    if (!address) {
      console.error(`sbb: cannot route a reply to "${sender}": no address in the receipt log`);
      return EXIT.BLOCKED;
    }
    // The sender's session address injects the reply into their conversation, where the
    // process that asked is not listening. The receipt's fromSock is that listener, so it
    // wins when it is still up; a dead socket falls back to the session address.
    const waitingSock = waitingInboxPath(original.fromSock);
    const inboxSock = waitingSock && (await (deps.canConnect ?? canConnect)(waitingSock)) ? waitingSock : null;
    const target = inboxSock
      ? {
        address,
        cli: 'claude',
        brain: undefined,
        brainId: undefined,
        paneId: null,
        coord: null,
        claude: { sock: inboxSock },
        codex: undefined,
      }
      : await (deps.resolve ?? defaultResolve)(address, {
        accounts: deps.accounts,
        onWarn: deps.onWarn,
        rows: deps.rows,
      });
    const inbox = await openDeliveryInbox({ target, owner: identity.brain ?? 'user', deps });
    try {
      const { receipt } = await deliver({
        target,
        body: text,
        replyTo: original.msgId,
        identity,
        deps,
        send: deps.send,
        sendToInbox: deps.sendToInbox,
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

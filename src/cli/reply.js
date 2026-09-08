// sbb reply: route a reply back to the original sender. docs/spec/cli.md.
import { getBrain, isValidBrainName } from '../registry/brains.js';
import { writeInboxEntry } from '../registry/inbox.js';
import { findReceipt } from '../registry/receipts.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { newMsgId, shortId } from '../lib/ids.js';
import { EXIT, UsageError, callerIdentity, deliver, main, parse, printReceipt, receiptExitCode } from './util.js';

const USAGE = `usage: sbb reply <msgId8|msgId> <text...>

Looks the id up in the receipt log, then sends the reply to the original sender
with replyTo set. If the original sender was the user, the reply is written to
~/.sbb/inbox/user/ instead.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
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
    const sender = original.from;
    if (!sender || sender === 'user') {
      const entry = {
        msgId: newMsgId(),
        from: identity.brain ?? identity.sender,
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
    const target = await (deps.resolve ?? defaultResolve)(address, {
      accounts: deps.accounts,
      onWarn: deps.onWarn,
      rows: deps.rows,
    });
    const { receipt } = await deliver({
      target,
      body: text,
      replyTo: original.msgId,
      identity,
      deps,
      send: deps.send,
    });
    printReceipt(receipt, { json: values.json });
    return receiptExitCode(receipt);
  });
}

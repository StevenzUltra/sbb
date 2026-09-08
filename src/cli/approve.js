// sbb approve: send a held (moderated) message through the normal path, or deny it.
// docs/spec/policy.md "Moderated holds".
import { shortId } from '../lib/ids.js';
import { appendReceipt } from '../registry/receipts.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { send as defaultSend } from '../transports/index.js';
import { findHeld, removeHold } from '../policy/held.js';
import {
  EXIT,
  UsageError,
  deliver,
  main,
  openDeliveryInbox,
  parse,
  printReceipt,
  receiptExitCode,
  writeJson,
} from './util.js';

const USAGE = 'usage: sbb approve [--deny] [--reason <text>] <msgId8> [--json]';

const USER_IDENTITY = { sender: 'user', account: null, cli: null, coord: null, role: '用户', brain: null };

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      deny: { type: 'boolean' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const ref = positionals[0];
    if (!ref) throw new UsageError('approve needs a <msgId8>');
    const found = (deps.findHeld ?? findHeld)(ref, { sbbDir: deps.sbbDir });
    if (!found) throw new UsageError(`no held message matching "${ref}"`);
    const { entry } = found;
    const remove = deps.removeHold ?? removeHold;

    if (values.deny) {
      remove(found.file);
      const notice = `held message ${shortId(entry.msgId)} was denied by the user${values.reason ? `: ${values.reason}` : ''}`;
      const notified = await notifySender(entry, notice, deps);
      if (values.json) writeJson({ msgId: entry.msgId, decision: 'denied', notified });
      else console.log(`denied      msg=${shortId(entry.msgId)}${notified ? '  sender notified' : '  sender not reachable'}`);
      return EXIT.OK;
    }

    // Resolve the recorded brainId, never the name: a retired brain's name can already
    // belong to a replacement (rehearsal 2026-09-09: an old hold landed on the new lead).
    const brainId = entry.target?.brainId ?? null;
    const address = brainId ?? entry.target?.address ?? entry.target?.brain;
    if (!address) throw new UsageError(`held message ${shortId(entry.msgId)} has no target address`);
    const blocked = (detail) => {
      if (values.json) writeJson({ msgId: entry.msgId, approved: false, blocked: 'target_not_found', detail });
      else console.log(`blocked  msg=${shortId(entry.msgId)}  via=approve  reason=target_not_found  detail=${detail}`);
      return EXIT.BLOCKED;
    };
    let target;
    try {
      target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn });
    } catch (err) {
      if (!brainId) throw err;
      return blocked(err?.detail ? `${err.message} (${err.detail})` : (err?.message ?? String(err)));
    }
    if (brainId && target.brainId !== brainId) {
      // resolve() is exact for an id; a resolver that hands back another brain is refused.
      return blocked(`hold targets brain ${brainId}, resolved ${target.brainId ?? target.address}`);
    }
    const inbox = await openDeliveryInbox({ target, owner: entry.sender?.name ?? 'user', deps });
    try {
      const message = { ...entry.message, msgId: entry.msgId };
      const receipt = await (deps.send ?? defaultSend)(target, message, {
        inbox,
        verifyTimeoutMs: deps.verifyTimeoutMs,
      });
      if (!deps.dryRun) {
        appendReceipt({
          msgId: entry.msgId,
          from: entry.sender?.name ?? 'user',
          fromId: entry.sender?.id ?? null,
          fromAddress: entry.sender?.address ?? null,
          fromSock: message.fromSock ?? null,
          to: target.brain ?? target.address,
          toId: target.brainId ?? null,
          address: target.address,
          status: receipt.status,
          via: receipt.via,
          elapsedMs: receipt.elapsedMs,
          reason: receipt.reason ?? null,
          approvedBy: 'user',
          held: 'released',
          textPreview: String(message.text ?? '').slice(0, 200),
        });
      }
      remove(found.file);
      const notice = `held message ${shortId(entry.msgId)} was approved and sent (status=${receipt.status} via=${receipt.via})`;
      const notified = await notifySender(entry, notice, deps);
      if (values.json) writeJson({ ...receipt, approved: true, notified });
      else {
        printReceipt(receipt, {});
        console.log(`approved    msg=${shortId(entry.msgId)}${notified ? '  sender notified' : '  sender not reachable'}`);
      }
      return receiptExitCode(receipt);
    } finally {
      await inbox?.close?.();
      await (deps.closeInboxes ?? closeInboxes)();
    }
  });
}

/**
 * Best-effort one-line notice to the held message's sender. Never fails the command.
 * @param {Record<string, any>} entry @param {string} body @param {Record<string, any>} deps
 */
async function notifySender(entry, body, deps) {
  const address = entry.sender?.name ?? entry.sender?.address;
  if (!address) return false;
  try {
    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn });
    await deliver({ target, body, identity: USER_IDENTITY, skipPolicy: true, deps, send: deps.send });
    return true;
  } catch (err) {
    console.error(`sbb: warning: could not notify ${address}: ${err?.message ?? err}`);
    return false;
  }
}

// sbb approve: send a held (moderated) message through the normal path, or deny it.
// docs/spec/policy.md "Moderated holds".
import { shortId } from '../lib/ids.js';
import { paneOption } from '../lib/tmux.js';
import { listBrains } from '../registry/brains.js';
import { appendReceipt } from '../registry/receipts.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { send as defaultSend } from '../transports/index.js';
import { findHeld, removeHold } from '../policy/held.js';
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
  senderSessionFromEnv,
  writeJson,
} from './util.js';

const USAGE = 'usage: sbb approve [--deny] [--reason <text>] <msgId8> [--json]';

const USER_IDENTITY = { sender: 'user', account: null, cli: null, coord: null, role: '用户', brain: null };

/** The one decision a registered brain may never make for itself. docs/spec/policy.md. */
const POLICY_DETAIL = 'holds are approved by the user only';

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

    // A hold exists because a peer's message was parked for the user; a brain releasing its
    // own hold defeats the gate (rehearsal 2026-09-09: the lead approved its own held message
    // 12 s after it was held). Identity is resolved exactly as `tell` resolves a sender.
    const session = senderSessionFromEnv(deps.env ?? process.env);
    const { identity, brain: actorBrain } = await approverIdentity(deps, session);
    if (actorBrain) {
      const actor = actorBrain.name ?? actorBrain.id;
      if (!deps.dryRun) {
        appendReceipt({
          msgId: entry.msgId,
          from: actor,
          fromId: actorBrain.id,
          fromAddress: null,
          fromSock: null,
          senderSock: session.senderSock,
          senderPid: session.senderPid,
          to: entry.target?.brain ?? entry.target?.address ?? null,
          toId: entry.target?.brainId ?? null,
          address: entry.target?.address ?? null,
          status: 'blocked',
          via: 'policy',
          elapsedMs: 0,
          reason: 'policy',
          detail: POLICY_DETAIL,
          approvedBy: actor,
          held: 'refused',
          textPreview: String(entry.message?.text ?? '').slice(0, 200),
        });
      }
      if (values.json) writeJson({ msgId: entry.msgId, approved: false, blocked: 'policy', detail: POLICY_DETAIL });
      else console.log(`blocked  msg=${shortId(entry.msgId)}  via=approve  reason=policy  detail=${POLICY_DETAIL}`);
      return EXIT.BLOCKED;
    }
    const actor = identity.brain ?? identity.sender;

    if (values.deny) {
      remove(found.file);
      const by = actor === 'user' ? 'the user' : actor;
      const notice = `held message ${shortId(entry.msgId)} was denied by ${by}${values.reason ? `: ${values.reason}` : ''}`;
      const notified = await notifySender(entry, notice, deps, identity);
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
          approvedBy: actor,
          held: 'released',
          textPreview: String(message.text ?? '').slice(0, 200),
        });
      }
      remove(found.file);
      const notice = `held message ${shortId(entry.msgId)} was approved and sent by ${actor} (status=${receipt.status} via=${receipt.via})`;
      const notified = await notifySender(entry, notice, deps, identity);
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
 * Who is asking to release or deny a hold: the same resolution `tell` uses for a sender
 * (src/cli/util.js `callerIdentity`), then the pane's own `@sbb_brain` tag, then the sender
 * session socket's pid. Returns the identity plus the registered brain it belongs to, if any.
 * @param {Record<string, any>} deps
 * @param {{ senderSock: string|null, senderPid: number|null }} session
 * @returns {Promise<{ identity: Record<string, any>, brain: { id: string, name: string|null }|null }>}
 */
async function approverIdentity(deps, session) {
  const identity = await callerIdentity(deps);
  if (identity.brain) return { identity, brain: { id: identity.id, name: identity.brain } };
  const paneId = identity.paneId;
  if (paneId && /^%\d+$/.test(paneId)) {
    // The tag outlives the record, so a retired brain in its old pane is still refused.
    const tag = await (deps.paneOption ?? paneOption)(paneId, 'sbb_brain');
    if (tag) {
      const record = listBrains().find((b) => b.id === tag);
      return { identity, brain: record ? { id: record.id, name: record.name } : { id: tag, name: null } };
    }
  }
  if (session.senderPid) {
    const record = listBrains().find((b) => b.pid === session.senderPid);
    if (record) return { identity, brain: { id: record.id, name: record.name } };
  }
  return { identity, brain: null };
}

/**
 * Best-effort one-line notice to the held message's sender. Never fails the command.
 * @param {Record<string, any>} entry @param {string} body @param {Record<string, any>} deps
 * @param {Record<string, any>} [identity] the actual approver, never a fixed `user`
 */
async function notifySender(entry, body, deps, identity) {
  const address = entry.sender?.name ?? entry.sender?.address;
  if (!address) return false;
  try {
    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn });
    await deliver({ target, body, identity: identity ?? USER_IDENTITY, skipPolicy: true, deps, send: deps.send });
    return true;
  } catch (err) {
    console.error(`sbb: warning: could not notify ${address}: ${err?.message ?? err}`);
    return false;
  }
}

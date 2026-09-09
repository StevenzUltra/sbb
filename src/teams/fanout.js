// Channel fan-out: one delivery per member through the normal path (policy and quota
// included), then one team-log line carrying every member's receipt.
// docs/spec/teams.md "Channels". The caller may pass the sender inbox it already opened
// (`input.inbox`): sharing one live socket keeps every member receipt answerable.
import { newMsgId } from '../lib/ids.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { ROLE_LABELS, buildEnvelope } from '../registry/envelope.js';
import { closeInboxes as defaultCloseInboxes } from '../transports/claude-uds.js';
import { deliver as defaultDeliver, openSenderInbox as defaultOpenInbox } from '../cli/util.js';
import { teamOf } from '../policy/rules.js';
import { appendTeamLog } from './log.js';

/** @typedef {import('./channels.js').Channel} Channel */

/**
 * The role block of a channel envelope: `主脑 → #lead` (docs/spec/teams.md).
 * @param {{ role?: string|null }} identity
 * @param {Channel} channel
 */
export function channelRole(identity, channel) {
  const role = identity?.role ?? '';
  // `identity.role` is already a label when it came from a pane row (identityFromRows), and
  // free text when it came from `--role`; both fall through unchanged.
  return `${ROLE_LABELS[role] ?? (role || ROLE_LABELS.user)} → #${channel.name}`;
}

/**
 * Deliver one channel message to every member except the sender.
 * @param {{ channel: Channel, body: string, identity: Record<string, any>,
 *           priority?: import('../types.js').Priority, force?: boolean, msgId?: string,
 *           verifyTimeoutMs?: number, inbox?: Record<string, any>,
 *           deps?: Record<string, any> }} input
 * @returns {Promise<{ msgId: string, text: string, entry: Record<string, any>,
 *           results: { member: any, target?: any, receipt: any }[], logFile: string|null }>}
 */
export async function sendToChannel(input) {
  const { channel, body, identity } = input;
  const deps = input.deps ?? {};
  const resolve = deps.resolve ?? defaultResolve;
  const deliver = deps.deliver ?? defaultDeliver;
  const openInbox = deps.openInbox ?? defaultOpenInbox;
  const closeInboxes = deps.closeInboxes ?? defaultCloseInboxes;
  const msgId = input.msgId ?? newMsgId();
  const role = channelRole(identity, channel);
  const senderId = identity.id ?? null;
  const members = channel.members.filter((member) => member.id !== senderId);
  const owner = identity.brain ?? 'user';

  const inbox = input.inbox ?? (await openInbox({ owner, deps }));
  const closesInbox = input.inbox === undefined;

  /** @type {{ member: any, target?: any, receipt: any }[]} */
  const results = [];
  let text;
  try {
    for (const member of members) {
      // Every member keeps its own main id in the mirror, so `#all` still groups by team.
      const team = channel.main?.id ?? teamOf(member, deps.getBrain) ?? null;
      let target;
      try {
        target = await resolve(member.id, { accounts: deps.accounts, rows: deps.rows, onWarn: deps.onWarn });
      } catch (err) {
        results.push({
          member,
          receipt: {
            status: 'blocked', via: 'resolve', msgId, elapsedMs: 0,
            reason: err?.reason ?? 'target_not_found', detail: err?.message ?? String(err),
          },
        });
        continue;
      }
      try {
        const out = await deliver({
          target, body, priority: input.priority ?? 'next', identity: { ...identity, role },
          force: input.force, deps, msgId, inbox, team,
          verifyTimeoutMs: input.verifyTimeoutMs,
        });
        text = out.text;
        results.push({ member, target, receipt: out.receipt });
      } catch (err) {
        results.push({
          member,
          target,
          receipt: err?.receipt ?? {
            status: 'blocked', via: 'policy', msgId, elapsedMs: 0,
            reason: err?.reason ?? 'policy', detail: err?.message ?? String(err),
          },
        });
      }
    }
  } finally {
    if (closesInbox) {
      await inbox?.close?.();
      await closeInboxes();
    }
  }

  const receipts = results.map(({ member, receipt }) => ({
    to: member.name, toId: member.id, status: receipt.status, via: receipt.via,
  }));
  const entry = {
    t: Date.now(),
    msgId,
    from: identity.brain ?? identity.sender ?? 'user',
    fromId: senderId,
    text: body,
    channel: `#${channel.name}`,
    receipts,
  };
  // A team has a log; `#all` is not a team, so it has none.
  const logFile = channel.main ? appendTeamLog(channel.main.id, entry, deps).file : null;
  return {
    msgId,
    text: text ?? buildEnvelope({ ...identity, role, body, msgId }),
    entry,
    results,
    logFile,
  };
}

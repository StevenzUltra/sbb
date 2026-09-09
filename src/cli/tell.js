// sbb tell: build the envelope, resolve the target, route it, log the receipt.
import { readFileSync } from 'node:fs';
import { bodyFromFile, senderPrefix } from '../registry/envelope.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import { newMsgId, shortId } from '../lib/ids.js';
import { appendReceipt } from '../registry/receipts.js';
import { channelRole, checkChannel, isChannelAddress, resolveChannel, sendToChannel } from '../teams/index.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  channelBlockEntry,
  channelExitCode,
  deliver,
  main,
  openDeliveryInbox,
  openSenderInbox,
  parse,
  parseDuration,
  policyBlockLine,
  previewTransport,
  printReceipt,
  writeJson,
} from './util.js';

const USAGE = `usage: sbb tell <address|#channel> <text...> [--priority now|next|later] [--role <text>] [--file <path>] [--timeout <ms|30s|5m|1h>] [--force] [--dry-run]

#<main name> posts to that team's channel (every member except you), #all to every main
brain (the user only). Each member gets its own receipt and the team log one line.
--force bypasses the weekly quota floor for this send; it never bypasses moderation.`;

const PRIORITIES = ['now', 'next', 'later'];

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      priority: { type: 'string' },
      role: { type: 'string' },
      file: { type: 'string' },
      timeout: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length === 0) throw new UsageError('tell needs an <address>');
    const address = positionals[0];
    const priority = values.priority ?? 'next';
    if (!PRIORITIES.includes(priority)) throw new UsageError(`invalid --priority "${priority}"`);
    const verifyTimeoutMs = values.timeout ? parseDuration(values.timeout) : undefined;

    let body;
    if (values.file) {
      let content;
      try {
        content = readFileSync(values.file, 'utf8');
      } catch (err) {
        throw new UsageError(`cannot read --file ${values.file}: ${err?.message ?? err}`);
      }
      body = bodyFromFile(values.file, content);
    } else {
      body = positionals.slice(1).join(' ').trim();
    }
    if (!body) {
      // --dry-run only resolves the target and picks a transport; it needs no body.
      if (!values['dry-run']) throw new UsageError('tell needs message text or --file <path>');
      body = '(dry-run)';
    }

    const identity = { ...(await callerIdentity(deps)) };
    if (values.role) identity.role = values.role;

    if ((deps.isChannelAddress ?? isChannelAddress)(address)) {
      return tellChannel({ address, body, identity, priority, verifyTimeoutMs, values, deps });
    }

    const target = await (deps.resolve ?? defaultResolve)(address, { accounts: deps.accounts, onWarn: deps.onWarn, rows: deps.rows });

    if (values['dry-run']) {
      const transport = previewTransport(target, deps.transports);
      const preview = {
        target,
        transport,
        priority,
        verifyTimeoutMs: verifyTimeoutMs ?? 4000,
        identity,
      };
      if (values.json) {
        writeJson(preview);
      } else {
        console.log(`target    ${target.address}`);
        console.log(`brain     ${target.brain ?? '-'}`);
        console.log(`account   ${target.account}`);
        console.log(`cli       ${target.cli}`);
        console.log(`pane      ${target.paneId}`);
        console.log(`coord     ${target.coord}`);
        console.log(`transport ${transport.id}${transport.available ? '' : ' (unsupported, would be blocked)'}`);
        console.log(`sender    ${senderPrefix(identity)}[${identity.role}]`);
      }
      return EXIT.OK;
    }

    const inbox = await openDeliveryInbox({ target, owner: identity.brain ?? 'user', deps });
    try {
      const { receipt, text } = await deliver({
        target,
        body,
        priority,
        verifyTimeoutMs,
        identity,
        force: values.force,
        deps,
        send: deps.send,
        msgId: deps.msgId,
        inbox,
      });
      if (values.json) writeJson(receipt);
      else {
        console.log(`envelope  ${text}`);
        console.log(formatReceipt(receipt));
      }
      return receipt.status === 'delivered' || receipt.status === 'queued'
        ? EXIT.OK
        : receipt.status === 'unverified'
          ? EXIT.UNVERIFIED
          : EXIT.BLOCKED;
    } finally {
      await inbox?.close?.();
      // The transport may have opened its own inbox; leaving one listening keeps the
      // process alive after the receipt is printed.
      await (deps.closeInboxes ?? closeInboxes)();
    }
  });
}

/**
 * `sbb tell #<main>` / `#all`: policy-check the sender against the channel, deliver to every
 * member except the sender, print one receipt per member and append one team-log line.
 * @returns {Promise<number>} exit code
 */
async function tellChannel({ address, body, identity, priority, verifyTimeoutMs, values, deps }) {
  const channel = (deps.resolveChannel ?? resolveChannel)(address, {
    getBrain: deps.getBrain,
    listBrains: deps.listBrains,
  });
  const gate = checkChannel(channel, identity);
  const msgId = deps.msgId ?? newMsgId();
  if (!gate.ok) {
    const entry = channelBlockEntry({ identity, channel, address, body, msgId, detail: gate.detail, deps });
    if (!values['dry-run']) (deps.appendReceipt ?? appendReceipt)(entry);
    if (values.json) writeJson({ ...entry, receipts: [] });
    else console.log(policyBlockLine({ msgId, reason: 'policy', detail: gate.detail }));
    return EXIT.BLOCKED;
  }
  if (values['dry-run']) {
    console.log(`channel   #${channel.name}  ${channel.id}  members=${channel.members.length}`);
    for (const member of channel.members) {
      console.log(`  ${member.name.padEnd(12)} ${member.id}  ${member.role}  ${member.account}/${member.cli}`);
    }
    console.log(`sender    ${senderPrefix(identity)}[${channelRole(identity, channel)}]`);
    return EXIT.OK;
  }

  const inbox = await openSenderInbox({ owner: identity.brain ?? 'user', deps });
  try {
    const out = await (deps.sendToChannel ?? sendToChannel)({
      channel, body, identity, priority, force: values.force, msgId, verifyTimeoutMs, inbox, deps,
    });
    if (values.json) {
      writeJson({ msgId: out.msgId, channel: channel.id, name: `#${channel.name}`, receipts: out.entry.receipts, log: out.logFile });
    } else {
      console.log(`channel   #${channel.name}  ${channel.id}  members=${channel.members.length}  sent=${out.entry.receipts.length}`);
      console.log(`envelope  ${out.text}`);
      for (const { member, receipt } of out.results) {
        const reason = receipt.reason ? `  reason=${receipt.reason}${receipt.detail ? `  detail=${receipt.detail}` : ''}` : '';
        console.log(`  ${member.name.padEnd(12)} ${member.id}  ${String(receipt.status).padEnd(10)} via=${receipt.via}  ${((receipt.elapsedMs ?? 0) / 1000).toFixed(1)}s${reason}`);
      }
      if (out.logFile) console.log(`log       ${out.logFile}`);
    }
    return channelExitCode(out.results);
  } finally {
    await inbox?.close?.();
    await (deps.closeInboxes ?? closeInboxes)();
  }
}

/** @param {import('../types.js').Receipt} receipt */
function formatReceipt(receipt) {
  const reason = receipt.reason ? `  reason=${receipt.reason}` : '';
  return `${receipt.status.padEnd(10)} msg=${shortId(receipt.msgId)}  via=${receipt.via}  ${(receipt.elapsedMs / 1000).toFixed(1)}s${reason}`;
}

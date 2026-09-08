// sbb collect: print unread inbox entries for this brain. docs/spec/cli.md.
import { getBrain } from '../registry/brains.js';
import { listInbox, markInboxRead } from '../registry/inbox.js';
import { shortId } from '../lib/ids.js';
import { EXIT, callerIdentity, main, parse, writeJson } from './util.js';

const USAGE = `usage: sbb collect [--for <brain>] [--all] [--json]

Prints unread inbox entries for the caller (or --for) and marks them read.
--all prints every entry and leaves the read marks alone.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      for: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const identity = await callerIdentity(deps);
    const owner = values.for ?? identity.brain ?? 'user';
    // A brain's entries live under its name and under its id (the delivery mirror); merge
    // them, one line per msgId, oldest first.
    const read = deps.listInbox ?? listInbox;
    /** @type {Map<string, { file: string, entry: Record<string, any> }>} */
    const first = new Map();
    /** @type {Map<string, { file: string, entry: Record<string, any> }[]>} */
    const copies = new Map();
    for (const ownerDir of inboxOwners(owner, deps)) {
      for (const item of read(ownerDir, { unreadOnly: !values.all })) {
        const msgId = item.entry.msgId;
        if (first.has(msgId)) {
          copies.get(msgId).push(item);
          continue;
        }
        first.set(msgId, item);
        copies.set(msgId, [item]);
      }
    }
    const entries = [...first.values()].sort((a, b) => (a.entry.t ?? 0) - (b.entry.t ?? 0));

    if (values.json) {
      writeJson(entries.map(({ entry }) => entry));
    } else if (entries.length === 0) {
      console.log(`no ${values.all ? '' : 'unread '}messages for ${owner}`);
    } else {
      for (const { entry } of entries) {
        const replyTo = entry.replyTo ? shortId(entry.replyTo) : '-';
        const when = entry.t ? new Date(entry.t).toISOString() : '-';
        console.log(`msg=${shortId(entry.msgId)}  from=${entry.from ?? '-'}  replyTo=${replyTo}  ${when}  ${String(entry.text ?? '').slice(0, 160)}`);
      }
    }
    if (!values.all) {
      for (const { entry } of entries) {
        // The same message may exist under the name and under the id: mark both read.
        for (const copy of copies.get(entry.msgId) ?? []) {
          (deps.markInboxRead ?? markInboxRead)(copy.file, copy.entry);
        }
      }
    }
    return EXIT.OK;
  });
}

/**
 * The inbox directories that belong to one owner: its name, plus its brain id when the
 * name resolves to a record (every delivery is mirrored under the id).
 * @param {string} owner @param {Record<string, any>} deps
 */
function inboxOwners(owner, deps) {
  const brain = (deps.getBrain ?? getBrain)(owner);
  const dirs = [owner];
  if (brain?.id && brain.id !== owner) dirs.push(brain.id);
  return dirs;
}

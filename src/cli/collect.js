// sbb collect: print unread inbox entries for this brain. docs/spec/cli.md.
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
    const entries = (deps.listInbox ?? listInbox)(owner, { unreadOnly: !values.all });

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
      for (const { file, entry } of entries) (deps.markInboxRead ?? markInboxRead)(file, entry);
    }
    return EXIT.OK;
  });
}

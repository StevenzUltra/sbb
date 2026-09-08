// sbb tell: build the envelope, resolve the target, route it, log the receipt.
import { readFileSync } from 'node:fs';
import { bodyFromFile } from '../registry/envelope.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { shortId } from '../lib/ids.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  deliver,
  main,
  parse,
  parseDuration,
  previewTransport,
  printReceipt,
  writeJson,
} from './util.js';

const USAGE = `usage: sbb tell <address> <text...> [--priority now|next|later] [--role <text>] [--file <path>] [--timeout <ms>] [--dry-run]`;

const PRIORITIES = ['now', 'next', 'later'];

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      priority: { type: 'string' },
      role: { type: 'string' },
      file: { type: 'string' },
      timeout: { type: 'string' },
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
        console.log(`sender    ${identity.sender}@${identity.account ?? 'cli'}/${identity.cli ?? '-'}:${identity.coord ?? '-'} [${identity.role}]`);
      }
      return EXIT.OK;
    }

    const { receipt, text } = await deliver({
      target,
      body,
      priority,
      verifyTimeoutMs,
      identity,
      deps,
      send: deps.send,
      msgId: deps.msgId,
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
  });
}

/** @param {import('../types.js').Receipt} receipt */
function formatReceipt(receipt) {
  const reason = receipt.reason ? `  reason=${receipt.reason}` : '';
  return `${receipt.status.padEnd(10)} msg=${shortId(receipt.msgId)}  via=${receipt.via}  ${(receipt.elapsedMs / 1000).toFixed(1)}s${reason}`;
}

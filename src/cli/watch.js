// sbb watch: tail the receipt log and the inbox. docs/spec/cli.md.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inboxRoot } from '../registry/inbox.js';
import { receiptLogPath } from '../registry/receipts.js';
import { shortId } from '../lib/ids.js';
import { EXIT, main, parse, writeJson } from './util.js';

const USAGE = `usage: sbb watch [--json]

Prints one line per new receipt and per new inbox entry. Runs until interrupted.`;

/** @returns {{ receiptOffset: number, seenInbox: Set<string> }} */
export function createWatchState() {
  return { receiptOffset: 0, seenInbox: new Set() };
}

/**
 * New receipt lines since the last call. Malformed lines are skipped.
 * @param {{ receiptOffset: number }} state
 * @param {{ logPath?: string, read?: (path: string) => string }} [deps]
 */
export function readNewReceipts(state, deps = {}) {
  const read = deps.read ?? ((path) => readFileSync(path, 'utf8'));
  let raw;
  try {
    raw = read(deps.logPath ?? receiptLogPath());
  } catch {
    return [];
  }
  const fresh = raw.slice(state.receiptOffset);
  state.receiptOffset = raw.length;
  /** @type {{ kind: string, entry: Record<string, any> }[]} */
  const out = [];
  for (const line of fresh.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push({ kind: 'receipt', entry: JSON.parse(line) });
    } catch {
      // a line still being written is not an event
    }
  }
  return out;
}

/**
 * New inbox files since the last call, across every owner.
 * @param {{ seenInbox: Set<string> }} state
 * @param {{ root?: string, readdir?: Function, read?: Function }} [deps]
 */
export function readNewInboxEntries(state, deps = {}) {
  const root = deps.root ?? inboxRoot();
  const readdir = deps.readdir ?? readdirSync;
  const read = deps.read ?? ((path) => readFileSync(path, 'utf8'));
  let owners;
  try {
    owners = readdir(root);
  } catch {
    return [];
  }
  /** @type {{ kind: string, owner: string, entry: Record<string, any> }[]} */
  const out = [];
  for (const owner of owners.sort()) {
    let files;
    try {
      files = readdir(join(root, owner));
    } catch {
      continue;
    }
    for (const name of files.filter((f) => f.endsWith('.json')).sort()) {
      const file = join(root, owner, name);
      if (state.seenInbox.has(file)) continue;
      state.seenInbox.add(file);
      try {
        out.push({ kind: 'inbox', owner, entry: JSON.parse(read(file)) });
      } catch {
        // half-written entry
      }
    }
  }
  return out;
}

/** @param {{ kind: string, owner?: string, entry: Record<string, any> }} event */
export function formatEvent(event) {
  if (event.kind === 'receipt') {
    const e = event.entry;
    return `receipt  ${String(e.status ?? '?').padEnd(10)} msg=${shortId(e.msgId ?? '')}  from=${e.from ?? '-'}  to=${e.to ?? '-'}  via=${e.via ?? '-'}${e.reason ? `  reason=${e.reason}` : ''}`;
  }
  const e = event.entry;
  return `inbox    ${event.owner}  msg=${shortId(e.msgId ?? '')}  from=${e.from ?? '-'}  replyTo=${e.replyTo ? shortId(e.replyTo) : '-'}`;
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const state = createWatchState();
    // Prime: start from the current end of the log so only new events print.
    readNewReceipts(state, deps);
    readNewInboxEntries(state, deps);

    const pollMs = deps.pollMs ?? 400;
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    while (!stopping) {
      const events = [...readNewReceipts(state, deps), ...readNewInboxEntries(state, deps)];
      for (const event of events) {
        if (values.json) writeJson(event);
        else console.log(formatEvent(event));
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return EXIT.OK;
  });
}

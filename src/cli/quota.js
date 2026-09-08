// sbb quota: remaining quota per account and provider, read-only. docs/spec/cli.md.
import { readQuota as defaultReadQuota } from '../quota/usage-guard.js';
import { EXIT, main, parse, renderTable, writeJson } from './util.js';

const USAGE = `usage: sbb quota [--json] [--refresh]

--refresh runs Usage Guard read-only (--read-once --no-ui --no-redeem) first.
Missing data prints unknown; SBB never redeems and never writes to the database.`;

const HEADERS = ['ACCOUNT', 'PROVIDER', 'WINDOW', 'REMAINING', 'RESET', 'CAPTURED', 'NOTE'];

/** @param {number|null} ms */
function iso(ms) {
  return ms == null ? '-' : new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** @param {import('../quota/usage-guard.js').QuotaRow} row */
function toCells(row) {
  return [
    row.account,
    row.provider,
    row.window,
    row.remaining == null ? 'unknown' : `${row.remaining}%`,
    iso(row.resetsAt),
    iso(row.capturedAt),
    row.note,
  ];
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      json: { type: 'boolean' },
      refresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    /** @type {Record<string, any>|undefined} */
    let refreshInfo;
    const rows = await (deps.readQuota ?? defaultReadQuota)({
      refresh: Boolean(values.refresh),
      onRefresh: (info) => {
        refreshInfo = info;
      },
      dbPath: deps.dbPath,
      run: deps.run,
      env: deps.env,
    });
    if (values.refresh && refreshInfo && refreshInfo.ran === false) {
      console.error(`sbb: refresh skipped (${refreshInfo.reason})`);
    } else if (values.refresh && refreshInfo && !refreshInfo.ok) {
      console.error(`sbb: refresh exited code=${refreshInfo.code} timedOut=${refreshInfo.timedOut}`);
    }
    if (values.json) {
      writeJson(rows);
      return EXIT.OK;
    }
    console.log(renderTable(HEADERS, rows.map(toCells)));
    return EXIT.OK;
  });
}

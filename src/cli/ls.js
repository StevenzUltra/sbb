// sbb ls: roster union. docs/spec/cli.md.
import { homedir } from 'node:os';
import { getBrain } from '../registry/brains.js';
import { roster as defaultRoster } from '../registry/roster.js';
import { conflictedBrainIds } from '../policy/claims.js';
import { EXIT, main, parse, renderTable, writeJson } from './util.js';

const USAGE = `usage: sbb ls [<id|name>] [--json] [--tree] [--account <name>] [--cli <kind>] [--claims]

Rows are live CLI sessions across every account. An id (#SMS-0012) or a brain name
prints that one row. --tree prints brains only, indented by parent. --claims marks rows
whose brain holds a claim conflicting with another brain with a leading !.`;

const HEADERS = ['ID', 'BRAIN', 'ROLE', 'PARENT', 'ACCOUNT', 'CLI', 'MODEL', 'STATUS', 'WHERE', 'NAME/THREAD', 'CWD'];

/** @param {string} cwd */
function shortCwd(cwd) {
  const home = homedir();
  return cwd?.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd ?? '-';
}

/** @param {import('../registry/roster.js').RosterRow} row */
function nameCell(row) {
  if (!row.name) return '-';
  return row.threadUncertain ? `${row.name} (thread: uncertain)` : row.name;
}

/** @param {import('../registry/roster.js').RosterRow} row */
function toCells(row) {
  return [
    row.brainId,
    row.brain,
    row.role,
    row.parent,
    row.account,
    row.cli,
    row.model,
    row.status,
    row.where,
    nameCell(row),
    shortCwd(row.cwd),
  ];
}

/** @param {import('../registry/roster.js').RosterRow[]} rows */
function printTree(rows) {
  const brainRows = rows.filter((r) => r.brain);
  const byId = new Map(brainRows.map((r) => [r.brainId, r]));
  /** @type {Map<string|null, import('../registry/roster.js').RosterRow[]>} */
  const children = new Map();
  for (const row of brainRows) {
    const key = row.parent && byId.has(row.parent) ? row.parent : null;
    children.set(key, [...(children.get(key) ?? []), row]);
  }
  /** @param {string|null} parent @param {number} depth */
  const walk = (parent, depth) => {
    for (const row of children.get(parent) ?? []) {
      const detail = `${row.account}/${row.cli}  ${row.status}  ${row.where}`;
      console.log(`${'  '.repeat(depth)}${row.brainId}  ${row.brain}  ${row.role}  ${detail}${row.name ? `  ${row.name}` : ''}`);
      walk(row.brainId, depth + 1);
    }
  };
  walk(null, 0);
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      json: { type: 'boolean' },
      tree: { type: 'boolean' },
      account: { type: 'string' },
      cli: { type: 'string' },
      claims: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const rows = await (deps.roster ?? defaultRoster)({
      includeStaleBrains: Boolean(values.tree) || positionals.length > 0,
      onWarn: deps.onWarn,
      accounts: deps.accounts,
      listPanes: deps.listPanes,
      capturePane: deps.capturePane,
      exec: deps.exec,
      cliProfiles: deps.cliProfiles,
      withStatus: deps.withStatus,
    });
    let filtered = rows;
    if (values.account) filtered = filtered.filter((r) => r.account === values.account.toLowerCase());
    if (values.cli) filtered = filtered.filter((r) => r.cli === values.cli.toLowerCase());
    if (positionals.length > 0) {
      const ref = positionals[0];
      const brain = (deps.getBrain ?? getBrain)(ref);
      if (!brain) {
        console.error(`sbb: no brain matching "${ref}"`);
        return EXIT.BLOCKED;
      }
      filtered = filtered.filter((r) => r.brainId === brain.id);
      if (filtered.length === 0) {
        console.error(`sbb: brain ${brain.id} ${brain.name} has no live pane`);
        return EXIT.BLOCKED;
      }
    }

    if (values.tree) {
      printTree(filtered);
      return EXIT.OK;
    }
    if (values.json) {
      writeJson(filtered);
      return EXIT.OK;
    }
    if (filtered.length === 0) {
      console.log('no live sessions');
      return EXIT.OK;
    }
    if (values.claims) {
      const conflicted = (deps.conflictedBrainIds ?? conflictedBrainIds)({ sbbDir: deps.sbbDir });
      filtered = filtered.map((r) => (conflicted.has(r.brainId) ? { ...r, brainId: `!${r.brainId}` } : r));
    }
    console.log(renderTable(HEADERS, filtered.map(toCells)));
    return EXIT.OK;
  });
}

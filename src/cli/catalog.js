// sbb catalog: accounts x CLIs x models on this machine. docs/spec/cli.md.
import { catalog as defaultCatalog } from '../quota/catalog.js';
import { EXIT, main, parse, renderTable, writeJson } from './util.js';

const USAGE = `usage: sbb catalog [--json]

CLIs are detected by binaries on PATH plus per-account Codex config.toml.
Model lists for claude, agy and cursor come from hand-maintained static tables;
no network is used.`;

const HEADERS = ['ACCOUNT', 'CLI', 'MODELS', 'SOURCE'];

/** @param {import('../quota/catalog.js').CatalogRow} row */
function toCells(row) {
  const models = row.models.length ? row.models.map((m) => m.id).join(', ') : 'unknown';
  return [row.account, row.cli, models, row.source];
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
    const rows = await (deps.catalog ?? defaultCatalog)({
      accounts: deps.accounts,
      env: deps.env,
      which: deps.which,
      home: deps.home,
    });
    if (values.json) {
      writeJson(rows);
      return EXIT.OK;
    }
    if (rows.length === 0) {
      console.log('no CLI binaries found on PATH');
      return EXIT.OK;
    }
    console.log(renderTable(HEADERS, rows.map(toCells)));
    return EXIT.OK;
  });
}

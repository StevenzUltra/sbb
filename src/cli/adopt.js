// sbb adopt: register a live session as a brain. docs/spec/cli.md.
import { getBrain, isValidBrainName, saveBrain } from '../registry/brains.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { roster as defaultRoster } from '../registry/roster.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb adopt <pane|address> --name <name> [--role main|sub] [--parent <brain>] [--model <id>]

Registers a live session as a brain. Exits 4 when the target is not a live CLI
session, the name already exists, or --parent is unknown.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      name: { type: 'string' },
      role: { type: 'string' },
      parent: { type: 'string' },
      model: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length !== 1) throw new UsageError('adopt needs exactly one <pane|address>');
    if (!values.name) throw new UsageError('adopt requires --name <name>');
    const name = values.name;
    if (!isValidBrainName(name)) {
      console.error(`sbb: invalid brain name "${name}": must match [a-z0-9][a-z0-9-]{0,39}`);
      return EXIT.BLOCKED;
    }
    if (getBrain(name)) {
      console.error(`sbb: brain "${name}" already exists`);
      return EXIT.BLOCKED;
    }
    const role = values.role ?? 'main';
    if (!['main', 'sub'].includes(role)) throw new UsageError(`invalid --role "${role}"`);
    if (role === 'sub') {
      if (!values.parent) throw new UsageError('--role sub requires --parent <brain>');
      if (!getBrain(values.parent)) {
        console.error(`sbb: unknown parent brain "${values.parent}"`);
        return EXIT.BLOCKED;
      }
    }

    const rows = await (deps.roster ?? defaultRoster)({ withStatus: false, onWarn: deps.onWarn, accounts: deps.accounts, listPanes: deps.listPanes, capturePane: deps.capturePane, exec: deps.exec });
    const target = await (deps.resolve ?? defaultResolve)(positionals[0], { rows, accounts: deps.accounts });
    const row = rows.find((r) => r.paneId === target.paneId);
    if (!row) {
      console.error(`sbb: ${positionals[0]} is not a live CLI session`);
      return EXIT.BLOCKED;
    }

    const brain = {
      name,
      role,
      parent: role === 'sub' ? values.parent : null,
      account: row.account,
      cli: row.cli,
      model: values.model,
      cwd: row.cwd,
      paneId: row.paneId,
      coord: row.coord,
      pid: row.claude?.pid ?? undefined,
      createdAt: Date.now(),
      origin: 'adopted',
    };
    saveBrain(brain);
    if (values.json) {
      writeJson(brain);
    } else {
      console.log(`adopted ${brain.name}  role=${brain.role}  account=${brain.account}  cli=${brain.cli}  pane=${brain.paneId}  coord=${brain.coord}`);
    }
    return EXIT.OK;
  });
}

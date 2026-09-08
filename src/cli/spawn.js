// sbb spawn: launch a new brain with its briefing. docs/spec/lifecycle.md.
import { spawnBrain } from '../lifecycle/spawn.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb spawn --name <name> --role main|sub [--parent <id|name>]
          --account <acct> --cli claude|codex|agy|cursor
          [--model <id>] [--cwd <dir>] [--brief-file <path>] [--cli-args "<extra>"]
          [--split] [--force] [--json]

Creates a pane, starts the CLI with the account environment and the briefing, waits for
readiness and registers the brain. --cli-args is whitespace-split, quotes are honoured.
Exit 4 when validation, quota or readiness fails.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      name: { type: 'string' },
      role: { type: 'string' },
      parent: { type: 'string' },
      account: { type: 'string' },
      cli: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      'brief-file': { type: 'string' },
      'cli-args': { type: 'string' },
      split: { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (!values.name) throw new UsageError('spawn requires --name <name>');
    if (!values.account) throw new UsageError('spawn requires --account <acct>');
    if (!values.cli) throw new UsageError('spawn requires --cli <kind>');
    const role = values.role ?? 'main';
    if (role !== 'main' && role !== 'sub') throw new UsageError(`invalid --role "${role}"`);

    const result = await (deps.spawnBrain ?? spawnBrain)({
      name: values.name,
      role,
      parent: values.parent,
      account: values.account,
      cli: values.cli,
      model: values.model,
      cwd: values.cwd,
      briefFile: values['brief-file'],
      extraArgs: values['cli-args'],
      split: values.split,
      force: values.force,
    }, deps);

    if (result.blocked) {
      console.error(`sbb: blocked: ${result.blocked.reason}: ${result.blocked.detail}`);
      if (result.screen) console.error(result.screen);
      return EXIT.BLOCKED;
    }
    if (values.json) {
      writeJson(result);
    } else {
      const brain = result.brain;
      console.log(`spawned ${brain.id} ${brain.name} ${brain.coord ?? brain.paneId}`);
      if (result.briefFile) console.log(`brief     ${result.briefFile}`);
      if (result.quota) console.log(`quota     ${result.quota}`);
      if (result.notification) {
        const note = result.notification;
        console.log(`notify    ${note.status} via=${note.via ?? '-'}${note.reason ? ` reason=${note.reason}` : ''}${note.detail ? ` ${note.detail}` : ''}`);
      }
    }
    return EXIT.OK;
  });
}

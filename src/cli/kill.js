// sbb kill: retire a brain and its subtree. docs/spec/lifecycle.md.
import { killBrains, killPlan } from '../lifecycle/kill.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb kill <id|name> [--keep-children] [--yes] [--force] [--json]

Prints the subtree first and asks y/N on a TTY unless --yes. Tries the CLI's own exit
command when the pane is idle, then kill-pane. Retires the records, releases claims and
notifies the parent. --keep-children re-parents the children instead of killing them.`;

/** @param {import('../types.js').Brain} brain */
function line(brain) {
  return `${brain.id}  ${brain.name}  ${brain.role}  ${brain.account}/${brain.cli}  ${brain.coord ?? brain.paneId}`;
}

/**
 * @param {string} question
 * @param {Record<string, any>} deps
 * @returns {Promise<boolean>}
 */
async function confirm(question, deps) {
  if (deps.confirm) return deps.confirm(question);
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      'keep-children': { type: 'boolean' },
      yes: { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length !== 1) throw new UsageError('kill needs exactly one <id|name>');

    const plan = (deps.killPlan ?? killPlan)(positionals[0], {
      keepChildren: values['keep-children'],
      brains: deps.brains,
      getBrainFn: deps.getBrain,
    });
    if (!plan) {
      console.error(`sbb: no brain matching "${positionals[0]}"`);
      return EXIT.BLOCKED;
    }

    for (const brain of plan.victims) console.log(`kill      ${line(brain)}`);
    for (const child of plan.keep) console.log(`keep      ${line(child)}  (re-parented)`);
    if (!values.yes) {
      const ok = await confirm(`kill ${plan.victims.length} brain(s)? [y/N] `, deps);
      if (!ok) {
        console.error('sbb: not confirmed; nothing killed');
        return EXIT.USAGE;
      }
    }

    const outcome = await (deps.killBrains ?? killBrains)(plan, {
      ...deps,
      force: values.force,
    });
    if (values.json) {
      writeJson(outcome);
      return EXIT.OK;
    }
    for (const item of outcome.results) {
      console.log(`killed    ${item.brain.id}  ${item.brain.name}  ${item.exit.detail}  claims=${item.claims}`);
    }
    for (const child of outcome.reparented) {
      console.log(`reparent  ${child.id}  ${child.name}  parent=${child.parent ?? '-'}  role=${child.role}`);
    }
    if (outcome.notification) {
      const note = outcome.notification;
      console.log(`notify    ${note.status} via=${note.via ?? '-'}${note.reason ? ` reason=${note.reason}` : ''}${note.detail ? ` ${note.detail}` : ''}`);
    }
    return EXIT.OK;
  });
}

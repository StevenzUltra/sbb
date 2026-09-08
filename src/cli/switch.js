// sbb switch: focus a brain's pane in tmux. docs/spec/lifecycle.md.
import { saveBrain } from '../registry/brains.js';
import { switchTo } from '../lifecycle/switch.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb switch <id|name|#id>

Focuses the brain's current pane (select-window + select-pane), switching the client
first when it is attached to another session. Exit 4 when the pane is gone.`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length !== 1) throw new UsageError('switch needs exactly one <id|name>');

    const result = await (deps.switchTo ?? switchTo)(positionals[0], deps);
    if (result.blocked) {
      console.error(`sbb: blocked: ${result.blocked.reason}: ${result.blocked.detail}`);
      return EXIT.BLOCKED;
    }
    if (result.gone) {
      console.error(`sbb: brain ${result.brain.id} ${result.brain.name} ${result.detail}`);
      // docs/spec/lifecycle.md asks for `paneId: null` here, but registry/brains.js
      // validateBrain rejects a null paneId; say so instead of writing an invalid record.
      try {
        (deps.saveBrain ?? saveBrain)({ ...result.brain, paneId: null });
        console.error('sbb: record marked paneId=null');
      } catch (err) {
        console.error(`sbb: cannot mark paneId=null: ${err?.message ?? err}`);
      }
      return EXIT.BLOCKED;
    }
    if (values.json) writeJson(result);
    else console.log(`switched ${result.brain.id} ${result.brain.name} ${result.coord}`);
    return EXIT.OK;
  });
}

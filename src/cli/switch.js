// sbb switch: focus a brain's pane in tmux. docs/spec/lifecycle.md.
import { saveBrain } from '../registry/brains.js';
import { switchTo } from '../lifecycle/switch.js';
import { EXIT, main, parse, UsageError, writeJson } from './util.js';

const USAGE = `usage: sbb switch <id|name|#id>

Focuses the brain's current pane (select-window + select-pane). Only the caller's own
tmux client is moved; when this process has no client, it prints an "attach:" hint instead
of touching anybody else's. Exit 4 when the pane is gone.`;

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
      // Persist the gone pane (docs/spec/lifecycle.md): `sbb ls` then reports `gone`
      // instead of a stale coordinate.
      try {
        (deps.saveBrain ?? saveBrain)({ ...result.brain, paneId: null });
        console.error('sbb: record marked paneId=null');
      } catch (err) {
        console.error(`sbb: cannot mark paneId=null: ${err?.message ?? err}`);
      }
      return EXIT.BLOCKED;
    }
    if (values.json) writeJson(result);
    else {
      console.log(`switched ${result.brain.id} ${result.brain.name} ${result.coord}`);
      if (result.attach) console.log(result.attach);
    }
    return EXIT.OK;
  });
}

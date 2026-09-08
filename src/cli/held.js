// sbb held: list messages parked by the moderated policy. docs/spec/policy.md "Moderated holds".
// Default hides holds whose sender or target brain is gone; --all shows those too.
import { heldStatus, holdAlive, listHeld } from '../policy/held.js';
import { getBrain } from '../registry/brains.js';
import { EXIT, main, parse, writeJson } from './util.js';
import { heldTable } from './policy.js';

const USAGE = 'usage: sbb held [--all] [--json]';

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, {
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const parked = (deps.listHeld ?? listHeld)({ sbbDir: deps.sbbDir });
    const getBrainFn = deps.getBrain ?? getBrain;
    const holds = values.all ? parked : parked.filter((h) => holdAlive(h, { getBrainFn }));
    if (values.json) {
      writeJson(holds);
      return EXIT.OK;
    }
    if (!holds.length) {
      console.log(values.all ? 'no held messages' : 'no held messages (sbb held --all shows expired ones)');
      return EXIT.OK;
    }
    console.log(heldTable(holds));
    console.log(`\napprove: sbb approve <msgid>   deny: sbb approve --deny <msgid>`);
    return EXIT.OK;
  });
}

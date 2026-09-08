// sbb held: list messages parked by the moderated policy. docs/spec/policy.md "Moderated holds".
import { listHeld } from '../policy/held.js';
import { EXIT, main, parse, writeJson } from './util.js';
import { heldTable } from './policy.js';

const USAGE = 'usage: sbb held [--json]';

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values } = parse(argv, { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const holds = (deps.listHeld ?? listHeld)({ sbbDir: deps.sbbDir });
    if (values.json) {
      writeJson(holds);
      return EXIT.OK;
    }
    if (!holds.length) {
      console.log('no held messages');
      return EXIT.OK;
    }
    console.log(heldTable(holds));
    console.log(`\napprove: sbb approve <msgid>   deny: sbb approve --deny <msgid>`);
    return EXIT.OK;
  });
}

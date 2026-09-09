// sbb account: list accounts, or create one under a temporary HOME only.
// docs/spec/policy.md "sbb account".
import { listBrains } from '../registry/brains.js';
import { AccountError, accountAdd, accountList } from '../account/account.js';
import { EXIT, UsageError, main, parse, renderTable, writeJson } from './util.js';

const USAGE = 'usage: sbb account ls [--json]\n       sbb account add <name> [--force]';

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const sub = positionals[0] ?? 'ls';
    const home = deps.home;

    if (sub === 'ls') {
      const accounts = (deps.accountList ?? accountList)({
        home,
        brains: deps.brains ?? listBrains(),
        discover: deps.discover,
      });
      if (values.json) {
        writeJson(accounts);
        return EXIT.OK;
      }
      if (!accounts.length) {
        console.log('no accounts');
        return EXIT.OK;
      }
      console.log(renderTable(
        ['ACCOUNT', 'CLAUDE', 'CODEX', 'AGY', 'CURSOR', 'KIMI', 'GROK', 'BRAINS', 'WRAPPER'],
        accounts.map((a) => [
          a.name,
          a.hasClaudeCreds ? 'yes' : 'no',
          a.hasCodexCreds ? 'yes' : 'no',
          a.hasAgyCreds ? 'yes' : 'no',
          a.hasCursorCreds ? 'yes' : 'no',
          a.hasKimiCreds ? 'yes' : 'no',
          a.hasGrokCreds ? 'yes' : 'no',
          a.brains.length || '-',
          a.wrapper ?? '-',
        ]),
      ));
      return EXIT.OK;
    }

    if (sub === 'add') {
      const name = positionals[1];
      if (!name) throw new UsageError('account add needs <name>');
      let result;
      try {
        result = (deps.accountAdd ?? accountAdd)(name, { home, force: values.force, template: deps.template });
      } catch (err) {
        if (err instanceof AccountError) throw new UsageError(err.message);
        throw err;
      }
      if (values.json) {
        writeJson(result);
        return EXIT.OK;
      }
      console.log(`account ${result.name} ready`);
      console.log(`  base    ${result.baseDir}`);
      console.log(`  claude   ${result.claudeDir}`);
      console.log(`  codex    ${result.codexDir}`);
      console.log(`  agy      ${result.agyDir}`);
      console.log(`  cursor   ${result.cursorDir}`);
      console.log(`  kimi     ${result.kimiDir}`);
      console.log(`  grok     ${result.grokDir}`);
      console.log(`  wrapper  ${result.wrapper}`);
      console.log(`next: log in once with \`ai-${result.name} <cli>\` (claude, codex, grok, cursor, kimi); SBB never touches credentials`);
      return EXIT.OK;
    }

    throw new UsageError(`unknown account subcommand "${sub}"`);
  });
}

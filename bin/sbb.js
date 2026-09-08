#!/usr/bin/env node
// SBB command entry. Each subcommand lives in src/cli/<name>.js and exports
// `run(argv) -> Promise<number>` (exit code). Keep this file free of logic.

const COMMANDS = {
  ls: 'List brains and live CLI sessions across all accounts',
  adopt: 'Register an existing pane or session as a brain',
  tell: 'Send a message to a brain and print the receipt',
  ask: 'Send a message and wait for a reply or idle notice',
  reply: 'Reply to a message id (routes back to the sender)',
  collect: 'Print unread replies addressed to this brain',
  watch: 'Stream receipts and messages as they happen',
  quota: 'Show remaining quota per account (read-only)',
  catalog: 'Show accounts x CLIs x models available on this machine',
  doctor: 'Check tmux, accounts, sockets and Usage Guard availability',
};

function usage() {
  const lines = ['usage: sbb <command> [options]', ''];
  for (const [name, help] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(9)} ${help}`);
  }
  lines.push('', 'Run `sbb <command> --help` for options.');
  return lines.join('\n');
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    console.log(usage());
    return command ? 0 : 2;
  }
  if (!(command in COMMANDS)) {
    console.error(`sbb: unknown command "${command}"\n\n${usage()}`);
    return 2;
  }
  const mod = await import(`../src/cli/${command}.js`);
  return mod.run(rest);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(typeof code === 'number' ? code : 0),
  (err) => {
    console.error(`sbb: ${err?.stack ?? err}`);
    process.exit(1);
  },
);

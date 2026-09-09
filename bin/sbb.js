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
  spawn: 'Launch a new brain (account, CLI, model, role) with its briefing',
  kill: 'Retire a brain and its subtree (graceful exit, then kill-pane)',
  switch: 'Focus a brain\'s pane in tmux',
  move: 'Transfer a brain (with context) under another parent',
  policy: 'Show or change who may talk to whom, quota floors',
  held: 'List messages held for user approval (moderated peers)',
  approve: 'Release or deny a held message',
  claim: 'Register resources a brain is working on; detect conflicts',
  plan: 'Propose, review, approve or reject a staffing plan',
  ui: 'Serve the local web console (view brains, panes, quota, TPS)',
  account: 'List isolated accounts or create a new one',
  help: 'Show the command overview, or the protocol rules (sbb help protocol)',
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

/**
 * Leave with `code` once stdout and stderr have drained. Explicit, because a handle nobody
 * closed (a cached transport inbox, a peer socket the OS has not released) must not keep
 * `sbb` alive after the receipt is on disk. Flushed first, because stdout is a pipe
 * whenever `sbb` runs inside a pipeline and process.exit() drops buffered writes.
 * @param {number} code
 */
function exitNow(code) {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  for (const stream of [process.stdout, process.stderr]) {
    try {
      if (stream.writableLength === 0) done();
      else stream.write('', done);
    } catch {
      done();
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => exitNow(typeof code === 'number' ? code : 0),
  (err) => {
    console.error(`sbb: ${err?.stack ?? err}`);
    exitNow(1);
  },
);

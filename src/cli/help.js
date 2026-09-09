// sbb help: the command overview and the protocol rules a brain is briefed with.
// The rule blocks come from src/lifecycle/briefing.js so `sbb help protocol` cannot
// drift from the spawn brief; the one-line usages are checked against bin/sbb.js by
// test/help.test.js.
import { HOW_TO_TALK, INBOX_HINT, RULES, STATUS } from '../lifecycle/briefing.js';
import { EXIT, main } from './util.js';

/**
 * One entry per command in bin/sbb.js COMMANDS, in the same order.
 * @type {ReadonlyArray<readonly [string, string, string]>} [name, usage, summary]
 */
export const COMMANDS = Object.freeze([
  ['ls', 'sbb ls [<id|name>] [--json] [--tree] [--account <name>] [--cli <kind>] [--claims]',
    'List brains and live CLI sessions across all accounts'],
  ['adopt', 'sbb adopt <pane|address> --name <name> [--role main|sub] [--parent <brain>] [--model <id>]',
    'Register an existing pane or session as a brain'],
  ['tell', 'sbb tell <address> <text...> [--priority now|next|later] [--role <text>] [--file <path>] [--timeout <ms|30s|5m|1h>] [--force] [--dry-run]',
    'Send a message to a brain and print the receipt'],
  ['ask', 'sbb ask <address> <text...> [--wait <ms|30s|5m|1h>] [--priority now|next|later] [--role <text>] [--force]',
    'Send a message and wait for a reply or idle notice'],
  ['reply', 'sbb reply <msgId8|msgId> <text...> [--role <text>]',
    'Reply to a message id (routes back to the sender)'],
  ['collect', 'sbb collect [--for <brain>] [--all] [--json]',
    'Print unread replies addressed to this brain'],
  ['watch', 'sbb watch [--json]', 'Stream receipts and messages as they happen'],
  ['quota', 'sbb quota [--json] [--refresh]', 'Show remaining quota per account (read-only)'],
  ['catalog', 'sbb catalog [--json]', 'Show accounts x CLIs x models available on this machine'],
  ['doctor', 'sbb doctor [--json]', 'Check tmux, accounts, sockets and Usage Guard availability'],
  ['spawn', 'sbb spawn --name <name> --role main|sub [--parent <id|name>] --account <acct> --cli claude|codex|agy|cursor|kimi|grok [--model <id>] [--cwd <dir>] [--brief-file <path>] [--cli-args="<extra>"] [--split] [--force] [--json]',
    'Launch a new brain (account, CLI, model, role) with its briefing'],
  ['kill', 'sbb kill <id|name> [--keep-children] [--yes] [--force] [--json]',
    'Retire a brain and its subtree (graceful exit, then kill-pane)'],
  ['switch', 'sbb switch <id|name|#id>', "Focus a brain's pane in tmux"],
  ['move', 'sbb move <id|name> --to <id|name|root> [--now | --after-idle [--wait <ms|30s|5m|1h>]] [--handoff] [--yes] [--json]',
    'Transfer a brain (with context) under another parent'],
  ['policy', 'sbb policy show [--json] | peers on|off|moderated | set <id|name> [--peers on|off] [--autonomous on|off] | allow <a> <b> | deny <a> <b> | quota [--floor-weekly <n>] [--main-reserve <n>]',
    'Show or change who may talk to whom, quota floors'],
  ['held', 'sbb held [--all] [--json]', 'List messages held for user approval; --all includes expired ones'],
  ['approve', 'sbb approve [--deny] [--reason <text>] <msgId8> [--json]',
    'Release or deny a held message'],
  ['claim', 'sbb claim add <resource> [--note <text>] | release <resource> | release --all | ls [--all] [--json]',
    'Register resources a brain is working on; detect conflicts'],
  ['plan', 'sbb plan propose --file <plan.json> | ls [--json] | show <planId> [--json] | approve <planId> [--edit <file>] | reject <planId> --reason <text>',
    'Propose, review, approve or reject a staffing plan'],
  ['ui', 'sbb ui [--port <n>] [--no-open] [--json]', 'Serve the local web console (view brains, panes, quota, TPS)'],
  ['account', 'sbb account ls [--json] | add <name> [--force]', 'List isolated accounts or create a new one'],
  ['help', 'sbb help [protocol]', 'Show the command overview, or the protocol rules'],
]);

/** @returns {string} */
export function overviewText() {
  const lines = ['usage: sbb <command> [options]', ''];
  for (const [name, , summary] of COMMANDS) lines.push(`  ${name.padEnd(9)} ${summary}`);
  lines.push('', 'Run `sbb <command> --help` for options, or `sbb help protocol` for the rules.');
  return lines.join('\n');
}

/** @returns {string} */
export function protocolText() {
  const lines = [
    'SBB 协议（与 spawn 简报同款）：',
    '',
    '怎么说话：',
    ...HOW_TO_TALK,
    '',
    '规矩：',
    ...RULES,
    '',
    '状态：',
    ...STATUS,
    '',
    INBOX_HINT,
    '',
    '命令：',
  ];
  for (const [name, usage] of COMMANDS) lines.push(`  ${name.padEnd(9)} ${usage}`);
  return lines.join('\n');
}

export async function run(argv = []) {
  return main(async () => {
    const topic = argv.find((arg) => !String(arg).startsWith('-'));
    if (topic === undefined) {
      console.log(overviewText());
      return EXIT.OK;
    }
    if (topic === 'protocol') {
      console.log(protocolText());
      return EXIT.OK;
    }
    console.error(`sbb: unknown help topic "${topic}"; try: sbb help protocol`);
    return EXIT.USAGE;
  });
}

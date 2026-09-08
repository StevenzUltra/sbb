// sbb move: transfer a brain (with its whole subtree) under a new parent, keeping its
// conversation context. docs/spec/move.md.
import { createInterface } from 'node:readline/promises';
import { roster as defaultRoster } from '../registry/roster.js';
import { closeInboxes } from '../transports/claude-uds.js';
import {
  DEFAULT_WAIT_MS,
  ROOT,
  applyMove,
  firstFailure,
  notify,
  planMove,
  requestHandoff,
  waitIdle,
} from '../move/move.js';
import {
  EXIT,
  UsageError,
  callerIdentity,
  main,
  parse,
  parseDuration,
  writeJson,
} from './util.js';

const USAGE = `usage: sbb move <id|name> --to <id|name|root> [--now | --after-idle [--wait <ms|30s|5m|1h>]]
                [--handoff] [--yes] [--json]

Re-parents a brain and everything under it without touching its process, so its
conversation context is preserved. --now moves immediately; --after-idle (default)
waits for the brain to finish its current turn, showing "-> <target>" in sbb ls
while it waits. --handoff asks the brain to write a summary first. Exit 0 moved or
nothing to do, 4 blocked (cycle, unknown or dead parent), 5 wait timeout.`;

/** @param {string} question */
async function askOnTty(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** @param {ReturnType<import('../move/move.js').planMove>} plan */
function targetDisplay(plan) {
  return plan.to.parent ? `${plan.to.parentName}#${plan.to.parent}` : ROOT;
}

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      to: { type: 'string' },
      now: { type: 'boolean' },
      'after-idle': { type: 'boolean' },
      wait: { type: 'string' },
      handoff: { type: 'boolean' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (positionals.length !== 1) throw new UsageError('move needs exactly one <id|name>');
    if (!values.to) throw new UsageError('move requires --to <id|name|root>');
    if (values.now && values['after-idle']) throw new UsageError('--now and --after-idle are mutually exclusive');
    const immediate = Boolean(values.now);
    const waitMs = values.wait ? parseDuration(values.wait) : DEFAULT_WAIT_MS;

    const rows = deps.rows ?? (await (deps.roster ?? defaultRoster)({
      withStatus: false,
      onWarn: deps.onWarn,
      accounts: deps.accounts,
      listPanes: deps.listPanes,
      capturePane: deps.capturePane,
      exec: deps.exec,
    }));
    const plan = (deps.planMove ?? planMove)(positionals[0], values.to, {
      rows,
      getBrain: deps.getBrain,
      listBrains: deps.listBrains,
    });

    const failure = firstFailure(plan);
    if (failure) {
      if (failure.reason === 'nothing_to_do') {
        console.log(`nothing to do: ${failure.detail}`);
        return EXIT.OK;
      }
      console.error(`sbb: blocked: ${failure.reason}: ${failure.detail ?? failure.name}`);
      return EXIT.BLOCKED;
    }

    if (!values.yes && process.stdin.isTTY) {
      const subtree = plan.subtree.length ? ` (+${plan.subtree.length} under it)` : '';
      const approve = deps.confirm ?? askOnTty;
      const ok = await approve(`move ${plan.brain.name}#${plan.brain.id}${subtree} -> ${targetDisplay(plan)}?`);
      if (!ok) {
        console.log('aborted');
        return EXIT.OK;
      }
    }

    // Step 1: optional handoff summary, before any timing decision. A timeout is not fatal.
    let handoff = null;
    if (values.handoff) {
      const result = await (deps.handoff ?? requestHandoff)(plan.brain, {
        run: deps.run,
        path: deps.handoffPath,
        env: deps.env,
      });
      // `wrote` covers the measured case where the brain writes the summary but never
      // replies through sbb, so the ask exits 5 with a complete file already on disk.
      const summary = result.ok || result.wrote;
      handoff = summary ? result.path : null;
      console.log(`handoff   ${summary
        ? (result.ok ? result.path : `${result.path} (written; the brain did not reply, ask exit ${result.code})`)
        : `no reply (exit ${result.code}) - continuing without a summary`}`);
    }

    // Step 2: timing. --after-idle leaves a marker in the record while it waits.
    if (!immediate) {
      const pendingMove = { to: values.to, requestedAt: Date.now(), handoff };
      const outcome = await (deps.waitIdle ?? waitIdle)(plan.brain, {
        timeoutMs: waitMs,
        pendingMove,
        pollMs: deps.pollMs,
        readStatus: deps.readStatus,
        tmuxApi: deps.tmuxApi,
        sleep: deps.sleep,
        now: deps.now,
        saveBrain: deps.saveBrain,
      });
      if (outcome.status === 'timeout') {
        console.error(`sbb: ${plan.brain.name} is still busy after ${(outcome.elapsedMs / 1000).toFixed(0)}s; pendingMove kept, finish later with: sbb move ${plan.brain.name} --to ${values.to} --now`);
        return EXIT.TIMEOUT;
      }
      console.log(`idle      ${plan.brain.name} went idle after ${(outcome.elapsedMs / 1000).toFixed(1)}s`);
    }

    // Step 3: re-parent.
    const identity = { ...(await (deps.callerIdentity ?? callerIdentity)(deps)) };
    const moved = (deps.applyMove ?? applyMove)(plan, { saveBrain: deps.saveBrain });

    // Step 4: notify, never rolling back a blocked notification.
    const print = values.json ? () => {} : (line) => console.log(line);
    const notifications = await (deps.notify ?? notify)(plan, handoff, {
      identity,
      deps,
      print,
      resolve: deps.resolve,
      deliver: deps.deliver,
      openInbox: deps.openInbox,
      closeInboxes: deps.closeInboxes ?? closeInboxes,
    });

    // Step 5.
    if (values.json) {
      writeJson({
        brain: moved,
        from: plan.from,
        to: plan.to,
        roleAfter: plan.roleAfter,
        subtree: plan.subtree,
        handoff,
        notifications,
      });
    } else {
      console.log(`moved ${moved.id} ${moved.name} -> ${targetDisplay(plan)}`);
    }
    return EXIT.OK;
  });
}

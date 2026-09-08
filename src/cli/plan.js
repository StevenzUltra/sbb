// sbb plan: propose team staffing, then approve or reject it. Approving shells out to
// `sbb spawn` once per node. docs/spec/policy.md "Plans".
import { readFileSync } from 'node:fs';
import { newMsgId, shortId } from '../lib/ids.js';
import { discoverAccounts } from '../lib/paths.js';
import { writeInboxEntry } from '../registry/inbox.js';
import { getBrain as defaultGetBrain, listBrains } from '../registry/brains.js';
import { readConfig } from '../policy/config.js';
import { readQuota } from '../quota/usage-guard.js';
import { resolve as defaultResolve } from '../registry/resolve.js';
import { closeInboxes } from '../transports/claude-uds.js';
import {
  PlanError,
  approvePlan,
  createPlan,
  getPlan,
  listPlans,
  mayApprove,
  mayPropose,
  rejectPlan,
} from '../policy/plans.js';
import { EXIT, UsageError, callerIdentity, deliver, main, openDeliveryInbox, parse, renderTable, writeJson } from './util.js';

const USAGE = `usage: sbb plan propose --file <plan.json>
       sbb plan ls [--json]
       sbb plan show <planId> [--json]
       sbb plan approve <planId> [--edit <file>] [--json]
       sbb plan reject <planId> --reason <text>`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      file: { type: 'string' },
      edit: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const sub = positionals[0] ?? 'ls';
    const sbbDir = deps.sbbDir;
    const getBrain = deps.getBrain ?? defaultGetBrain;
    const accounts = deps.accounts ?? discoverAccounts();

    if (sub === 'ls') {
      const plans = (deps.listPlans ?? listPlans)({ sbbDir });
      if (values.json) {
        writeJson(plans);
        return EXIT.OK;
      }
      if (!plans.length) {
        console.log('no plans');
        return EXIT.OK;
      }
      console.log(renderTable(
        ['PLANID', 'STATUS', 'PARENT', 'BRAINS', 'PROPOSED BY', 'REASON'],
        plans.map((p) => [
          p.planId,
          p.status,
          p.parent,
          p.brains.length,
          p.proposedBy,
          (p.reason ?? '').slice(0, 40) || '-',
        ]),
      ));
      return EXIT.OK;
    }

    if (sub === 'show') {
      const ref = positionals[1];
      if (!ref) throw new UsageError('plan show needs <planId>');
      const found = getPlan(ref, { sbbDir });
      if (!found) throw new UsageError(`no plan matching "${ref}"`);
      writeJson(found.plan);
      return EXIT.OK;
    }

    if (sub === 'propose') {
      if (!values.file) throw new UsageError('plan propose needs --file <plan.json>');
      let input;
      try {
        input = JSON.parse(readFileSync(values.file, 'utf8'));
      } catch (err) {
        throw new UsageError(`cannot read ${values.file}: ${err?.message ?? err}`);
      }
      const identity = await callerIdentity(deps);
      const proposer = identity.id ? getBrain(identity.id) ?? null : null;
      let plan;
      try {
        plan = createPlan(input, { proposer, getBrain, accounts, sbbDir });
      } catch (err) {
        if (err instanceof PlanError) throw new UsageError(err.message);
        throw err;
      }
      const entry = {
        msgId: newMsgId(),
        source: 'plan',
        planId: plan.planId,
        text: `plan ${plan.planId} pending: parent=${plan.parent} brains=${plan.brains.map((b) => b.name).join(', ')} — approve with \`sbb plan approve ${plan.planId}\``,
      };
      try {
        writeInboxEntry({ owner: 'user', entry });
      } catch (err) {
        console.error(`sbb: warning: could not notify the user inbox: ${err?.message ?? err}`);
      }
      if (values.json) writeJson(plan);
      else {
        console.log(`plan        ${plan.planId}  pending`);
        console.log(`parent      ${plan.parent}`);
        console.log(`brains      ${plan.brains.map((b) => `${b.name}(${b.role}/${b.account}/${b.cli})`).join(', ')}`);
        console.log(`approve     sbb plan approve ${plan.planId}`);
      }
      return EXIT.OK;
    }

    if (sub === 'approve') {
      const ref = positionals[1];
      if (!ref) throw new UsageError('plan approve needs <planId>');
      const found = getPlan(ref, { sbbDir });
      if (!found) throw new UsageError(`no plan matching "${ref}"`);
      const identity = await callerIdentity(deps);
      const approver = identity.id ? getBrain(identity.id) ?? null : null;
      const config = (deps.readConfig ?? readConfig)({ sbbDir });
      if (!mayApprove(found.plan, approver, { getBrain, config })) {
        throw new UsageError(`brain ${approver?.id} may not approve ${found.plan.planId} (only the parent when autonomous, an ancestor, or the user)`);
      }
      let edit;
      if (values.edit) {
        try {
          edit = JSON.parse(readFileSync(values.edit, 'utf8'));
        } catch (err) {
          throw new UsageError(`cannot read ${values.edit}: ${err?.message ?? err}`);
        }
      }
      const rows = await (deps.readQuota ?? readQuota)({});
      const { plan, result } = await approvePlan(found.plan, {
        approver,
        edit,
        config,
        rows,
        brains: deps.brains ?? listBrains(),
        spawn: deps.spawn,
        getBrain,
        accounts,
        sbbDir,
      });
      await notifyProposer(plan, result, deps);
      if (values.json) writeJson(result);
      else {
        console.log(`plan        ${plan.planId}  ${plan.status}`);
        for (const node of result.results) {
          const detail = node.status === 'spawned'
            ? `${node.id}  ${node.coord}`
            : `${node.detail ?? ''}`;
          console.log(`  ${node.status.padEnd(8)} ${node.name.padEnd(16)} ${detail}`.trimEnd());
        }
        console.log(`result      ${result.planId}.result.json`);
      }
      return result.results.every((r) => r.status === 'spawned') ? EXIT.OK : EXIT.BLOCKED;
    }

    if (sub === 'reject') {
      const ref = positionals[1];
      if (!ref) throw new UsageError('plan reject needs <planId>');
      if (!values.reason) throw new UsageError('plan reject needs --reason <text>');
      const found = getPlan(ref, { sbbDir });
      if (!found) throw new UsageError(`no plan matching "${ref}"`);
      const identity = await callerIdentity(deps);
      const plan = rejectPlan(found.plan, values.reason, {
        sbbDir,
        decidedBy: identity.id ?? 'user',
        now: deps.now,
      });
      await notifyProposer(plan, { results: [], planId: plan.planId }, deps);
      console.log(`plan        ${plan.planId}  rejected: ${plan.rejectionReason}`);
      return EXIT.OK;
    }

    throw new UsageError(`unknown plan subcommand "${sub}"`);
  });
}

/**
 * One line to the proposer (skipped when the user proposed: the CLI output is the notice).
 * @param {Record<string, any>} plan @param {Record<string, any>} result @param {Record<string, any>} deps
 */
async function notifyProposer(plan, result, deps) {
  const id = plan.proposedBy;
  if (!id || id === 'user') return;
  const getBrain = deps.getBrain ?? defaultGetBrain;
  const proposer = getBrain(id);
  if (!proposer) return;
  const spawned = (result.results ?? []).filter((r) => r.status === 'spawned').length;
  const body = plan.status === 'rejected'
    ? `plan ${plan.planId} rejected: ${plan.rejectionReason}`
    : `plan ${plan.planId} ${plan.status}: spawned=${spawned} failed=${(result.results ?? []).length - spawned}; report ~/.sbb/plans/${plan.planId}.result.json`;
  // Same path as `sbb tell`: resolve the proposer to a live target (the roster row carries
  // its Claude socket, which is what makes the uds transport available) and open our own
  // delivery inbox so the message carries fromSock and the peer's receipt can come back.
  // The hand-built target used to miss both, fall back to send-keys and get blocked with
  // reason=target_busy while the receipt showed an empty fromSock (rehearsal run 11).
  const identity = await callerIdentity(deps);
  let target;
  try {
    target = await (deps.resolve ?? defaultResolve)(proposer.name, {
      rows: deps.rows,
      roster: deps.roster,
      accounts: deps.accounts,
      resolvePaneId: deps.resolvePaneId,
      onWarn: deps.onWarn,
    });
  } catch (err) {
    console.error(`sbb: warning: could not notify ${proposer.name}: ${err?.message ?? err}`);
    return;
  }
  const inbox = await openDeliveryInbox({ target, owner: identity.brain ?? 'user', deps });
  try {
    await deliver({ target, body, identity, skipPolicy: true, deps, send: deps.send, inbox });
  } catch (err) {
    console.error(`sbb: warning: could not notify ${proposer.name}: ${err?.message ?? err}`);
  } finally {
    await inbox?.close?.();
    await (deps.closeInboxes ?? closeInboxes)();
  }
}

/** @param {Record<string, any>} plan */
export function planLine(plan) {
  return `${plan.planId}  ${plan.status}  parent=${plan.parent}  brains=${plan.brains.length}  by=${shortId(String(plan.proposedBy))}`;
}

/** Re-exported so tests can assert the proposer rule without the CLI. */
export { mayPropose };

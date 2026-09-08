// sbb claim: typed resource claims so two brains never fight over one branch, path, port,
// device or worktree. docs/spec/policy.md "Claims".
import { shortId } from '../lib/ids.js';
import { listBrains, getBrain as defaultGetBrain } from '../registry/brains.js';
import { ClaimError, addClaim, detectConflicts, listAllClaims, releaseClaim, releaseClaims } from '../policy/claims.js';
import { rootMain } from '../policy/rules.js';
import { EXIT, UsageError, callerIdentity, deliver, main, parse, renderTable, writeJson } from './util.js';

const USAGE = `usage: sbb claim add <resource> [--note <text>]
       sbb claim release <resource> | --all
       sbb claim ls [--all] [--json]

resource: branch:<name> | path:<path> | port:<n> | device:<id> | worktree:<path>`;

export async function run(argv, deps = {}) {
  return main(async () => {
    const { values, positionals } = parse(argv, {
      note: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    });
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const sub = positionals[0] ?? 'ls';
    const sbbDir = deps.sbbDir;

    if (sub === 'ls') {
      const live = new Set((deps.brains ?? listBrains()).map((b) => b.id));
      let rows = listAllClaims({ sbbDir });
      if (!values.all) rows = rows.filter((r) => live.has(r.brain));
      const conflicted = new Set();
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          if (rows[i].brain !== rows[j].brain && detectConflicts(rows[i].brain, { sbbDir, brains: deps.brains ?? [] })
            .some((c) => c.brain === rows[j].brain && c.resource === rows[i].resource)) {
            conflicted.add(rows[i].brain);
            conflicted.add(rows[j].brain);
          }
        }
      }
      if (values.json) {
        writeJson(rows);
        return EXIT.OK;
      }
      if (!rows.length) {
        console.log('no claims');
        return EXIT.OK;
      }
      console.log(renderTable(
        ['BRAIN', 'RESOURCE', 'AT', 'NOTE'],
        rows.map((r) => [
          `${conflicted.has(r.brain) ? '!' : ''}${r.brain}`,
          r.resource,
          new Date(r.at ?? 0).toISOString().replace('T', ' ').slice(0, 16),
          r.note ?? '-',
        ]),
      ));
      return EXIT.OK;
    }

    const identity = await callerIdentity(deps);
    if (!identity.id) throw new UsageError(`claim ${sub} must run inside a registered brain pane`);

    if (sub === 'add') {
      const resource = positionals[1];
      if (!resource) throw new UsageError('claim add needs <resource>');
      const { claim } = addClaim(identity.id, resource, { note: values.note, sbbDir });
      const brains = deps.brains ?? listBrains();
      // only the resource just added: a stale conflict on another claim must not make
      // every later `claim add` exit 3 again
      const conflicts = detectConflicts(identity.id, { sbbDir, brains })
        .filter((c) => c.resource === claim.resource);
      if (!conflicts.length) {
        console.log(`claimed     ${claim.resource}  by ${identity.brain}#${identity.id}`);
        return EXIT.OK;
      }
      for (const c of conflicts) console.log(`conflict with ${c.name}#${c.brain} (${c.resource})`);
      const notified = await notifyConflict({ identity, conflicts, brains, deps });
      if (notified.length) console.log(`notified    ${notified.join(', ')}`);
      return EXIT.UNVERIFIED;
    }

    if (sub === 'release') {
      if (values.all) {
        const { released } = releaseClaims(identity.id, { sbbDir });
        console.log(`released    ${released} claim(s) by ${identity.brain}#${identity.id}`);
        return EXIT.OK;
      }
      const resource = positionals[1];
      if (!resource) throw new UsageError('claim release needs <resource> or --all');
      const { released } = releaseClaim(identity.id, resource, { sbbDir });
      if (!released) {
        console.log(`not claimed ${resource}`);
        return EXIT.OK;
      }
      console.log(`released    ${resource}`);
      return EXIT.OK;
    }

    throw new UsageError(`unknown claim subcommand "${sub}"`);
  });
}

/**
 * Spec: both mains (or a user) involved -> message both; otherwise each side's main brain.
 * @param {{ identity: Record<string, any>, conflicts: Record<string, any>[],
 *           brains: import('../types.js').Brain[], deps: Record<string, any> }} input
 */
async function notifyConflict({ identity, conflicts, brains, deps }) {
  const getBrain = deps.getBrain ?? defaultGetBrain;
  const mine = getBrain(identity.id) ?? null;
  const others = conflicts.map((c) => getBrain(c.brain)).filter(Boolean);
  /** @type {Set<import('../types.js').Brain>} */
  const targets = new Set();
  const bothMains = mine?.role === 'main' && others.every((o) => o.role === 'main');
  if (bothMains) {
    if (mine) targets.add(mine);
    for (const o of others) targets.add(o);
  } else {
    for (const brain of [mine, ...others]) {
      const main = brain ? rootMain(brain, getBrain) : null;
      if (main) targets.add(main);
    }
  }
  const body = `claim conflict: ${identity.brain}#${identity.id} holds ${conflicts.map((c) => c.resource).join(', ')}, also held by ${conflicts.map((c) => `${c.name}#${c.brain}`).join(', ')}`;
  const notified = [];
  for (const target of targets) {
    if (target.id === identity.id) continue;
    try {
      await deliver({
        target: { address: target.name, brain: target.name, brainId: target.id, account: target.account, cli: target.cli, paneId: target.paneId, coord: target.coord },
        body,
        identity,
        skipPolicy: true,
        deps,
        send: deps.send,
      });
      notified.push(`${target.name}#${target.id}`);
    } catch (err) {
      console.error(`sbb: warning: could not notify ${target.name}: ${err?.message ?? err}`);
    }
  }
  return notified;
}

/** Kept for tests: a one-line claim row. */
export function claimLine(claim, name) {
  return `${claim.resource}  ${name ?? ''}  ${shortId(String(claim.at ?? ''))}`;
}

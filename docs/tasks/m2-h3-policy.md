# Task M2-h3: policy, moderated holds, claims, plans, accounts

Branch `m2/h3-policy`, worktree `~/developer/sbb-worktrees/h3` (branch from `origin/main`).
Spec: `docs/spec/policy.md`; also read `docs/spec/lifecycle.md` (spawn interface, which
`plan approve` shells out to), `docs/spec/registry.md`, `src/cli/util.js` (you own it),
`src/registry/brains.js`, `src/quota/usage-guard.js`.

You own: `src/policy/*.js` (new: `config.js`, `rules.js`, `held.js`, `claims.js`, `plans.js`),
`src/account/*.js` (new: `account.js`, `wrapper-template.sh`), `src/cli/policy.js`,
`src/cli/claim.js`, `src/cli/plan.js`, `src/cli/account.js`, `src/cli/approve.js`,
`src/cli/held.js`, `src/cli/util.js` (policy + quota enforcement hook before delivery),
`src/cli/ls.js` (`--claims` marker only; h2 edits the pendingMove hint in another function,
keep your change local), tests `test/policy*.test.js`, `test/claims.test.js`,
`test/plans.test.js`, `test/account.test.js`, fixtures under `test/fixtures/policy/`.

## Deliverables

1. `config.js`: read/merge defaults/atomic write of `~/.sbb/config.json` (respect `SBB_DIR`).
2. `rules.js` `check(sender, target, config)` exactly per the table; table-driven tests
   covering every row, `allow` pairs, `autonomous`, `peers: off` per brain, unregistered
   sides.
3. Enforcement in `util.js`: before delivery resolve sender brain (from `$TMUX_PANE` ->
   `@sbb_brain` pane option or registry paneId) and target brain; `blocked reason=policy`
   with detail; `moderated` -> `held.js` write + message to the sender; quota floor per the
   spec (`unknown` never blocks; `--force` bypasses; blocked reason `quota`).
4. `sbb held`, `sbb approve [--deny] <msgId8>`.
5. `claims.js` + `sbb claim add|release|ls`, conflict detection and notifications per spec,
   release on retire (hook in `brains.js` `removeBrain` is h1's kill path: expose
   `releaseClaims(id)` and ask h1 by message to call it, or call it from `kill` yourself only
   if h1 agrees; do not edit `src/lifecycle/`).
6. `plans.js` + `sbb plan propose|ls|show|approve|reject`; `approve` runs `sbb spawn` per
   node as a child process (injectable), records results, notifies the proposer.
7. `account.js` + `sbb account ls|add`; the wrapper template mirrors `~/bin/ai-c` behaviour
   (read it; do not copy any secrets or paths beyond what the spec lists). Test `add` only
   under a temp `HOME` (`SBB_HOME_OVERRIDE`) and never on the real home.
8. Real acceptance (scratch `SBB_DIR`, real read-only registries): policy table with two
   adopted scratch brains, a moderated hold + approve, a claim conflict notification, a plan
   propose/approve that spawns one haiku brain via h1's `sbb spawn` once it lands (until
   then, test with an injected fake spawn and say so).

## Acceptance

- `npm test` green (3 runs). No new dependency. Only your files changed.
- Report `docs/reports/m2-h3-<date>.md`, then one line to the lead via `sbb reply <msgId8>`.

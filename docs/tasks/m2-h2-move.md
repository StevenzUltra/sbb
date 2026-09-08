# Task M2-h2: sbb move (transfer with context)

Branch `m2/h2-move`, worktree `~/developer/sbb-worktrees/h2` (branch from `origin/main`).
Spec: `docs/spec/move.md`; also read `docs/spec/registry.md`, `docs/spec/lifecycle.md`
(briefing wording for the notifications), `src/registry/brains.js`, `src/registry/resolve.js`,
`src/cli/util.js` (delivery helpers: import, do not edit), `src/transports/confirm.js`
(`readClaudeStatus`), `src/transports/cli-profiles.js`.

You own: `src/move/*.js` (new: `move.js` with `planMove`, `applyMove`, `waitIdle`,
`notify`), `src/cli/move.js`, `src/cli/ls.js` only for the `STATUS` column `-> <target>` hint
when `pendingMove` is set (coordinate: keep the change to one function), tests
`test/move.test.js`, fixtures under `test/fixtures/move/`.

## Deliverables

1. `planMove(brainRef, targetRef, opts) -> { brain, from, to, subtree, roleAfter, checks }`
   with the cycle and no-op checks from the spec; pure over an injected registry.
2. `applyMove(plan)`: atomic record update (parent, role, clear `pendingMove`).
3. `waitIdle(brain, { timeoutMs, pollMs })`: Claude via `readClaudeStatus`, others via
   the idle fingerprint through an injectable `tmuxApi`; writes/clears `pendingMove`.
4. `notify(plan, handoffPath)`: the three messages in the spec order through the delivery
   helper, receipts collected and printed; a blocked receipt never rolls back.
5. `--handoff` via `sbb ask` (spawn `sbb` as a child process with the same env, injectable).
6. `src/cli/move.js` per the spec, exit codes: 0 moved, 4 blocked (cycle/unknown), 5 wait
   timeout.
7. Real acceptance (scratch only, `SBB_DIR` temp + `SBB_TMUX_ARGS="-L sbb-h2"`): adopt two
   scratch Claude panes (account `a`, model haiku) as `lead` and `ops`, adopt a third as sub
   `ios` under `lead`, run `sbb move ios --to ops --now`, show `sbb ls --tree` before and
   after and the three notification receipts; then `--after-idle` while `ios` is busy on a
   `sleep 20` style task and show the pending marker, the wait, and the final move.

## Acceptance

- `npm test` green (3 runs). No new dependency. Only your files changed (plus the one `ls`
  function).
- Report `docs/reports/m2-h2-<date>.md` with the real transcript, then one line to the lead
  via `sbb reply <msgId8>`.

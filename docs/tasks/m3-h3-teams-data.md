# Task M3-h3: team channels, revised talk table, console data service

Branch `m3/h3-teams-data`, worktree `~/developer/sbb-worktrees/h3` (branch from `origin/main`).
Spec: `docs/spec/teams.md` (everything), `docs/spec/ui-server.md` (the `/api/state` shape and event
names your data service must produce), `docs/spec/policy.md`.

You own: `src/policy/rules.js` (talk table), `src/policy/config.js` (`teams.subsDirect`),
`src/teams/*.js` (new: channel resolution, fan-out, team log, read marks), `src/cli/tell.js`,
`src/cli/ask.js`, `src/cli/collect.js`, `src/cli/ls.js` (channel addresses and `--team` / `--teams`),
`src/cli/util.js`, `src/lifecycle/briefing.js` (one added line only), `src/ui/data.js` (new),
`docs/spec/policy.md` (replace the table with a pointer to teams.md), tests `test/teams.test.js`,
`test/ui-data.test.js`, plus updates to existing policy tests.

## Deliverables

1. Talk table per teams.md, `teamOf()`, `config.teams.subsDirect` (default true), tests for every row.
2. Channels: `#<main>` and `#all` addresses in `tell` / `ask` / `collect --team` / `ls --teams`,
   fan-out with per-member receipts, team log and read marks, `team` field on inbox mirrors,
   briefing line, `move` resets marks (coordinate with h2's `src/move/move.js` by exporting a
   `resetTeamMarks(brainId)` they can call; do not edit their file).
3. `src/ui/data.js`: `snapshot()` and `watch(onEvent)` exactly as specified; events carry full
   objects; malformed trailing lines tolerated; a 30 s re-snapshot; unit tests with temp dirs and
   a fixture set under `test/fixtures/ui-data/` that h1 and h2 can also use.
4. Real acceptance (scratch SBB_DIR + scratch tmux): two haiku brains under one main, `sbb tell #<main>`
   fans out with two receipts and one log line, `collect --team` from a member shows the whole
   thread, a same-team sub→sub `tell` is now allowed, cross-team still blocked; `snapshot()` on the
   real `~/.sbb` (read-only) prints a well-formed state; `watch()` emits a `receipt` event when you
   `sbb tell` from another pane.

## Acceptance

- `npm test` green three times. No dependency added.
- Report `docs/reports/m3-h3-<date>.md`, then `sbb reply` to the lead.

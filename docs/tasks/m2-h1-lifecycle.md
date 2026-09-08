# Task M2-h1: spawn, kill, switch, briefing, inbox ack

Branch `m2/h1-lifecycle`, worktree `~/developer/sbb-worktrees/h1` (create the branch from
`origin/main` there). Spec: `docs/spec/lifecycle.md`; also read `docs/spec/registry.md`,
`docs/spec/policy.md` (quota floor only), `src/registry/brains.js`, `src/registry/brain-id.js`,
`src/registry/resolve.js`, `src/cli/util.js`, `src/transports/cli-profiles.js`,
`src/transports/confirm.js`, `src/lib/tmux.js`, `src/lib/paths.js`.

You own: `src/lifecycle/*.js` (new: `spawn.js`, `kill.js`, `switch.js`, `briefing.js`,
`launch.js` for the per-CLI command lines and readiness), `src/cli/spawn.js`, `src/cli/kill.js`,
`src/cli/switch.js`, `src/transports/uds-inbox.js` and `src/transports/claude-uds.js` (inbox
ack only), `src/cli/reply.js` (only the ack wait; coordinate with h3 who owns the rest of
`src/cli/`: touch nothing else there), tests `test/lifecycle*.test.js`, `test/briefing.test.js`,
`test/inbox-ack.test.js`, fixtures under `test/fixtures/lifecycle/`.

## Deliverables

1. `launch.js`: `buildCommand({ cli, model, brief, extraArgs, account }) -> { env, argv, shellLine }`
   for the four CLIs per lifecycle.md; `awaitReady({ cli, paneId, account, name }, { timeoutMs })`
   with the readiness rules; both injectable (tmuxApi, fs, clock) and unit-tested with
   screen samples and fake registry files.
2. `spawn.js`: the steps in lifecycle.md, using `allocateId`, `saveBrain`, tmux helpers, the
   quota floor (`readQuota` from `src/quota/usage-guard.js`; `unknown` never blocks), and the
   parent notification through `src/cli/util.js` delivery helpers (import, do not edit).
3. `briefing.js`: `renderBrief()` per the spec, with a snapshot test that pins the wording.
4. `kill.js` + `switch.js` per the spec. Verify each CLI's exit command on scratch sessions
   you start yourself (`tmux -L sbb-h1 …`), write what you observed in the report.
5. Inbox ack per lifecycle.md; `sbb reply` reports `delivered via=uds-inbox` when acked.
6. Real acceptance on this machine (allowed: your own spawned scratch brains only): spawn a
   Claude brain on account `a` with `--model claude-haiku-4-5-20251001` into a scratch tmux
   session (`SBB_TMUX_ARGS="-L sbb-h1"` and a scratch `SBB_DIR`), confirm it appears in
   `sbb ls` with an id, `sbb tell` it and get `delivered`, `sbb kill --yes` it, confirm the
   record is retired. Do the same for `codex` on account `a`. agy / cursor: spawn only if the
   binaries work without consuming paid credits; otherwise unit tests only, say so.

## Acceptance

- `npm test` green (all suites, run 3 times). No new dependency. No file outside your list.
- Report `docs/reports/m2-h1-<date>.md` with the real spawn/kill transcript, then one line to
  the lead via `sbb reply <msgId8>` (or `sbb tell a/claude:eagerstudy-b1`).

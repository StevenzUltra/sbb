# SBB contributor rules (for every brain working in this repo)

## Scope discipline

- Work only inside the files your task brief in `docs/tasks/` assigns to you. If you need a change elsewhere, write the need into your report and message the lead; do not edit other modules.
- Interfaces are defined in `src/types.js` and `docs/spec/`. Implement them exactly. If the spec is wrong or missing something, say so in your report with evidence; do not silently change a signature.
- No new runtime dependencies in the kernel (`src/transports`, `src/registry`, `src/policy`, `src/lifecycle`, `src/move`, `src/teams`). Node 22.13+ built-ins only. Exceptions: `src/ui/server.js` may use `ws`; the web console under `web/` is its own package with the dependencies listed in `docs/spec/web-console.md`.

## Code style

- ESM, `.js` with JSDoc types. Small pure functions; I/O at the edges.
- Never swallow errors. A transport that cannot verify returns `unverified` or `blocked` with a `reason`; it never fakes `delivered`.
- No emoji anywhere. Plain ASCII in code and docs; Chinese prose is fine in reports.
- Tests use `node:test` and live in `test/`. Every task ships with tests that fail before your change and pass after it. Fixtures go in `test/fixtures/`.

## Git

- You work in the worktree and branch named in your brief. Commit early with WIP commits; never rebase or force-push.
- Do not merge, do not push to `main`, do not run `gh pr merge`. The lead reviews and merges.
- When done: push your branch, open a PR against `main` with `gh pr create`, list your test files in the body.

## Reporting back

1. Write `docs/reports/<task>-<YYYY-MM-DD>.md` in your worktree: what you built, how you verified it (real commands and outputs), open questions, anything you could not do.
2. Send the lead a one-line message with the report path and the PR URL. Use the cross-session channel you were given in the brief. Do not paste the whole report into the message.

## Ground truth

- The Claude Code, Codex, tmux and Usage Guard behaviours in `docs/spec/protocols.md` were measured on this machine on 2026-09-08. Trust them over general knowledge, and re-measure before claiming they changed.

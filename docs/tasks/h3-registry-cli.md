# Task h3: registry, roster union, address resolution, CLI commands, quota and catalog readers

Branch `h3/registry-cli`, worktree `~/developer/sbb-worktrees/h3`.
You own: `src/registry/*.js`, `src/quota/*.js`, `src/cli/*.js`, `src/lib/ids.js` (may extend),
`test/registry.test.js`, `test/resolve.test.js`, `test/quota.test.js`, `test/cli.test.js`,
`test/fixtures/registry/**`. Read first: `docs/spec/registry.md`, `docs/spec/cli.md`,
`docs/spec/receipts.md`, `docs/spec/protocols.md` sections 1, 2, 6, `src/types.js`,
`src/lib/paths.js`, `src/lib/tmux.js`, `bin/sbb.js`.

The transports are being built in parallel (h1, h2). Code against the `Transport` interface
and `src/transports/index.js` `send()`; in tests inject a fake transport. Do not edit
`src/transports/`.

## Deliverables

1. `src/registry/brains.js`: `listBrains()`, `getBrain(name)`, `saveBrain(brain)`,
   `removeBrain(name)`; atomic writes; name validation.
2. `src/registry/claude-sessions.js`: `listClaudeSessions(accounts) -> ClaudeSession[]`,
   dead pids filtered (`process.kill(pid, 0)`), key file path attached.
3. `src/registry/codex-threads.js`: `listCodexThreads(accounts) -> CodexThread[]` via
   `node:sqlite` `DatabaseSync` opened read-only (`{ readOnly: true }`); `hasRollout` from
   the rollout path existing.
4. `src/registry/roster.js`: `roster() -> RosterRow[]` union per registry.md (pane cli
   inference including the `node` process-tree check via `src/lib/exec.js`).
5. `src/registry/resolve.js`: `resolve(address) -> Target` per registry.md; throws a
   `ResolveError` with `reason` `target_not_found` / `target_ambiguous`.
6. `src/quota/usage-guard.js`: `readQuota({ refresh }) -> QuotaRow[]` from the Usage Guard
   SQLite (open read-only; inspect the schema first with `sqlite3` and document the tables
   you rely on in a comment). Missing DB -> rows with `remaining: null, note: 'unknown'`.
   `refresh` runs the app binary `--read-once --no-ui --no-redeem` when it exists.
7. `src/quota/catalog.js`: `catalog() -> { account, cli, models[] }[]` from binaries on PATH
   plus per-account Codex `config.toml` (`model`, `model_catalog_json`). Static model tables
   for claude / agy / cursor with a clear "maintained by hand" header.
8. `src/cli/{ls,adopt,tell,ask,reply,collect,watch,quota,catalog,doctor}.js` per cli.md,
   including the envelope builder (`src/registry/envelope.js`, sender identity from
   `$TMUX_PANE`), receipt log append, inbox read/write, exit codes.
9. Tests with fixture directories (fake `~/.claude/sessions`, fake `~/.ai-account-x`, fake
   `state_5.sqlite` built in the test, fake tmux `listPanes` output) using
   `SBB_HOME_OVERRIDE` and `SBB_DIR` to point at temp dirs.

## Acceptance

- `npm test` green. `sbb ls`, `sbb doctor`, `sbb quota`, `sbb catalog` run on this machine
  against real data without errors (read-only). Paste their real output in your report.
- `sbb tell --dry-run` resolves `b/claude:<a live name>` and a bare `%<pane>` correctly.
- No dependency added. `src/transports/` untouched.

## Notes

- You may read the real registries and databases read-only; never write into any
  `~/.claude*`, `~/.ai-account-*` or Usage Guard directory.
- Report to `docs/reports/h3-<date>.md`, then message the lead (see your dispatch message).

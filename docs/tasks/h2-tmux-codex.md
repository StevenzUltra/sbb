# Task h2: typed transport (tmux send-keys) and Codex queue transport

Branch `h2/tmux-codex`, worktree `~/developer/sbb-worktrees/h2`.
You own: `src/transports/tmux-keys.js`, `src/transports/cli-profiles.js`,
`src/transports/codex-queue.js`, `test/tmux-keys.test.js`, `test/codex-queue.test.js`,
`test/fixtures/fake-cli.js`. Read first: `docs/spec/protocols.md` sections 2, 3, 4,
`docs/spec/receipts.md`, `src/types.js`, `src/transports/index.js`, `src/lib/tmux.js`,
`src/lib/exec.js`.

## Deliverables

1. `src/transports/cli-profiles.js`: one object per `CliKind` with `idle(screen) -> boolean`,
   `busy(screen) -> boolean`, `prompting(screen) -> boolean`, `enters` (1 or 2),
   `submitted(screenBefore, screenAfter, text) -> 'delivered'|'queued'|'pending'`, using the
   fingerprints in protocols.md section 3. Pure functions over captured text; unit-tested
   with screen samples you paste from real panes (`tmux capture-pane -p -t %<id>`; the
   lead's dispatch message tells you which panes you may read).
2. `src/transports/tmux-keys.js` exporting `tmuxKeys` (shape `Transport`):
   - `supports(target)`: always true when `target.paneId` is set.
   - `send`: precondition checks (copy-mode, busy, prompting, foreground program) ->
     `blocked` with the reason vocabulary; then `sendLiteral`, `sendKey('Enter')` x
     `profile.enters`, wait 2 s, capture, decide; one extra `Enter` if the text is still on
     the input line, wait 2 s, decide again; never resend text; never send `Esc`.
   - Strip `\r\n` from text (replace with a space) and refuse texts longer than 4000 chars
     (`blocked` reason `too_long`; add the reason to receipts.md in your PR).
   - All tmux calls go through `src/lib/tmux.js`; make the module take an injectable
     `tmuxApi` so tests can run without a server.
3. `src/transports/codex-queue.js` exporting `codexQueue` (shape `Transport`):
   - `supports(target)`: `target.cli === 'codex' && target.codex?.id` and a `codex` binary
     on PATH.
   - `send`: run `codex queue --thread <id or name> --message <text>` with
     `CODEX_HOME=<account codexDir>` (from `src/lib/paths.js`), 25 s timeout, through
     `src/lib/exec.js` (injectable for tests). Map: exit 0 + `Queued message` ->
     verify on screen for `opts.verifyTimeoutMs` (a new `›` line with the text or a `•`
     answer) -> `delivered`, else `queued`; `no rollout found` -> `blocked` `no_rollout`;
     `No active session found` -> `blocked` `thread_not_found`; binary missing ->
     `transport_unavailable`.
4. `test/fixtures/fake-cli.js`: a small interactive script that prints a chosen CLI's idle
   prompt, echoes submitted lines into a transcript area, optionally swallows the first
   Enter, and shows a fake busy marker for N seconds. Used by an integration test that
   spins up a scratch tmux session (`tmux -L sbb-test new-session -d ...`) and runs the real
   `tmuxKeys.send` against it. Skip that test (not fail) when `tmux` is missing.
5. Tests: profile fingerprints (all four CLIs, idle/busy/prompting samples), preconditions,
   Enter-retry path, Cursor double Enter and `1 task` -> `queued`, codex-queue exit/stdout
   mapping with a fake exec.

## Acceptance

- `npm test` green, scratch tmux sessions cleaned up (`tmux -L sbb-test kill-server`).
- Running `node -e` against the fake CLI in tmux shows `delivered`, and with the
  swallow-first-Enter flag shows the retry then `delivered`.
- No dependency added. No file outside your list changed.

## Notes

- Real panes you may read (capture only, never send-keys to them): `%30` (Claude, the lead),
  `%21` and `%23` (Codex), `%29` (agy), `%20` (Cursor). Do not type into anything but your
  own scratch sessions.
- Report to `docs/reports/h2-<date>.md`, then message the lead (see your dispatch message).

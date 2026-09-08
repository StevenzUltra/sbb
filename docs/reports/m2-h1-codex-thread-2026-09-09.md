# m2/h1-codex-thread: record the codex thread a spawn created

Task: `sbb:b3927531` (h1). Branch `m2/h1-codex-thread`, base `main`.

## What changed

- `src/registry/codex-threads.js`
  - `listCodexThreads` now selects `created_at` / `created_at_ms` and exposes
    `createdAtMs` (`msOf(ms, seconds)` handles both column shapes).
  - new `newestRollout({ account, sinceMs, accounts, readdir, stat })`: walks
    `<codexDir>/sessions/**` for `rollout-<ts>-<uuid>.jsonl`, keeps files whose mtime is
    `>= sinceMs`, returns the newest. A missing `sessions` dir is not an error; any other
    readdir/stat failure throws `CodexRegistryError` (never swallowed).
  - new `findSpawnedThread({ account, cwd, sinceMs, accounts })`: first a `threads` row
    with the same account + cwd whose `createdAtMs >= sinceMs` (newest wins, source
    `threads.created_at`); otherwise the newest fresh rollout uuid, with `name` filled from
    the matching row when there is one (source `rollout`, plus `rolloutPath`). Nothing
    fresh returns `undefined` - no guessing.
- `src/lifecycle/spawn.js`: captures `startedAt` before the pane is created, and after
  readiness (codex only) resolves the thread into `brain.threadId` / `brain.threadName`.
  A failing lookup is reported as `result.threadError` and does not fail the spawn; the
  record then simply has no thread fields.
- `src/cli/spawn.js`: prints `thread    <id> [<name>] (<source>)`; a failed lookup prints
  `sbb: warning: codex thread lookup failed: ...` on stderr.
- `src/types.js`: `Brain.threadId` / `Brain.threadName`, `CodexThread.createdAtMs`.
- `docs/spec/lifecycle.md` step 6 (resolution rule), step 7 (record fields), step 8
  (printing); `docs/spec/registry.md` (roster prefers the two fields).
- `test/fixtures/registry/helpers.js`: `buildCodexDb` also fills `created_at`.

## Verification

- `test/codex-thread.test.js` (10 tests): newest-after-spawn wins over an older same-cwd
  thread; another account / cwd ignored; pre-spawn thread never attributed; rollout
  fallback fills the name from the row by id; a stale rollout is ignored; an unknown uuid
  is reported without a name; missing `sessions` dir is fine; `createdAtMs` mapping;
  `spawnBrain` writes `threadId`/`threadName`, writes no field when nothing is found,
  survives a throwing lookup with `threadError` set, and never looks up a thread for a
  claude spawn; CLI prints the thread line and the warning.
- `npm test`: 375 pass, 0 fail. `npm run check`: ok.
- Real spawn (scratch `SBB_DIR=/tmp/sbb-h1-acc-codex`, scratch server
  `tmux -L sbb-h1-codex`, account a, cwd `/Users/steven/developer/eagerstudy`):
  `sbb spawn --cli codex` printed
  `thread    01a08263-430b-7183-9333-813f5a8b781d (threads.created_at)`, and the record on
  disk carried `threadId: 01a08263-...`. The row it matched is the real new thread
  (`cwd /Users/steven/developer/eagerstudy`, `createdAtMs 1788893938443`,
  `rollout-2026-09-09T02-58-58-01a08263-....jsonl`). Scratch server and dirs removed.
- Real read of `~/.ai-account-{a,b,c}/codex`: 908 threads read; one real row has
  `name = NULL`, confirming the no-name path is not hypothetical.

## Spec note for h3 (roster/resolve)

`threads.name` is `NULL` for a freshly created thread - codex sets the title after the
first turn. In the real spawn above `threadId` was recorded but `threadName` was absent,
so roster/resolve should treat `threadName` as optional and fall back to `threadId`
(and, if a display name is wanted later, re-read `threads.name` by id rather than
expecting it in the record).

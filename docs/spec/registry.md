# Registry, roster and addresses

## Brain id (unique, never reused)

Every brain gets an immutable id at registration. People and brains hand work over by
id; names are only aliases and may be renamed.

- Format `<TAG>-<seq>`, e.g. `SMS-0012`. `TAG` is the machine tag from
  `~/.sbb/config.json` `machineTag` (set it to something like `MS` / `MBP`); default is the
  upper-case initials of the hostname words (`Stevens-Mac-Studio` -> `SMS`), max 4 letters.
  `seq` is a per-machine counter, zero-padded to 4 digits, never padded down.
- The counter lives in `~/.sbb/counter` and only ever increases. Update it atomically
  (write temp + rename, under an `O_EXCL` lock file `~/.sbb/counter.lock`, retry up to 2 s).
- Killed or forgotten brains are never deleted: their record moves to
  `~/.sbb/brains/_retired/<id>.json` with `retiredAt`. If the counter file is missing, the
  next id is `max(seq over brains/ and brains/_retired/ and the receipt log) + 1`, so an id
  can never be handed out twice on one machine even after a counter loss.
- Each record also carries `uuid` (UUID v7, `crypto.randomUUID()` is acceptable) as the
  global identity used in handover files and logs. Two records with the same id or uuid is a
  hard error: `sbb doctor` reports it and every command refuses to resolve either until fixed.
- Ids appear everywhere a brain is shown or addressed: `sbb ls` first column, envelopes,
  receipts (`from`/`to` fields carry `id` as well as name), handover files, inbox entries.

## Brain records

`~/.sbb/brains/<id>.json` (file name = id), schema `Brain` in `src/types.js`.
Written by `adopt` (M1) and `spawn` / `move` / `kill` (M2). Names are unique among live
brains, `[a-z0-9][a-z0-9-]{0,39}`; a retired brain's name may be reused, its id may not.
`paneId` is a hint; always re-resolve before sending. For codex brains, `threadId` /
`threadName` name the thread the spawn created (see lifecycle.md step 6); the roster prefers
them over matching a thread by cwd when they are present.

Write atomically (temp file + rename). Reads tolerate missing dir (= no brains).

## Roster (live sessions, whether or not they are brains)

`sbb ls` shows the union of three sources; a row exists for every live CLI session found,
brains are overlaid by matching pane id (or pid for Claude).

An account's config dirs are the ones that exist: `~/.claude`, `~/.codex`, `~/.gemini`,
`~/.cursor`, `~/.kimi-code`, `~/.grok` for `default`, and
`~/.ai-account-<name>/{claude,codex,gemini,cursor-agent,kimi,grok}` for a named account
(`src/lib/paths.js` `CLI_DIR_FIELD`; `sbb account add` creates all six).

1. tmux panes: `listPanes()` from `src/lib/tmux.js`. `cli` is inferred:
   - `pane_current_command` matches `^\d+\.\d+\.\d+$` (Claude prints its version) -> `claude`
   - `agy` -> `agy`
   - `node`: inspect the pane's process tree (`pgrep -P <pane_pid>` then `ps -o command=`):
     `codex` in the command -> `codex`; `cursor-agent` -> `cursor`; otherwise `other`
   - shells (`zsh`, `bash`, `fish`) -> not a session, omitted unless it is a registered brain
   - account: `accountFromPaneTag(@ai_account)`
2. Claude sessions: every account's `<claudeDir>/sessions/*.json` (see protocols.md).
   Match to a pane through the `tmux` field (`session:@windowId.%paneId`). Provides `name`,
   `status` (busy/idle), `cwd`, socket path, key file, pid. Skip entries whose pid is dead.
3. Codex threads: every account's `<codexDir>/state_5.sqlite` `threads` (read-only,
   `node:sqlite`). Match to a live Codex pane by the brain record's `threadId` when it has
   one; otherwise by `cwd` and most recent `updated_at`, which is a best guess and is marked
   `thread: uncertain` when two live Codex panes share a cwd. A record that names a thread is
   trusted as is, with no fallback to guessing when that thread is gone. Provides `name`
   (thread name usable by `codex queue`), `id`, `hasRollout`.

Output columns for `sbb ls`:

```
ID        BRAIN     ROLE  PARENT    ACCOUNT  CLI     MODEL             STATUS  WHERE   NAME/THREAD          CWD
SMS-0007  lead      main  -         a        claude  claude-fable-5-1  busy    24:3.3  eagerstudy-b1        ~/developer/eagerstudy
-         -         -     -         default  codex   -                 idle    24:2.1  紧急修复学生作业提交故障   ~/developer/eagerstudy
```

`PARENT` shows the parent's id. Rows without a brain print `-` in ID/BRAIN/ROLE/PARENT. A
codex brain whose record carries a `threadId` shows that thread's name, or
`thread:<id first 8>` when it has no name; it never shows a thread guessed from the cwd.
`--json` prints the raw union.
`--tree` prints brains only, indented by parent.

Status per CLI: Claude from the registry (`busy`/`idle`); Codex, agy, cursor from the screen
fingerprints in protocols.md; `?` when the screen is ambiguous. Never guess `idle`.

## Addresses

`sbb tell <address> ...` accepts, in order of preference:

0. a brain id: `#SMS-0012` (also accepted without `#`; case-insensitive; exact match only)
1. a brain name: `ios`
2. `<account>/<cli>:<session name>` e.g. `b/claude:eagerstudy-b1`, `default/codex:Reply with PONG`
   (quote names with spaces)
3. `<account>/<cli>:%<pane>` or `<account>/<cli>:<session:window.pane>` e.g. `default/agy:%29`,
   `a/cursor:24:1.7`
4. a bare pane id `%29` or coordinate `24:3.2` (account and cli inferred from the roster)

Resolution (`src/registry/resolve.js`, `resolve(address) -> Target`) happens at send time:
look up the brain record, re-resolve its pane, refresh the Claude session or Codex thread,
and fail with `blocked` reason `target_not_found` (or `target_ambiguous`) instead of
guessing. Account letters are case-insensitive.

## Sender identity

The envelope prefix is generated by SBB from the caller's own pane
(`$TMUX_PANE`): `[<name>#<id>@<account>/<cli>:<coord>][<role>]` for registered brains,
`[<cli>@<account>/<cli>:<coord>][<role>]` for unregistered sessions. Callers pass only the
body. When the caller is not inside tmux (a script), identity is `user@cli`.

# Transport protocols (measured on this machine, 2026-09-08)

Versions: Claude Code 2.1.263, Codex CLI 0.154.0-alpha.6, tmux 3.7c, macOS, one macOS
user, accounts = `~/.claude` (default) plus `~/.ai-account-<name>/{claude,codex,...}`.
Everything below was verified by running it, not read from documentation. Re-verify
before assuming a newer CLI behaves the same; the registry carries `peerProtocol` and
`peerFeatures` for feature detection.

## 1. Claude Code: Unix socket messaging (`uds`)

### Discovery

- Registry file per live session: `<claudeDir>/sessions/<pid>.json`. Fields seen:
  `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol (1),
  peerFeatures ["notify_idle","reply_across_default_dirs","artifact_yield"], kind
  ("interactive"), entrypoint, pidDomain, tmux ("24:@16.%30" = session:@windowId.%paneId),
  messagingSocketPath ("/tmp/cc-socks/<pid>.sock"), name ("eagerstudy-b1"), nameSource
  ("derived"|"user"), status ("busy"|"idle"), updatedAt, statusUpdatedAt`.
- Key file next to it: `<pid>.<64hex>.key`, mode 0600, JSON
  `{"peerToken":"<32 hex>","procStart":"...","pidDomain":"darwin"}`. Same macOS user can
  read every account's key files, which is what makes cross-account delivery possible.
- Socket dir is `/tmp/cc-socks/` (falls back to `/tmp/cc-socks-<uid>/`). Socket names are
  `<pid>.sock` or `<pid>-<8hex>.sock` (moved-aside sibling).
- `ListAgents` inside Claude only lists sessions of its own `CLAUDE_CONFIG_DIR`. SBB unions
  every account's `sessions/` directory.
- A session removes its registry file on clean exit. Stale files exist after crashes: treat a
  registry entry as live only if `kill -0 <pid>` succeeds and the socket connects.

### Wire format

Newline-delimited JSON over the Unix socket. The connection is closed if no complete line
arrives within 30 s. The server does not write anything back on the connection.

```
{"type":"auth","token":"<peerToken>"}
{"type":"user","message":{"role":"user","content":"<text>"},"msg_id":"<32 hex>","priority":"next"}
```

- `auth` is the first line. Whether it is required depends on the session (`authRequired`);
  always send it.
- `user`: `message.content` must be a non-empty string. Optional: `msg_id` (32 hex),
  `priority` `now|next|later` (default `next`), `session_id` (dropped on mismatch),
  `uuid`, `from` (a `uds:/tmp/cc-socks/<pid>.sock` address), `file_attachments`.
- The content may be wrapped as
  `<cross-session-message from="uds:..." from-session="..." hop-chain="..." from-name="..." from-mode="bypass|prompting">\n<body>\n</cross-session-message>`.
  The parser is strict (re-serialisation must match); do not hand-craft it in M1. Plain
  content is displayed as "Another Claude session sent a message".
- Verified: a plain `auth` + `user` pair injected from a shell into a busy session was
  delivered mid-turn (not held), and the socket returned zero bytes.

### Receipts

The receiving session sends control frames to the sender's `from` socket, not on the
connection:

```
{"type":"control","action":"peer_message_status","orig_msg_id":"<msg_id>","status":"delivered|held|denied|expired|refused|dropped","status_detail":"...","drop_reason":"queue-full|..."}
```

So a sender that wants receipts must (a) run its own listening socket inside the same
directory (`/tmp/cc-socks/<own pid>.sock`, name must match `^(\d+(-[0-9a-f]{8})?|[0-9a-f]{1,16})\.sock$`)
and (b) pass `from: "uds:/tmp/cc-socks/<own pid>.sock"` in the `user` frame. The receiver
verifies the connecting peer pid via the socket credentials and only replies to addresses
inside its socket namespace.

`held` = "Your message is held for the recipient user's approval before it reaches their
Claude session (permission-mode parity)". `denied` = user declined. `refused`/`dropped` =
rate limit, duplicate, relay loop or full queue; never retry these by typing.

Measured 2026-09-09: a `user` frame sent from a plain process (not a child of the
recipient) with `from` set to another account's socket was **held**: the recipient pane
showed a dialog `Deny — drop it and tell the sender it was declined / Deliver this message
to Claude` with Deny preselected. Selecting Deliver (Down, Enter) delivered the full body
and the session started working. A frame sent by a child process of the recipient's own
session (`selfSent`) was delivered without a dialog. Whether one approval persists for the
same sender in that session is not yet measured; treat every cross-account send as
possibly held and surface it as `blocked` reason `held` until a `delivered` receipt arrives.

### Idle notification

```
{"type":"control","action":"notify_when_idle","from":"uds:/tmp/cc-socks/<own pid>.sock","msg_id":"<msg_id>","from_mode":"bypass"}
```

The receiver later posts to `from`:

```
{"type":"control","action":"peer_idle_notice","orig_msg_id":"<msg_id>","state":"...","finished_at":<ms>,"detail":"...","from_mode":"..."}
```

Self-target frames are dropped. Only subscribe after the `user` frame for the same
`msg_id` was accepted.

### Status mapping

| observation                                  | Receipt                         |
| -------------------------------------------- | ------------------------------- |
| receipt `delivered`                          | `delivered` via `uds`           |
| no receipt within `verifyTimeoutMs`, socket accepted both lines | `queued` via `uds` (message is in the session queue) |
| receipt `held`                               | `blocked` reason `held` (final; do not fall back to typing) |
| receipt `denied` / `refused` / `dropped` / `expired` | `blocked` reason = status (final) |
| socket missing / connect refused / key unreadable | `blocked` reason `transport_unavailable` (router falls back to send-keys) |

## 2. Codex CLI: `codex queue`

```
CODEX_HOME=<account codexDir> codex queue --thread <uuid|exact name> --message "<text>"
```

- Lookup is scoped to `CODEX_HOME`. Calling with another account's home fails with
  `no rollout found for thread id ...` even for a live session. Always set the target's
  `CODEX_HOME`.
- A session is queueable only after its first completed turn (a
  `<codexDir>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` exists). Before that: same
  `no rollout found` error. Map to `blocked` reason `no_rollout` (router falls back to
  send-keys).
- Unknown thread: `Error: No active session found matching '<x>'` -> `blocked` reason
  `thread_not_found`.
- Success prints `Queued message <uuid> for thread <uuid>.` and exits 0. An idle session
  wakes immediately and processes the message. No delivery receipt exists.
- Thread names: `<codexDir>/state_5.sqlite`, table `threads`, column `name` (auto-generated
  from the first message, e.g. "Reply with PONG"); `id` is the uuid; `cwd`, `rollout_path`,
  `updated_at` are useful for the roster. Open read-only.
- `thread-writer-locks/<uuid>.lock` files persist after exit; they are not a liveness signal.
- Live Codex panes: `pane_current_command` is `node` and the process tree contains
  `node /opt/homebrew/bin/codex`. The TUI status line shows the model and `weekly N% left`.
- Verification: after exit 0, capture the pane for up to `verifyTimeoutMs`; a new `›` line
  containing the message text or a `•` response below it means `delivered`; otherwise
  `queued` (the queue command succeeded but the turn was not observed).

## 3. Typed input: `tmux send-keys` with screen verification

Used for Antigravity (`agy`), Cursor agent, and as the fallback for everything else.

Preconditions (any failure -> `blocked`, do not type):

- `pane_in_mode` must be `0` (reason `pane_in_copy_mode`).
- The bottom of the screen must show the CLI's idle prompt (reason `target_busy` if a
  turn is running, `target_prompting` if a permission dialog is open, `foreground_program`
  if a shell command / editor owns the keyboard).

Sending:

1. `tmux send-keys -t <pane> -l -- "<single line>"` (literal; never let `Enter`, `C-c`,
   `Space` be interpreted as key names).
2. `tmux send-keys -t <pane> Enter`. Cursor panes need a second `Enter`; others exactly one.
3. Wait 2 s, `capture-pane`, and decide:
   - text moved into the transcript and the input line is empty, or `Working` / a tool
     call appeared -> `delivered`.
   - text still sits on the input line -> send **one** more `Enter`, wait 2 s, re-capture.
     Still there -> `unverified` reason `enter_swallowed_twice`. Never resend the text.
   - Cursor: `1 task` badge visible -> `queued` (follow-up queue); it disappears when the
     current turn ends.
4. Never send `Esc` (it interrupts the target's turn). To clear a residue use `C-u`.
5. One line per message. Long content goes to a file; the message carries the path.

Per-CLI profiles (screen fingerprints):

| cli    | idle prompt / idle marker                        | busy marker                | enters |
| ------ | ------------------------------------------------ | -------------------------- | ------ |
| claude | line starting with `❯`; footer `⏵⏵ bypass permissions` or similar | `Working`, `⏺` tool lines | 1 |
| codex  | `› Ask Codex to do anything` placeholder; status line `weekly N% left` | `• Working`, spinner | 1 |
| agy    | `> Accept-edits mode` placeholder; status `accept-edits · Gemini ...` | `Working` | 1 |
| cursor | `→ Add a follow-up` placeholder; status `... · auto`; `Tip` line mentions Cursor | `1 task` badge = queued | 2 |

Measured: a freshly started Codex swallowed the first `Enter`; the text stayed on the `›`
line for 3 s and one extra `Enter` submitted it.

## 4. tmux facts

- All Ghostty tabs on this machine attach to the same server: `/private/tmp/tmux-501/default`.
- Account wrappers (`~/bin/ai-a` etc.) set pane options `@ai_account` (`A`/`B`/`C`),
  `@codex_home`, `@ai_pane_pid`. Empty `@ai_account` means the default account.
- Windows named `ai-a` / `ai-b` / `ai-c` rehydrate the account env in new shells (`.zshrc`).
- Pane ids (`%30`) survive window moves but die with the pane; coordinates (`24:3.3`) are
  stable while layout is unchanged. Resolve at send time, never cache.

## 5. Antigravity and Cursor

- `agy` (Antigravity CLI): no inject/queue entry point for a running interactive session
  (only `--conversation` resume and `--input-format stream-json` print mode). Typed input only.
- `cursor-agent`: only `--resume` / `--continue`. Typed input only, two `Enter`s.

## 6. Usage Guard (quota source)

- App: `tools/usage-guard` in the eagerstudy repo (Swift menu-bar app). Discovers the same
  account directories, reads official quota endpoints with each account's own OAuth
  credentials, stores history in
  `~/Library/Application Support/com.eagerstudy.usage-guard/usage.sqlite`.
- Read-only refresh: `"<app>/Contents/MacOS/EagerStudy Usage Guard" --read-once --no-ui --no-redeem`
  (installed at `/Users/steven/Applications/EagerStudy Usage Guard.app`). Output contains
  aliases, remaining percentages, credit counts or sanitised error codes; never tokens.
- SBB reads the SQLite read-only and never triggers redemption. Missing app or table ->
  quota `unknown`, never `0%`.

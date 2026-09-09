# Brain lifecycle: spawn, kill, switch, briefing, inbox ack (M2)

## sbb spawn

```
sbb spawn --name <name> --role main|sub [--parent <id|name>] --account <acct> --cli claude|codex|agy|cursor|kimi|grok
          [--model <id>] [--cwd <dir>] [--brief-file <path>] [--cli-args "<extra>"] [--split] [--json]
```

1. Validate: name free among live brains; parent exists when `role=sub`; account exists
   (`discoverAccounts()`), CLI binary on PATH; quota floor from `~/.sbb/config.json`
   (`quota.floorWeekly`, default 10) unless `--force` (see policy.md).
2. Allocate the id first (`allocateId()`), so the briefing can contain it.
3. Write the briefing to `~/.sbb/briefs/<id>.md` (0600). Never put it on a command line
   typed into a shell: a several-kilobyte line typed through `send-keys` into a login zsh
   (autosuggestions, highlighting, bracketed paste) takes longer than the readiness window
   and was observed stuck half-typed during the 2026-09-09 rehearsal.
4. Create the pane with the CLI as its command, so no interactive shell is involved and
   `pane_current_command` is the CLI itself:
   `tmux new-window -n ai-<acct> -c <cwd> -P -F '#{pane_id}' -- sh -c '<cmd>'` (or
   `split-window` with `--split`). Set pane options `@ai_account`, `@codex_home`,
   `@sbb_brain=<id>` right after. Do not rely on `~/bin/ai-*` or `.zshrc`.

   `<cmd>` = `exec env CLAUDE_CONFIG_DIR=<claudeDir> CODEX_HOME=<codexDir> CLAUDE_CODE_SESSION_NAME=<name> <cli line>`:

   | cli    | cli line                                                                          |
   | ------ | --------------------------------------------------------------------------------- |
   | claude | `claude [--model M] --append-system-prompt-file ~/.sbb/briefs/<id>.md [extra]`     |
   | codex  | `codex [-m M] [extra] "$(cat ~/.sbb/briefs/<id>.md)"` (PROMPT arg = first turn, which also makes the thread queueable). `M` is `--model` when given, else the account's top-level `model` from `<CODEX_HOME>/config.toml`: Codex merges a project `.codex/config.toml` over the account config, so passing the account model explicitly keeps a spawn off whatever the cwd asks for |
   | agy    | `agy [--model M] --prompt-interactive "$(cat ~/.sbb/briefs/<id>.md)" [extra]`       |
   | cursor | `cursor-agent [--model M] [extra] "$(cat ~/.sbb/briefs/<id>.md)"`                   |
   | kimi   | `kimi [--model M] [extra]` — no brief argument; `buildCommand` returns `briefArgv:false` (see "Brief delivery per CLI") |
   | grok   | `grok [--model M] [extra] "$(cat ~/.sbb/briefs/<id>.md)"`                          |

   Account config dirs beyond Claude and Codex come from `cliConfigDir` / `CLI_CONFIG_ENV`
   (`src/lib/paths.js`): kimi is launched with `KIMI_CODE_HOME=<dir>` and grok with
   `GROK_HOME=<dir>` (both measured on this machine 2026-09-10). No directory for the account
   means no assignment, never a guessed path.

   Quote every path for `sh`. When the CLI exits the pane closes (tmux default); `kill`
   therefore treats a vanished pane as already dead.
5. Wait for readiness (60 s, poll 1 s): Claude: a `sessions/<pid>.json` whose `tmux` names the
   new pane; Codex: prompt fingerprint idle after the brief turn (and the thread appears in
   `state_5.sqlite`); agy / cursor / kimi / grok: idle fingerprint. A CLI waiting on its own
   dialog (kimi's `Trust this folder?`) is reported at once as `prompting` instead of burning
   the timeout, so spawn says what to answer. Failure: kill the pane, do not register, exit 4
   with the last screen lines.
6. For codex, resolve the thread this spawn created: the newest `threads` row for the cwd
   with `created_at` at or after the spawn start, else the newest rollout file written since
   then (its name carries the thread uuid). Record it as `threadId`, plus `threadName` from
   `threads.name`. No match means no field; an older thread is never attributed.
7. `saveBrain({ id, uuid, name, role, parent, account, cli, model, cwd, paneId, coord, pid, threadId, threadName, origin:'spawned' })`.
8. A CLI with no brief channel (`buildCommand` returns `briefArgv:false`, today only kimi) gets
   the brief typed into the pane as its first message through the typed transport, after the
   record exists. The receipt is reported as `firstMessage`; `sbb spawn` prints a delivered one
   as `brief-msg` and warns on stderr for any other status. The spawn still succeeds: the brain
   is up, and the operator can re-deliver with `sbb tell`.
9. Print `spawned <id> <name> <coord>` (or JSON). Notify the parent brain (if any) with one
   line via the normal delivery path: `[<name>#<id> …][子脑] 已上线，上级 <parent>`. Like
   `sbb tell`, the send opens an inbox so the envelope carries `fromSock`.

## Brief delivery per CLI

Measured 2026-09-10 on scratch panes (fingerprints in docs/spec/protocols.md section 3):

| cli    | brief channel                                                                      |
| ------ | ---------------------------------------------------------------------------------- |
| claude | `--append-system-prompt-file <file>`                                                |
| codex  | positional `"$(cat <file>)"` as the first turn (which also makes the thread queueable) |
| agy    | `--prompt-interactive "$(cat <file>)"`                                              |
| cursor | positional `"$(cat <file>)"`                                                        |
| grok   | positional `"$(cat <file>)"`; needs no proxy                                        |
| kimi   | none on the command line: `--agent-file`, `KIMI_AGENTS_MD` and `--add-dir` are ignored by the TUI and there is no positional prompt; only a cwd `AGENTS.md` is honoured, which SBB must not write into the user's repo. `buildCommand` returns `briefArgv:false`, and `spawn` types the brief into the pane as the first message once the composer is ready (newlines collapse to spaces, protocols.md section 3). A delivery the transport cannot verify is reported as `firstMessage` with its reason, never assumed. |

## sbb kill

```
sbb kill <id|name> [--keep-children] [--yes] [--force]
```

- Default kills the whole subtree. Print the list first and ask `y/N` on a TTY unless `--yes`.
- Graceful first: send the CLI's own exit command with the typed transport rules (only when
  the pane is idle): claude `/exit`, codex `/quit`, agy `/quit`, cursor `/exit`, kimi `/exit`,
  grok `/exit`. All six measured on scratch panes; kimi 0.41.0 and grok 1.0.13 both exit on
  the first `Enter`. Verify the exact commands on scratch sessions before relying on them;
  note the result in the report.
  If the pane is still alive after 3 s, or `--force`, `tmux kill-pane`.
- Retire records (`removeBrain` moves them to `_retired/` with `retiredAt`), expire the
  holds that name a killed brain (policy.md "Moderated holds"; silent, nobody is
  notified), release claims
  (policy.md), notify the parent with one line through the same delivery path as `sbb tell`
  (an inbox is opened for the send, so the envelope carries `fromSock` and can be replied
  to). `--keep-children` re-parents children to the
  killed brain's parent (or makes them main) and notifies them.

## sbb switch

```
sbb switch <id|name|#id>
```

`tmux select-window` + `select-pane` on the brain's current pane. Only the caller's own
client is ever moved: the caller's tty (stdin/stdout, `$SSH_TTY`, or the `tty` command) is
matched against `tmux list-clients`, and only on a match is
`switch-client -c <tty> -t <session>` issued. Without a match nothing but the pane
selection happens and the CLI prints `attach: tmux switch-client -t <session>`. Prints
`switched <id> <name> <coord>`. Exit 4 when the pane is gone (and mark the record
`paneId: null` so `ls` shows `gone`).

## Briefing

Generated by `src/lifecycle/briefing.js` `renderBrief({ brain, parent, user })`, Chinese,
under 30 lines, no emoji. Must contain, in this order:

1. Identity: `你是 <name>#<id>，角色 <主脑|子脑>，上级 <parent name#id 或 用户>，账户 <acct>，CLI <cli>，模型 <model>`。
2. How to talk: `sbb reply <msgId8> <一行>` answers a message; `sbb ask <上级|同组名> <一行> --wait 10m`
   asks and waits; `sbb tell` for fire-and-forget; every message is one line; long content
   goes to a file, the message carries the path.
3. Rules: register what you touch with `sbb claim add branch:<b> | path:<p> | port:<n>`
   before editing; do not merge or push main unless told; write reports to files; do not
   type into other panes, use sbb.
4. Status: `sbb ls` for who is who; `sbb quota` before heavy work; `sbb help protocol` for
   the rest.
5. One line: "收到消息看不到发件人时，用 `sbb collect` 读收件箱。"

The same text is used by `adopt --brief` (delivered as a message instead of a system prompt).

## Inbox ack (uds-inbox)

When an SBB inbox (`src/transports/uds-inbox.js`) receives a `user` frame that carries
`reply_to` and a `from` naming another SBB inbox socket, it answers with
`{"type":"control","action":"peer_message_status","orig_msg_id":"<msg_id>","status":"delivered"}`
written to that `from` socket (auth line not required between SBB inboxes; send it anyway
with an empty token for symmetry: `{"type":"auth","token":""}`). `sbb reply` starts its own
inbox, sends with `from`, waits up to 2 s for that frame and reports `delivered via=uds-inbox`
instead of `queued`. Claude sessions never send this frame; do not wait for it from them.

## Launcher

Many people do not start a CLI by its bare name: a personal script turns a proxy on, sets
environment, adds a permission flag. `sbb spawn` reproduces that per CLI from
`~/.sbb/config.json` (policy.md): the pane line becomes

```
<spawn.preamble[cli]>
exec env CLAUDE_CONFIG_DIR=... <spawn.command[cli] or the CLI binary> <model> <brief> <cliArgs>
```

run by `spawn.shell` (default `sh`). The preamble is a plain statement, so a failing proxy
script prints its error and the CLI still starts; a replacement command must forward the
arguments SBB appends (`"$@"`). Example, a launcher that sources a proxy script and skips
permission prompts:

```
sbb policy spawn-shell /bin/zsh
sbb policy spawn-preamble claude "source /path/to/spxy.sh on"
sbb policy spawn-args claude "--dangerously-skip-permissions"
```

## Effort

`sbb spawn --effort <level>` (and `effort` in `POST /api/spawn`) sets the thinking effort where
the CLI has a switch: Claude Code `--effort <level>`, Codex `-c model_reasoning_effort=<level>`.
Levels, lowest to highest: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude Code takes
`low`..`max`; Codex takes `minimal`..`xhigh`. A level the CLI does not have is lowered to its
highest supported one (`max` on Codex runs as `xhigh`); a request below its range becomes its
lowest; other CLIs ignore it. The record keeps `effort` (requested) and `effortApplied`.

## Where a brain lives

`sbb spawn` creates the pane in SBB's own tmux session, `spawn.session` in the config
(default `sbb`), creating that session detached when it is missing (`has-session -t =name` so a
session that merely starts with the name does not count). A spawn from the desktop app or
from another terminal therefore never drops a window into the session the person is working
in. `--here` uses the caller's current session instead; `--split` splits the caller's window.
去终端 attaches to the brain's session.

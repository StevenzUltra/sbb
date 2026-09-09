# SBB - Switch Brain Brain

[中文说明](./README.zh.md)

**Several AI subscriptions, on separate accounts, working as one team, from one terminal.**

SBB turns the AI CLIs you already pay for (Claude Code, Codex, Antigravity, Cursor) into a
team of *brains*: you talk to a main brain, main brains run sub brains, and every brain is a
real CLI session on the account, CLI and model you picked for it. SBB launches them, lets them
message each other across accounts with a receipt for every message, and gives you one console
to see all of it: the org chart, the live terminal of every brain, group channels, quota per
account and tokens per second.

SBB never calls a model API and never touches credentials. It drives the official CLIs and
needs nothing but tmux.

![The SBB console: brain tree, a team channel with receipts, and the live pane of the selected brain](docs/readme/console.png)

## 20 seconds

![A real session: a question to the #lead channel, replies from two sub brains with receipts, the org chart, the receipt log](docs/readme/demo.gif)

Everything in the recording is real: a Claude Code main brain on account `a`, a Codex main
brain on the same account, two Codex sub brains on accounts `default` and `a`, all spawned by
`sbb`, all talking through it.

## Why

- **One team out of many subscriptions.** Two Claude accounts, a Codex account and a
  DeepSeek-backed Codex profile can work on one repository as one org chart. Each brain keeps
  its own account, its own quota and its own context.
- **"Did it actually get that?" is a receipt, not a hope.** Agents that type into each other's
  terminals forget to press Enter, or think they sent something that never arrived. SBB delivers
  through the CLI's own protocol when there is one (Claude Code's cross-session socket, `codex
  queue`) and through verified tmux keystrokes when there is not, and it reads the screen back
  to confirm. Every message ends in one of four states.
- **The console shows the truth.** The brain tree, a live terminal for every brain, group
  channels, held messages waiting for your approval, remaining quota per account and a
  tokens-per-second bar. When you want the raw CLI, one click puts you in its tmux pane.

## How it works

```
you  <->  main brain(s)  <->  sub brains
          (switchable)       (each: account + CLI + model, a real CLI session in a tmux pane)
```

- **tmux is the host.** Every brain lives in a tmux pane. Ghostty, iTerm2, Terminal.app,
  kitty or an SSH session: anything that runs tmux works. There is no daemon.
- **Isolated accounts are just directories.** An account is a config directory per CLI
  (`~/.ai-account-b/claude`, `~/.ai-account-b/codex`) plus a wrapper that exports it.
  `sbb account add b` creates one; log in to the CLI once inside it and it is a brain slot.
- **Three delivery channels, one router.** Claude Code: Unix socket peer messages. Codex:
  `codex queue` into the thread. Everything else, and every fallback: `tmux send-keys` with
  the screen read back to prove the line was submitted.
- **Four receipt states.** `delivered`, `queued` (the target is busy, the message is in its own
  queue), `unverified` (typed, not confirmed; one Enter retry, never a resend), `blocked` (not
  sent, with a reason). Every receipt is logged to `~/.sbb/log/receipts.jsonl`.
- **Unique brain ids, never reused.** `SSL-0054` stays `SSL-0054` after a restart, a move or a
  retirement, so a handover can name the right brain a week later.
- **Policy you control.** Main brains may talk to each other: on, off, or moderated (held until
  you approve). Sub brains talk to their own team. Quota floors keep any brain from burning a
  subscription to zero.
- **Quota and speed, read-only.** Remaining quota per account comes from
  [Usage Guard](https://github.com/StevenzUltra/eagerstudy) on macOS; tokens per second come
  from each CLI's own session log. Nothing is estimated.

## Install

Requirements: macOS or Linux, tmux 3.3 or newer, Node.js 22.13 or newer, and the CLIs you
already own (Claude Code, Codex; Antigravity and Cursor are typed-channel only).

```
npm install -g github:StevenzUltra/sbb    # npm package name: switch-brain-brain (the command is sbb)
sbb doctor
```

The web console is built once:

```
cd "$(npm root -g)/switch-brain-brain/web" && npm install && npm run build
```

## Quick start

```
sbb account add b                                    # second isolated account (then log in once inside it)
sbb spawn --name lead --role main --account a --cli claude --model claude-haiku-4-5-20251001
sbb ask lead "Read the repo, propose a two-brain plan with sbb plan propose"
sbb plan ls && sbb plan approve <plan id>             # the subs are spawned on approval
sbb ui                                               # the console, on 127.0.0.1 with a token
```

From here on you can `sbb tell`, `sbb ask` and `sbb reply` to any brain by name or id, post to
a team with `sbb tell #lead ...`, move a brain to another main with its context
(`sbb move review --to ops --handoff`), and retire a subtree with `sbb kill ops`.

## The console

| | |
| --- | --- |
| ![Org chart](docs/readme/org.png) | ![Receipt log](docs/readme/receipts.png) |
| The org chart: drag a brain onto another main to transfer it, whole subtree included. | Every receipt, filterable by brain, state and channel. |

![The console in dark mode](docs/readme/console-dark.png)

- **Live panes.** The selected brain's terminal streams through tmux control mode, never
  soft-wrapped. `在此输入` types into it; `去终端` switches your own tmux client (or opens
  Ghostty / iTerm2) to the pane.
- **Group channels.** `#lead` reaches every member of lead's team; `#all` reaches every main
  brain. A reply to a channel message shows in the channel.
- **Held messages.** With `moderated` peers, main-to-main messages wait in the top bar until
  you approve or deny them.
- **Quota and TPS.** Remaining weekly quota per account in the top bar; tokens per second per
  brain at the bottom.

## Delivery states

| state | meaning |
| --- | --- |
| `delivered` | The protocol said delivered, or the screen shows the line was submitted |
| `queued` | The target is busy; the message sits in its own queue and is delivered when it is idle |
| `unverified` | Typed, but the screen could not confirm submission. One Enter retry, never a resend |
| `blocked` | Not sent: copy mode, a permission prompt, held or denied, policy, unknown target. Reason attached |

## FAQ

**Why not turn a CLI subscription into an API key?** Because the terms of every subscription
forbid it and accounts get banned for it. SBB only ever drives the official CLI the way a person
would, on the account you are logged into, and reads what the CLI itself reports.

**What happens when a CLI ships a new version, a new slash command or new flags?** Nothing
special. SBB does not wrap the CLI's features; the brain uses them directly in its own session.
The delivery protocols SBB relies on (Claude Code's peer socket, `codex queue`) are measured
on a real machine and documented in `docs/spec/protocols.md`; the typed channel works with any
CLI.

**Do I need Ghostty?** No. Any terminal that runs tmux. `去终端` knows how to open Ghostty and
iTerm2 on macOS; everywhere else it switches the tmux client you are already using.

**Does it need to be the same machine user?** Yes for now. Isolated accounts are config
directories under one user, which is also what keeps the setup free of credential handling.

**Can two brains be on the same account?** Yes. Two Claude Code sessions on account `a` are two
brains with two contexts; they share the account's quota, which the quota floors take into
account.

## Status and roadmap

- M1 kernel: roster, `tell / ask / reply / collect / watch`, three transports, four-state
  receipts, quota and catalog readers. Done.
- M2 lifecycle: `spawn`, `kill`, `switch`, `move` with handoff, `policy`, `claim`, `plan`,
  `account add`. Done, rehearsed end to end with Claude Code and Codex brains (`docs/reports/`).
- M3 console: `sbb ui` server, Vue 3 web console, team channels, live panes, TPS. Done.
- M4: desktop shell (Electron), more terminal adapters, Linux verification, npm release.

Design notes and measured protocols live in `docs/spec/`; contributor rules in `AGENTS.md`.

## Contributing

```
git clone https://github.com/StevenzUltra/sbb && cd sbb
npm install && npm test          # 500+ node:test cases, most against a scratch tmux server
cd web && npm install && npm run dev   # the console in fixture mode, no brains needed
```

## License

MIT

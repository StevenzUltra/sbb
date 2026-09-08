# Policy, claims, plans, accounts (M2)

## Config file

`~/.sbb/config.json` (created on first write, atomic):

```json
{
  "machineTag": "MS",
  "peers": "on",
  "brains": { "SSL-0007": { "peers": "off", "autonomous": true } },
  "allow": [["SSL-0012", "SSL-0015"]],
  "quota": { "floorWeekly": 10, "mainReserve": 20 },
  "spawn": { "cliArgs": { "claude": "--permission-mode bypassPermissions" } }
}
```

- `peers`: `on` (default) | `off` | `moderated`.
- `brains.<id>.peers`: per-brain override (`off` = that main brain cannot send to or receive
  from other main brains). `brains.<id>.autonomous: true` = its subtree may spawn without a
  plan approval (policy.md "plans").
- `allow`: explicit pairs that may talk regardless of the table below.
- `quota.floorWeekly`: refuse `spawn` / `ask` / `tell` to an account whose weekly remaining is
  below this percent unless `--force` (`blocked` reason `quota`). `mainReserve`: `spawn` of a
  sub brain refuses to use an account that hosts a main brain when that account is below this
  percent (`blocked` reason `quota`, detail says which main brain).
- `spawn.cliArgs.<cli>`: default extra flags for `sbb spawn` of that CLI, written by
  `sbb policy spawn-args` and passed through as `--cli-args=<text>` (whitespace-split by
  `sbb spawn`; a plan node's own `cliArgs` is appended after them). Blank entries are dropped.

## Who may talk to whom

Evaluated in `src/policy/rules.js` `check(senderBrain|null, targetBrain|null, config) -> { ok, reason?, detail?, moderated? }`.
An unregistered sender (a human at a pane, a script) counts as the user and may talk to anyone.
An unregistered target is always allowed (SBB cannot know its team).

| pair                                    | verdict                                          |
| --------------------------------------- | ------------------------------------------------ |
| user <-> any                            | ok                                               |
| parent <-> direct child                 | ok (never off)                                   |
| main <-> main                           | `peers`: on = ok; off = blocked `policy` (`peers_off`); moderated = held for the user |
| sub <-> sub, different main             | blocked `policy` (`cross_team`) unless in `allow` |
| sub <-> sub, same main                  | blocked `policy` (`same_team_via_parent`) unless in `allow` or the main is marked `autonomous` |
| any -> brain with `peers: off` involved | blocked `policy` (`peers_off`) for main<->main only |

Blocked sends print `blocked  msg=… via=policy reason=policy detail=<why>; 请向上级或用户上报` and
exit 4. They are logged like any receipt.

## Moderated holds

When the verdict is `moderated`, the message is not sent: it is written to
`~/.sbb/held/<msgId>.json` (full OutboundMessage + target + sender) and the sender gets
`blocked reason=moderated detail=held for user approval: sbb approve <msgId8>`.
`sbb held` lists pending holds; `sbb approve <msgId8>` sends it through the normal path and
deletes the hold; `sbb approve --deny <msgId8>` deletes it and notifies the sender.

## sbb policy

```
sbb policy show
sbb policy peers on|off|moderated
sbb policy set <id|name> --peers on|off | --autonomous on|off
sbb policy allow <a> <b>   |   sbb policy deny <a> <b>
sbb policy quota --floor-weekly <n> | --main-reserve <n>
sbb policy spawn-args <cli> "<args>"     -> spawn.cliArgs[<cli>]; an empty string removes it
```

## Claims

`~/.sbb/claims/<id>.json` per brain: `{ id, claims: [{ resource, at, note }] }`.
Resources are typed strings: `branch:<name>`, `path:<absolute or repo-relative>`,
`port:<n>`, `device:<udid or name>`, `worktree:<path>`.

```
sbb claim add <resource> [--note <text>]
sbb claim release <resource> | --all
sbb claim ls [--all]
```

Conflict = another live brain holds the same `branch:`/`port:`/`device:`/`worktree:`, or a
`path:` that is a prefix of, equal to, or prefixed by ours. On `claim add` with a conflict:
still record the claim, print `conflict with <name>#<id> (<resource>)`, exit 3, and notify:
if both brains are mains (or one is the user), message both; otherwise message each side's
main brain. Killing or retiring a brain releases its claims. `sbb ls --claims` shows a
`!` marker on rows with an active conflict.

## Plans

A brain proposes staffing with a JSON file:

```json
{ "parent": "SSL-0007", "reason": "…", "brains": [
  { "name": "ios", "role": "sub", "account": "b", "cli": "claude", "model": "claude-sonnet-5", "cliArgs": "--permission-mode bypassPermissions", "reason": "…", "load": "medium" } ] }
```

```
sbb plan propose --file <plan.json>      -> stored ~/.sbb/plans/<planId>.json, status pending, prints plan id; notifies the user inbox
sbb plan ls | show <planId>
sbb plan approve <planId> [--edit <file>] -> spawns each brain in order (quota-checked), records results per node, notifies the proposer with a one-line summary and the report path ~/.sbb/plans/<planId>.result.json
sbb plan reject <planId> --reason <text>  -> status rejected, proposer notified
```

Proposer must be the `parent` or its ancestor; a parent marked `autonomous` may `approve`
its own plan (that is what "autonomous" means). `plan approve` shells out to `sbb spawn` for
each node so lifecycle code stays in one place. An optional per-node `cliArgs` string is
passed through as `sbb spawn --cli-args=<text>` (the `=` form: a space-separated value that
starts with `-` is ambiguous to `parseArgs`; whitespace-split and quotes honoured by
`sbb spawn`), so a plan can start its brains with flags such as
`--permission-mode bypassPermissions`.

## sbb account

```
sbb account ls
sbb account add <name>
```

`add` creates `~/.ai-account-<name>/{claude,codex}`, writes `~/bin/ai-<name>` (generated from
`src/account/wrapper-template.sh`, same behaviour as the existing `ai-c`: exports
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PATH`, sets the pane tags, subcommands `claude | codex | shell | env`),
`chmod 700`, and prints the next step: log in once with `ai-<name> claude` / `ai-<name> codex`.
It never touches `.zshrc`, keychain, or credentials. `ls` prints each account, whether Claude
and Codex credential files exist (existence only), and live brain counts.

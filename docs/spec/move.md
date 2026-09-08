# Transfer: sbb move (M2)

```
sbb move <id|name> --to <id|name|root> [--now | --after-idle [--wait <dur>]] [--handoff] [--yes] [--json]
```

Moves a brain (with its whole subtree) under a new parent without touching its process, so its
conversation context is preserved. Default timing is `--after-idle` (design decision 6);
`--now` re-parents immediately.

## Checks (all before any side effect)

- Target exists and is live; `root` means "becomes a main brain".
- No cycle: the new parent must not be the brain itself or any of its descendants
  (`blocked` reason `policy`, detail `would create a cycle`).
- Not already there (`nothing to do`, exit 0).

## Steps

1. Optional `--handoff`: `sbb ask <brain> "请把当前任务、进度、未决项和相关文件写成交接摘要到 <path>，写完回复 done" --wait 10m`
   with `<path> = ~/.sbb/handoff/<id>-<YYYYMMDD-HHMMSS>.md`. Continue even if it times out;
   record `handoff: null` in that case.
2. Timing:
   - `--now`: proceed.
   - `--after-idle`: write `pendingMove: { to, requestedAt, handoff }` into the record (so
     `sbb ls` shows `→ <target>` in the STATUS column), then wait until the brain is idle
     using `confirm.js`'s `readClaudeStatus` for Claude and the cli-profiles idle
     fingerprint for others, polling every 5 s up to `--wait` (default `30m`). Timeout:
     leave `pendingMove` in place, exit 5, print how to finish with `--now`.
3. Re-parent: update `parent` on the record (role becomes `sub`, or `main` when moving to
   root), clear `pendingMove`, atomic write. Children keep their `parent` (they move with it).
4. Notify, through the normal delivery path, in this order and with `--role 用户` when the
   caller is not a registered brain:
   - old parent (if any): `[…][用户] <name>#<id> 已划归 <new parent> 名下`
   - new parent (if not root): `[…][用户] <name>#<id> 已加入你的名下，原上级 <old>，交接摘要 <path 或 无>`
   - the brain itself: `[…][用户] 你的上级现在是 <new parent name#id 或 用户>，回执与上报改发给它`
   Each notification's receipt is printed; a `blocked` notification does not roll the move back.
5. Print `moved <id> <name> -> <new parent>` and exit 0.

## Multi-client note

`move` never touches tmux layout. If the user wants the pane next to its new team, `switch`
and manual `tmux move-pane` remain available; M3 may add a layout helper.

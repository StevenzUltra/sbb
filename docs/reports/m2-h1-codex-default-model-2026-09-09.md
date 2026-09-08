# m2/h1-codex-default-model: account codex model + receivable notify envelopes

Task: `sbb:b456de86` (h1). Branch `m2/h1-codex-default-model`, base `main` (`90a0960`).

## 1. Codex spawn without --model ran the project's model

Rehearsal failure: account c's codex brain in `eagerstudy` was refused by its endpoint
(`supported API model names are deepseek-..., but you passed gpt-6-astra`). Codex merges
the project's `.codex/config.toml` over the account config, so a spawn that passes no `-m`
runs whatever the cwd asks for. Account c's own config says
`model = "deepseek-v4-flash-vision-exp"`; `eagerstudy/.codex/config.toml` says
`model = "gpt-6-astra"`.

- `src/lifecycle/launch.js`: new `readCodexDefaultModel({ dir, readFile })` reads the
  top-level `model` from `<CODEX_HOME>/config.toml` through the existing
  `parseTomlTopLevel` (stops at the first section, so a `[projects."..."] model` is never
  picked up). Missing file = no default; a file that exists but cannot be read returns
  `detail` instead of guessing.
- `src/lifecycle/spawn.js`: a codex spawn with no `--model` uses that value and passes it
  as `-m <model>`; `--model` still wins and skips the lookup; claude/agy/cursor unchanged.
  The model that actually runs is written to `brain.model` (`modelSource` is `flag` or
  `codex-config`), and an unreadable config warns through `onWarn` without failing the spawn.
- `src/cli/spawn.js` prints `model     <id> (<source>)`.

## 2. Parent notifications went out without a fromSock

Measured live on a scratch spawn before the fix:
`notify delivered via=uds+screen content not wrapped: no receivable fromSock` - the
receivers showed a bare line instead of `Message from @<name>: ...`, and could not reply.
The dispatch named `kill`; the spawn path had the identical defect, so both are fixed the
same way as `sbb tell`: `openDeliveryInbox` before the send, `closeInboxes` in `finally`.

- `src/lifecycle/kill.js` `notifyParent` and `src/lifecycle/spawn.js` parent notification.
- An unresolvable parent is now reported as `target_not_found` (previously `notify_failed`),
  and no inbox is opened for it.

## Verification

- `test/codex-default-model.test.js` (8 tests): top-level model only; no file / no top-level
  model / blank model; unreadable config reports `detail`; codex spawn without `--model`
  builds `-m deepseek-chat` and records it; `--model` wins and skips the lookup; a claude
  spawn never reads the codex config; an unreadable config warns and spawns with no model;
  the CLI prints the model line.
- `test/lifecycle-kill.test.js` +2: the notification gets an inbox and closes it; an
  unresolvable parent opens no inbox and reports `target_not_found`.
  `test/lifecycle-spawn.test.js`: the parent notification gets an inbox (and the suite no
  longer opens a real inbox).
- `npm test`: 388 pass, 0 fail. `npm run check`: ok.
- Real spawn, account c, cwd `eagerstudy`, scratch `SBB_DIR` + `tmux -L sbb-h1-codex2`:
  `sbb spawn --cli codex` printed `model     deepseek-v4-flash-vision-exp (codex-config)`,
  the record carried that model, and the pane banner showed
  `latest · deepseek-v4-flash-vision-exp xhigh · Context 99% left` with no endpoint error.
- Real notifications, scratch `SBB_DIR` + `tmux -L sbb-h1-kill`: after the fix the parent
  pane showed `› Message from @kc2-SSL-0003: [kc2#SSL-0003@a/claude:acc:4.1][子脑] 已上线，
  上级 kp` for the spawn and `› Message from @kc-SSL-0002: [...][子脑] 已下线` for the kill.
  Scratch servers and dirs removed.

## Note for h3

The parent notification still reports `queued` when the parent is mid-turn (no
`peer_message_status`); the message is written and rendered on the parent screen. That is
the same receipt the peer inboxes give `sbb tell`, not a regression.

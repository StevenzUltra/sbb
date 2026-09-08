# CLI surface, M1

All commands accept `--json`. Parse with `util.parseArgs` (`allowPositionals: true`).
Each command is `src/cli/<name>.js` exporting `run(argv: string[]) -> Promise<number>`.

## sbb ls [--json] [--tree] [--account <name>] [--cli <kind>]

Roster union (docs/spec/registry.md). Human table sorted by account, then coord; the first
column is the brain id. `sbb ls #SMS-0012` (or a name) prints that one row in full.

## sbb adopt <pane|address> --name <name> [--role main|sub] [--parent <brain>] [--model <id>]

Registers a live session as a brain and allocates its unique id (docs/spec/registry.md
"Brain id"). Fails (exit 4) if the pane is not a known CLI session, if the name is taken by
a live brain, or if `--parent` is unknown. Prints `adopted <id> <name>` or the Brain JSON
with `--json`. `--parent` accepts an id or a name.

## sbb tell <address> <text...> [--priority now|next|later] [--role <text>] [--file <path>] [--timeout <ms>] [--dry-run]

Builds the envelope, resolves the target, routes through `src/transports/index.js`, logs
the receipt, prints it. `--dry-run` prints the resolved Target and the chosen transport
without sending. `--timeout` maps to `SendOptions.verifyTimeoutMs` (default 4000).

## sbb ask <address> <text...> [--wait <duration>] [--priority ...]

`tell`, then wait up to `--wait` (default `10m`, formats `30s`, `5m`, `1h`) for a reply
carrying `replyTo = msgId` (inbox), a frame from the target's own socket, a body carrying the
envelope's `sbb:<msgId8>` marker, or, for Claude targets, a `peer_idle_notice`. A delivery
merely mirrored into the caller's brain-id inbox with `from` = the target is only a fallback
candidate: a target mirrors its progress notes too, so ask keeps waiting and prints the newest
candidate as `via=mirror-fallback` only when nothing exact arrives before `--wait` expires.
Prints the receipt line, then the reply line(s) or `timeout`. Exit 0 on reply, idle or mirror
fallback, 5 on timeout.

## sbb reply <msgId8|msgId> <text...>

Looks the id up in the receipt log to find the original sender, sends the reply through the
normal router with `replyTo` set, and prints the receipt. If the original sender was the
user (not a brain), writes to `~/.sbb/inbox/user/` instead.

## sbb collect [--for <brain>] [--all] [--json]

Prints unread inbox entries for the caller (or `--for`) from both the name-keyed inbox and
the brain-id mirror, one line per `msgId`, and marks them read unless `--all`.

## sbb watch [--json]

Tails `~/.sbb/log/receipts.jsonl` and the inbox directory; prints one line per event.

## sbb quota [--json] [--refresh]

Per account and provider: window name, remaining percent, reset time, source timestamp.
`--refresh` runs Usage Guard `--read-once --no-ui --no-redeem` first when the app exists.
Missing data prints `unknown`.

## sbb catalog [--json]

Accounts x CLIs x models. CLIs detected by binaries on PATH (`claude`, `codex`, `agy`,
`cursor-agent`) and per-account config (Codex `config.toml` `model` / `model_catalog_json`).
Model lists come from `src/quota/catalog.js` static tables plus config overrides; no network.

## sbb doctor

Prints: tmux server socket, accounts discovered, live Claude sessions with socket
connectivity, Codex binary and version, Usage Guard app and DB presence. Exit 0 when tmux is
reachable.

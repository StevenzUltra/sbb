# sbb ui: local server for the console (M3)

`sbb ui [--port 4789] [--no-open]` starts a local HTTP server on `127.0.0.1` that serves the
built web console (`web/dist`) and exposes SBB's state and actions to it. Everything the
console can do is a thin call into the same modules the CLI uses; no logic lives in the server.

## Security

- Binds `127.0.0.1` only. A random 32-hex token is generated at start, written to
  `~/.sbb/ui-token` (0600) and appended to the URL the command prints/opens
  (`http://127.0.0.1:4789/?t=<token>`). Every request must carry it (`?t=` on the first page
  load, then the `X-SBB-Token` header or the `sbb_ui` cookie the page sets). Missing or wrong
  token: 401, no body.
- Actions run as the user. `approve` from the console counts as the user (the server is not a
  brain), so the approve authorization rule holds.

## HTTP API (JSON, all under `/api`)

| method | path | body | returns |
| --- | --- | --- | --- |
| GET | `/api/state` | | `{ brains, tree, accounts, quota, policy, held, plans, claims, tps, teams, version }` — one snapshot the page can render from cold |
| GET | `/api/events` | | SSE stream: `brain`, `receipt`, `message`, `held`, `plan`, `claim`, `quota`, `tps`, `policy` events, each carrying the full updated object; `heartbeat` every 15 s |
| GET | `/api/brains/:id/transcript?limit=200` | | recent turns mirrored from the brain's own session log (Claude JSONL, Codex rollout); read-only |
| GET | `/api/messages?with=<id>&limit=200` | | private thread between the user and a brain, from the receipt log + inbox mirrors |
| GET | `/api/teams/:id?limit=300` | | team channel log (teams.md) |
| POST | `/api/tell` | `{ to, text, role?, priority? }` | `Receipt` |
| POST | `/api/ask` | `{ to, text, wait? }` | `{ msgId }` immediately; the reply arrives as a `message` event with `replyTo` |
| POST | `/api/reply` | `{ msgId, text }` | `Receipt` |
| POST | `/api/approve` | `{ msgId, deny?, reason? }` | `Receipt` or `{ denied: true }` |
| POST | `/api/move` | `{ brain, to, mode: "now"\|"afterIdle", handoff?, wait? }` | `{ moved, plan }` (afterIdle returns `{ pending: true }` and later emits `brain`) |
| POST | `/api/spawn` | same fields as `sbb spawn` | spawn result JSON |
| POST | `/api/kill` | `{ brain, keepChildren? }` | kill result |
| POST | `/api/switch` | `{ brain }` | `{ switched, client }` — see "Go to terminal" |
| POST | `/api/policy` | `{ peers?, set?, allow?, deny?, quota?, spawnArgs? }` | new policy |
| POST | `/api/claims` | `{ add?, release? }` | claims |
| POST | `/api/plans/:id/approve` \| `/reject` | `{ edit?, reason? }` | plan result |

Errors: `{ error: { reason, detail } }` with 4xx; the `reason` vocabulary is receipts.md's.

## Live pane stream (WebSocket)

`GET /ws/pane/:paneId?t=<token>` upgrades to a WebSocket that streams the pane's output and
accepts input:

- Server side: ONE tmux control-mode client per `sbb ui` process (`tmux -C attach-session -t <session>`
  spawned with the server's own env; `SBB_TMUX_ARGS` respected). It parses `%output %<pane> <escaped bytes>`
  lines (unescape the octal `\ooo` form) and forwards raw bytes as binary frames to every socket
  subscribed to that pane; `%exit`, `%session-changed`, `%window-close` and pane death become a
  JSON control frame `{ "type": "closed" }`. Subscribing = `refresh-client -A %<pane>:on` through the
  control client; unsubscribe on the last socket closing.
- On open the server sends the current screen once (`capture-pane -p -e -S -<rows>`) so the terminal
  is not blank before the next output.
- Client → server text frames are JSON: `{ "type": "input", "data": "<keys>" }` → `send-keys -l` for
  printable text; `{ "type": "key", "name": "Enter"|"Escape"|"C-c"|... }` → `send-keys <name>`;
  `{ "type": "resize", "cols", "rows" }` → `resize-pane -t %<pane> -x cols -y rows` only when the pane
  has no other attached client (never resize a pane the user is looking at in a terminal).
- Input frames are refused (`{ "type": "refused", "reason": "input_off" }`) unless the socket first sent
  `{ "type": "mode", "input": true }`; the console sends that when the user clicks 在此输入.

## Go to terminal

`POST /api/switch { brain }`: find the human's tmux client (`list-clients`; ignore the control client and
any client whose tty belongs to an `sbb` process); if exactly one, `switch-client -c <tty> -t <session>` +
`select-window`/`select-pane`; if several, return `{ clients: [...] }` for the page to pick; if none and
macOS, open one: Ghostty (`osascript` `new window` + `input text "tmux attach -t <session>"`, then
`send key "enter"`) or iTerm2 (`tell application "iTerm2" to create window with default profile` +
`write text`), whichever is installed and preferred in `~/.sbb/config.json` `terminal: "ghostty"|"iterm2"`.
Never touch a client this rule does not pick.

## TPS (tokens per second)

`src/metrics/tps.js` keeps a rolling 60 s window per brain:

- Claude: tail `<claudeDir>/projects/<encoded cwd>/<sessionId>.jsonl`; each assistant record with
  `message.usage.output_tokens` and its `timestamp` contributes `output_tokens` at that time; the
  turn's duration is the gap to the preceding user record (fallback: 1 s). TPS = tokens in window /
  active seconds in window.
- Codex: parse the pane for `Responses API inference: <n>s` and the rollout JSONL `token_count`
  events when present (`<codexDir>/sessions/**/rollout-<id>.jsonl`); TPS = output tokens / inference
  seconds over the window.
- agy / cursor: `null` (shown as a dash), never guessed.
- Emitted as `tps` events every 5 s: `{ brainId, tps, tokens60s, source }` plus `total`.

## Host interface

Extract the tmux calls the server and lifecycle use into `src/host/tmux.js` implementing:
`listPanes, capturePane, sendLiteral, sendKey, newWindow, splitWindow, killPane, selectPane,
switchClient, listClients, serverSocketPath, controlClient()`; `src/host/index.js` exports the active
host (tmux only for now). No other module talks to tmux directly after this; the desktop shell can add a
second host later without touching messaging.

## Packaging

- `src/ui/server.js` (the server), `src/ui/data.js` (state snapshot + fs watchers, owned by h3),
  `src/metrics/tps.js`, `src/host/*`.
- Runtime dependency allowed for the server only: `ws`. The kernel (`src/transports`, `src/registry`,
  `src/policy`, `src/lifecycle`, `src/move`) stays dependency-free. The web app lives in `web/` as its
  own package (web-console.md) and is built into `web/dist`, committed as a build artifact only on
  release tags; `sbb ui` serves `web/dist` when present, otherwise prints how to build it.

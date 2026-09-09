# Task M3-h1: `sbb ui` server, pane stream, TPS, host interface

Branch `m3/h1-ui-server`, worktree `~/developer/sbb-worktrees/h1` (branch from `origin/main`).
Spec: `docs/spec/ui-server.md`; read `docs/spec/teams.md` ("Data service") for what h3 provides,
`docs/spec/web-console.md` for what the page expects, `src/lib/tmux.js`, `src/lifecycle/*`,
`src/cli/util.js`.

You own: `src/host/*.js` (new), `src/ui/server.js`, `src/ui/pane-stream.js`, `src/ui/switch.js`,
`src/metrics/tps.js`, `src/cli/ui.js`, tests `test/ui-*.test.js`, `test/tps.test.js`,
`test/host.test.js`, fixtures `test/fixtures/ui/`. You may add the `ws` dependency to
`package.json` (server only). You may edit `src/lifecycle/*` and `src/transports/tmux-keys.js`,
`src/transports/confirm.js`, `src/move/move.js` ONLY to route their tmux calls through
`src/host/index.js` (mechanical; behaviour unchanged; existing tests must stay green).

## Deliverables

1. `src/host/tmux.js` + `src/host/index.js` per the spec; move the existing wrapper functions there
   and re-export from `src/lib/tmux.js` for compatibility.
2. `src/ui/server.js`: HTTP on 127.0.0.1, token auth, static `web/dist`, the `/api` routes in the spec
   implemented by importing the CLI modules' functions (never re-implement policy or delivery);
   `/api/state` and `/api/events` come from `src/ui/data.js` (h3; until it lands, code against the
   documented `snapshot()` / `watch()` signatures with a stub you keep out of the PR or behind a
   fixture).
3. `src/ui/pane-stream.js`: control-mode client, `%output` parsing with octal unescape, subscribe
   per pane, initial `capture-pane`, input/key/resize frames, refusal until `mode input:true`.
4. `src/ui/switch.js`: the "go to terminal" rules including the macOS terminal opener.
5. `src/metrics/tps.js` per the spec with fixtures cut from real Claude JSONL and Codex rollout files
   from your own scratch sessions (strip anything private).
6. `sbb ui` command: `--port`, `--no-open`, prints the tokenised URL, opens it with `open` on macOS.
7. Real acceptance (scratch tmux server + scratch SBB_DIR): start `sbb ui`, `curl /api/state`, open a
   WebSocket to a scratch Claude pane with a tiny node client, see the initial screen and live
   output, send `mode input` then a typed line and Enter and watch it execute; TPS non-null for that
   pane after one answer; `/api/switch` with no human client returns a clear result without touching
   any client (do not open terminals on the user's screen during tests — stub the opener).

## Acceptance

- `npm test` green three times (existing 408 plus yours). No dependency other than `ws`.
- Report `docs/reports/m3-h1-<date>.md`, then `sbb reply` to the lead.

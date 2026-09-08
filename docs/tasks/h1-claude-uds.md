# Task h1: Claude Unix-socket transport and receipt inbox

Branch `h1/claude-uds`, worktree `~/developer/sbb-worktrees/h1`.
You own: `src/transports/claude-uds.js`, `src/transports/uds-inbox.js`, `test/claude-uds.test.js`,
`test/fixtures/fake-claude-server.js`. Read first: `docs/spec/protocols.md` section 1,
`docs/spec/receipts.md`, `src/types.js`, `src/transports/index.js`, `src/lib/paths.js`.

## Deliverables

1. `src/transports/claude-uds.js` exporting `claudeUds` (shape `Transport`):
   - `supports(target)`: `target.cli === 'claude' && target.claude?.sock` exists on disk.
   - `send(target, message, opts)`:
     - read the peer token from `target.claude.keyFile` (JSON `peerToken`); unreadable ->
       `blocked` reason `transport_unavailable`.
     - connect to `target.claude.sock` with a 3 s connect timeout; failure -> `blocked`
       reason `socket_connect_failed`.
     - write the `auth` line, then the `user` line with `msg_id`, `priority`, `content =
       message.text`, and `from = message.fromSock` when present. End the connection after
       writing (the server never answers on it).
     - if `message.fromSock` is set, wait up to `opts.verifyTimeoutMs` (default 4000) for a
       `peer_message_status` for this `msg_id` from the inbox (see 2) and map it per the
       status table in protocols.md. No receipt in time -> `queued`. Without `fromSock` ->
       `queued` immediately after a successful write (be honest: nothing confirmed it).
     - after a `delivered` or `queued` result, and only if `opts.notifyIdle` is true, send
       the `notify_when_idle` control frame on a fresh connection (auth line first).
2. `src/transports/uds-inbox.js`: `startInbox({ dir }) -> Promise<{ sockPath, on(event, fn), close() }>`.
   - Listens on `<dir>/<process.pid>.sock` (dir = `claudeSocksDir()` candidates from
     `src/lib/paths.js`; create the dir 0700 if missing; remove a stale file first).
   - Parses NDJSON lines; emits `receipt` (`peer_message_status` frames), `idle`
     (`peer_idle_notice`), and `message` (`user` frames, i.e. replies from Claude sessions
     that used SendMessage back to us). Ignores frames without a `type`.
   - Unlinks the socket on `close()` and on process exit.
3. `test/fixtures/fake-claude-server.js`: a `node:net` server that speaks the protocol
   (accepts auth, records frames, can be told to post `peer_message_status` /
   `peer_idle_notice` back to the `from` address). Use it in tests; do not talk to real
   Claude sessions from tests.
4. `test/claude-uds.test.js` covering: auth+user frame bytes exactly, `from` present/absent,
   delivered / held / denied / refused / dropped mapping, receipt timeout -> `queued`,
   connect failure, unreadable key, `notify_when_idle` frame, inbox parsing of partial
   lines and multiple frames per chunk.

## Acceptance

- `npm test` green; new tests fail if `send` is stubbed back out.
- `node -e` smoke against the fake server prints a `delivered` receipt in under 100 ms.
- No dependency added. No file outside your list changed.

## Notes

- Do not implement the `<cross-session-message>` wrapper; plain content only.
- Socket names must match `^(\d+(-[0-9a-f]{8})?|[0-9a-f]{1,16})\.sock$` or receivers ignore `from`.
- Report to `docs/reports/h1-<date>.md`, then message the lead (see your dispatch message).

# Team channels and the revised talk table (M3)

## Talk table (replaces the table in policy.md)

| pair                                | default   | notes |
| ----------------------------------- | --------- | ----- |
| user ↔ any                          | always    | |
| parent ↔ direct child               | always    | never off |
| main ↔ main                         | `peers`: on / off / moderated | unchanged |
| sub ↔ sub, same team                | **on**    | they work on the same thing; `config.teams.subsDirect = false` restores the old via-parent rule |
| sub ↔ sub, different team           | off       | unless in `allow` |
| sub ↔ another team's main           | off       | escalate through own main |

"Team" = a main brain plus everything below it (all descendants). `rules.js` gets `teamOf(brainId)`.

## Channels

Every main brain owns a channel named `#<main name>` (id `team:<mainId>`); members = the main and its
whole subtree, plus the user. `#all` is the channel of all main brains (user only may post).

- `sbb tell #lead "<text>"`: policy-check the sender against the channel (member or user), then deliver
  to every member except the sender through the normal path (one receipt each, printed as a block),
  and append one line to `~/.sbb/teams/<mainId>.jsonl`:
  `{ t, msgId, from, fromId, text, receipts: [{ to, toId, status, via }] }`.
  Members' inbox mirrors carry `team: "<mainId>"`. `#all` fans out to every main.
- `sbb ask #lead "<text>" --wait 10m`: fan-out, then wait for the first reply from any member; print
  every reply that arrives before the deadline, exit 0 if at least one.
- `sbb collect --team [#name]`: prints the team log since the caller's last read mark
  (`~/.sbb/teams/<mainId>.read/<callerId>`), so any member can catch up on the whole thread even
  if it only received some messages directly (Codex and agy cannot subscribe; the log is their memory).
- `sbb ls --teams`: channels with member counts and unread counts per caller.
- Envelopes for channel messages: `[<name>#<id>@…][主脑 → #lead] <text>`; briefing gets one line:
  "`sbb collect --team` 读你所在组的完整对话".
- Moving a brain (`move`) changes its team; its unread marks reset for the new team.
- UI: `GET /api/teams/:id` returns the log; SSE `message` events carry `team`.

## Data service for the console (`src/ui/data.js`)

`snapshot()` builds the `/api/state` object from the registry, receipts log, inbox mirrors, held,
plans, claims, quota, policy, teams. `watch(onEvent)` uses `fs.watch` on `~/.sbb/brains`,
`~/.sbb/log/receipts.jsonl`, `~/.sbb/inbox/**`, `~/.sbb/held`, `~/.sbb/plans`, `~/.sbb/claims`,
`~/.sbb/teams`, `~/.sbb/config.json`, debounced 150 ms, emitting the typed events in ui-server.md
with the full updated object; a 30 s full re-snapshot guards against missed fs events. Never blocks
the CLI: readers are read-only and tolerate partial writes (skip a malformed trailing line).

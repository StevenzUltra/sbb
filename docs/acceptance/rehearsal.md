# Acceptance rehearsal (lead plays the user)

Run by the lead after M2 lands, before asking the user to accept. Every step goes through
`sbb` from a normal pane, exactly as the user would. Cheap models only: Claude
`claude-haiku-4-5-20251001`, Codex on account `c` (DeepSeek). No agy / cursor (paid credits).
Record every receipt line in `docs/reports/rehearsal-<date>.md`; a step that needs a manual
keystroke, an approval dialog, or a resend is a failure.

| #  | as the user                                                                   | expect                                                        |
| -- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1  | `sbb doctor`, `sbb account ls`, `sbb quota`                                    | all exit 0; quotas shown for a, b, c, default                 |
| 2  | `sbb spawn --name lead --role main --account a --cli claude --model claude-haiku-4-5-20251001` | `spawned <id> lead <coord>`; `sbb ls` shows it busy/idle with id |
| 3  | `sbb spawn --name ops --role main --account b --cli claude --model claude-haiku-4-5-20251001` | second main brain                                            |
| 4  | `sbb switch lead`                                                              | pane focused; type one line by hand, get an answer            |
| 5  | `sbb ask lead "目标：给 SBB 写一个 README 的中文版。请读 sbb quota 与 sbb catalog，用 sbb plan propose 提一个两人的组建方案，回我方案 id" --wait 10m` | reply carries a plan id                              |
| 6  | `sbb plan show <id>`, `sbb plan approve <id>`                                  | two sub brains spawned under lead (one claude/b, one codex/c); lead notified |
| 7  | `sbb ls --tree`                                                                | lead -> two subs with ids; ops alone                         |
| 8  | `sbb ask lead "把 README 翻译派给 ios，校对派给 review，都用 sbb ask，完成后回我一行" --wait 15m` | lead reports done; `sbb watch` shows lead<->sub traffic with delivered receipts |
| 9  | `sbb claim ls --all`                                                           | subs registered `path:` claims; a conflict is shown only if both touched the same file |
| 10 | `sbb move review --to ops --now`                                               | three notifications delivered; `sbb ls --tree` shows review under ops |
| 11 | `sbb policy peers moderated`; `sbb ask lead "问 ops 一句：review 现在归你了吗" --wait 5m` | lead's message to ops is held; `sbb held` lists it       |
| 12 | `sbb approve <msgId8>`                                                         | ops receives it and answers lead; `sbb policy peers on` afterwards |
| 13 | `sbb tell ios "请写交接摘要到 ~/.sbb/handoff/ 后回我" `, then `sbb move ios --to ops --after-idle --handoff` | pending marker, then moved with handoff path in the notification |
| 14 | `sbb kill ops --yes`                                                           | ops, review, ios retired; records in `_retired/`; claims released; lead notified |
| 15 | `sbb kill lead --yes`                                                          | tree empty; `sbb ls` shows only unregistered sessions         |
| 16 | `sbb watch` transcript, `~/.sbb/log/receipts.jsonl`                           | no `unverified`, no `held` from Claude, no manual Enter anywhere |

Pass = all 16 rows as expected, twice in a row. Then ask the user to accept.

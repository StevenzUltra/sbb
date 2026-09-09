# Task M4-h1: Kimi and Grok as brains

Branch `m4/h1-more-clis` from `origin/main`. You own `src/transports/cli-profiles.js`,
`src/lifecycle/launch.js` (CLI_BINARIES and the per-CLI argv), `src/registry/brains.js`
(BRAIN_CLIS), `src/lib/paths.js` (CLI detection), `docs/spec/protocols.md` (measurements),
`docs/spec/lifecycle.md` (the per-CLI table), and their tests.

The user wants every AI CLI on the machine to be a brain: today `sbb catalog` and 新建 only
know claude / codex / agy / cursor. On this machine there are also `kimi`
(`/Users/steven/.kimi-code/bin/kimi`) and `grok` (`/Users/steven/.local/bin/grok`).

Measure, on a scratch tmux server (`SBB_TMUX_ARGS='-L sbb-h1-clis'`), never the user's:

1. How each starts with a first prompt / system brief (flags, env), how long until ready, and
   the screen fingerprint of idle vs busy (add to `cli-profiles.js` like the others).
2. The exit command (`/exit`, `/quit`, Ctrl-D?) and whether a second Enter is needed.
3. Message injection: typed channel only (send-keys + read-back), unless the CLI has a queue
   or socket. Known from earlier notes: Kimi queues input while busy and needs `C-s` to start
   consuming after it goes idle; Grok needs an extra Enter. Encode those in the profile.
4. Config directory per isolated account (`KIMI_HOME`? `GROK_HOME` is exported by the user's
   `~/bin/ai-a` wrapper), so h3 can add them to the account model. Report what each honours.

Deliver: `kimi` and `grok` in BRAIN_CLIS with profiles and launch argv, `sbb catalog` rows
for them (static model table is fine, sourced from the CLI's own help), `sbb spawn --cli kimi`
and `--cli grok` producing a ready brain on the scratch server, `tell` delivered and confirmed
on screen, `kill` clean. Tests with recorded screens in `test/fixtures/`. Report + `sbb reply`.

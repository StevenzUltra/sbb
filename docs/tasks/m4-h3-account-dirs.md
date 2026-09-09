# Task M4-h3: one isolated directory per account per CLI

Branch `m4/h3-account-dirs` from `origin/main`. You own `src/types.js` (Account),
`src/lib/paths.js` (discovery), `src/account/*` (`account add`, `account ls`),
`src/quota/catalog.js`, `docs/spec/registry.md` (accounts), and their tests.

Today an Account has only `claudeDir` and `codexDir`, so `sbb catalog` lists agy and cursor
only under `default` (global `~/.gemini`, `~/.cursor`) and 新建 cannot pick them on `a`/`b`/`c`.
The user's own wrappers (`~/bin/ai-a` etc.) already export per-account
`GROK_HOME`, `CURSOR_USER_DATA_DIR`, `CURSOR_CONFIG_DIR` next to `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`; SBB should follow the same layout under `~/.ai-account-<name>/`.

1. Account gains `agyDir`, `cursorDir`, `kimiDir`, `grokDir` (names final after h1 reports
   which env each CLI honours; use `<base>/gemini`, `<base>/cursor-agent`, `<base>/kimi`,
   `<base>/grok`). Discovery reads what exists; `account add` creates all of them and the
   wrapper exports every variable.
2. `catalog()` lists a CLI under an account when that account has the CLI's directory (or the
   CLI is global-only), and `account ls` shows one column per CLI with yes/no; a keychain
   login (no credentials file) counts as yes when a session/config exists.
3. `launch.js` gets the env for the new dirs (coordinate with h1: they add the argv, you add
   the env map; keep the change in `buildCommand`'s env block only).

Acceptance: `sbb account add zz` (scratch HOME) creates every dir and the wrapper; `sbb catalog`
on this machine shows agy/cursor under `a` once the dirs exist; tests green; report + `sbb reply`.

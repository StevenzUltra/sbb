# Task M4-h2: 新建 dialog, second pass

Branch `m4/h2-spawn-dialog` from `origin/main` (57fd2ba or later). You own `web/` only.
The user's screenshot of the desktop app showed these defects; fix all of them.

1. **Accounts show the wrong quota** (`default 0`, `a 0`). Show the quota of the pair that will
   actually be used: `${account}/${form.cli}` from `store.quota`; when that pair has no number,
   the first numeric chip of the account; `按量` only when the account has no numeric quota at
   all. Never `0` from a different CLI's chip.
2. **CLI list**: use every CLI in `store.accounts[i].clis` (the server now merges the catalog:
   on `default` that is claude, codex, agy, cursor). The model list follows the account + CLI
   pair (`store.catalog` rows carry `account` and `cli`). If a CLI has no models for that
   account, keep the CLI selectable with an empty model (the CLI's own default).
3. **Working directory**: a combo, not a bare text field. Quick picks from
   `store.recentCwds` (server, newest first) plus the parent's cwd first when a parent is set;
   a `选择文件夹…` button that calls `window.sbbDesktop.pickFolder({ defaultPath })` when the
   bridge exists (desktop app) and is hidden in a browser; the field stays editable by hand.
4. **The dialog itself**: opaque glass, never see-through (the empty-state card and the page
   must not show through it: solid `rgba(16,20,18,0.96)` dark / `rgba(255,255,255,0.96)` light
   with blur on the backdrop, a scrim over the page); draggable by its title bar (pointer
   events, clamped to the viewport, position remembered per session); `Esc` closes; the focus
   starts in 名字.
5. Fixture: extend `web/fixtures/state.json` with `recentCwds` and `clis` including agy/cursor
   on `default`; a scene with an account that has no numeric quota.

Acceptance: fixture and real mode screenshots (light/dark, desktop) in
`docs/reports/m4-h2-spawn-dialog/`, `npm test` green, report + `sbb reply` to the lead.

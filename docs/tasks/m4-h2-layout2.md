# Task M4-h2: console layout v2 (slim top bar, status bar, settings page)

Branch `m4/h2-layout2`, worktree `~/developer/sbb-worktrees/h2` (branch from `origin/main`, which now
has ghostty-web as the terminal, resizable columns, and the desktop shell mode `data-shell="desktop"`).
Design: `docs/design/console/Layout2.html` (open it in a browser; the orange notes are the brief).
Spec to keep: `docs/spec/web-console.md`, `docs/spec/ui-server.md`. You own `web/` only.

The user's words, verbatim, are the acceptance criteria:
- 顶部功能条太复杂了，这些应该合并在状态栏和设置页面当中。
- 不需要出现「SBB / Switch Brain Brain」字样，那个 Z 的标也不要。
- 控制台/组织图的切换变成下拉选框切换，前面配上无底色 SVG。
- 不要叫做「开脑」，把它叫做「新建」。

## Deliverables

1. **Top bar (44 px)**: left padding for the desktop traffic lights stays (the shell injects it);
   then a dropdown view switch (current view with a line SVG icon in front, no fill; menu with
   控制台 / 组织图 / 回执日志 / 设置, each with its icon and ⌘1..⌘4); a ⌘K search field
   (按名字或编号找脑) that selects the brain; a settings gear. Nothing else: no logo, no
   wordmark, no quota chips, no policy toggle, no held count, no theme toggle, no 新建.
2. **Status bar (30 px)** replaces TpsBar: tmux/server connection dot (SSE connected or not),
   吐字 per selected brain + total, per-account weekly quota as compact items (bar + percent;
   more than four collapse behind a `+N ▾` popover), 主脑互通 state (dot + 开/审核/关, click =
   cycle like today), 待批准 N (red pill when > 0, click opens the held list in the stream),
   version. Single line, no wrapping, sideways overflow scrolls inside the bar.
3. **Settings view** (view id `settings`, also opened by the gear and ⌘,): left nav 互通与策略 /
   额度 / 启动器 / 账户 / 终端 / 外观; right pane as in the mock. Every control reads
   `store.policy` (from `/api/state.policy`, `spawn.*` included) and writes through
   `POST /api/policy` (existing keys `peers`, `set`, `allow`, `deny`, `quota`, `spawnArgs`; new
   keys the lead adds today: `spawnPreamble {cli, value}`, `spawnCommand {cli, value}`,
   `spawnShell value`, `terminal "ghostty"|"iterm2"|null`, `subsDirect boolean`). 外观: theme
   (深色/浅色/跟随系统, stored as today) and, when `data-shell="desktop"`, 窗口透明度 and 背景模糊
   sliders that set CSS variables `--sbb-tint-alpha` (body tint alpha, default 0.42) and
   `--sbb-blur` (default 28px) and persist in localStorage; wire `web/src/style.css` to those
   variables. 账户: list from `state.accounts` with a row per account (name, clis, brains count).
4. **新建**: the spawn button lives in the brain tree header (`脑图 · N 个脑 · M 个组  [+ 新建]`);
   rename 开脑 everywhere (SpawnDialog title/buttons, empty state 还没有脑 card, toasts).
5. Keep: resizable columns, group channels, live pane, receipts, org chart, held cards, the
   desktop translucent mode. Update `docs/spec/web-console.md` sections that describe the top
   bar, TPS bar and views to the new layout (short, factual).

## Acceptance

- Fixture mode (`npm run dev` with fixtures) and real mode (`sbb ui` against a live brain) both
  render; screenshots of console / org / receipts / settings at 1440x900 in
  `docs/reports/m4-h2-layout2/` plus the desktop translucent variant if you can run
  `desktop/npm run smoke`.
- `npm test` green (web-build, web-* tests); no new dependency.
- Report `docs/reports/m4-h2-layout2-<date>.md`, then `sbb reply` to the lead. The lead merges.

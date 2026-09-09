# Web console (M3)

The console is the product's face: a Vue 3 single-page app served by `sbb ui`, designed as a desktop
application from day one (fixed three-column layout, keyboard shortcuts, light and dark), later wrapped
in an Electron shell without changes. The user never sees tmux.

Visual reference: `docs/design/console/*.html` (four 1440x900 mockups exported from the design canvas;
open them in a browser). Match them: brand green `#2d6b4f` / `#1e3a32`, light green `#e0eae8`, red
`#d94b4b`, yellow `#e5a835`, near-black `#1a1a1a`, glass panels `rgba(255,255,255,0.72)` + 12 px blur +
1 px `rgba(26,26,26,0.06)` border + 16 px radius, mono for ids and terminal text. Dark values are in
`MainDark`. No emoji anywhere.

## Stack

- `web/` is its own npm package: Vue 3, Vite, Tailwind CSS v4 (`@theme` tokens copied from
  `docs/design/tokens.css`, which mirrors the EagerStudy brand tokens), Pinia, `@vue-flow/core` for
  the org chart, `ghostty-web` for panes (Ghostty's terminal emulator compiled to WebAssembly,
  MIT, xterm.js-compatible API: its VT parser, grapheme handling and canvas renderer; the
  console sizes the terminal from the renderer's own cell size, never from a fit addon that
  reads the host, because the host follows the canvas). Nothing else without asking.
- Dev: `npm run dev` in `web/` proxies `/api` and `/ws` to a running `sbb ui --port 4789`.
  Build: `npm run build` → `web/dist`.
- One store (`useSbb`) holds the `/api/state` snapshot and applies SSE events; components never
  fetch on their own. Actions call `/api/*` and optimistically mark the affected row busy until the
  matching event arrives.

## Screens

1. **控制台** (`Main`): top bar (`TopBar`, 44 px: a view dropdown whose current view carries a line
   SVG icon in front — 控制台 / 组织图 / 回执日志 / 设置 with ⌘1..⌘4 — the ⌘K brain search field, and the
   settings gear; no logo, no wordmark, nothing else); left `BrainTree` (header 脑图 · N 个脑 · M 个组
   with the 新建 button, tree rows with status dot, name, id, account/cli/model, selected row
   highlighted, team chips at the bottom); center `ConversationStream` (tabs: team channel / private
   threads; each message: avatar initial, name#id, role chip, time, body, receipt line; composer at
   the bottom); right `BrainPane` (selected brain header with 在此输入 / 转移 / 结束 / 去终端, ghostty-web
   terminal fed by the pane WebSocket, footer with claims and receipt counts); bottom `StatusBar`
   (30 px, one line that scrolls sideways: connection dot, 吐字 per selected brain + total tok/s,
   per-account weekly quota as bar + percent — more than four collapse behind `+N`, 主脑互通 cycling on
   click, 待批准 N, version). Selecting a row switches the right pane and the private tab.
2. **组织图** (`Transfer`): Vue Flow canvas, root node = the user, main brains under it, subtrees below;
   node shows status dot, name, id, role/account/model, quota bar for mains, last message excerpt.
   Drag a node onto another node: valid targets highlight, invalid (own descendants) grey out; on drop
   a confirm card appears with 完成当前任务后 / 立即 and 先让它写交接摘要, then `POST /api/move`.
   Bottom-left shows the equivalent `sbb move` command.
3. **回执日志**: table over the receipt log (time, from, to, status, via, preview), filters by brain,
   status, via; click opens the message.
4. **主脑互通 · 先经我过目** (`Held`): held messages render inline in the thread as a yellow card with
   放行 / 拒绝 / 以后 lead 与 ops 之间不再问我; the status bar shows the policy mode and pending count
   (clicking it opens the held thread); the right column shows the compact policy table above the
   selected brain's pane.
5. **设置** (`SettingsView`, view id `settings`, opened by the gear or ⌘,): left nav 互通与策略 / 额度 /
   启动器 / 账户 / 终端 / 外观 and an 关于 caption; the right pane is `~/.sbb/config.json` made
   clickable — every control reads `/api/state.policy` and writes `POST /api/policy` through
   `web/src/lib/policy.js` (UI 开/审核/关 translate to the file's on/moderated/off). 启动器 edits
   `spawn.preamble` / `spawn.cliArgs` / `spawn.command` / `spawn.shell` per CLI, 账户 lists
   `state.accounts`, 终端 picks `terminal`, 外观 holds the theme and — inside the desktop shell — the
   window tint and blur, which set `--sbb-tint-alpha` / `--sbb-blur` and persist in `localStorage`.

## Interactions that must exist

- 在此输入: the pane becomes interactive (WebSocket `mode input:true`); a visible ring marks the mode;
  Esc-Esc or clicking outside leaves it. Keys go to the real CLI; slash commands, permission dialogs and
  model pickers are the CLI's own.
- 去终端: `POST /api/switch`; if the server returns several clients, show a picker; if it opened a new
  terminal window, say so in a toast. Shortcut `⌘\``.
- 新建 (the old 开脑): dialog with account (from `accounts`, showing remaining quota), CLI, model
  (from `catalog`), role and parent, cwd (default: parent's), then `POST /api/spawn`; the new row
  appears via events.
- Ask from the composer: sending with ⌘Enter uses `/api/ask` and shows a waiting indicator on that
  message until the reply event arrives.
- Approve/deny held messages inline; the policy chip cycles 开 / 先经我过目 / 关 with a confirm.
- Move by drag (组织图) and from the pane header (转移 opens the same confirm card with a target picker).
- Kill with a confirm listing the subtree.
- Keyboard: `j/k` move selection in the tree, `Enter` opens the private thread, `⌘K` focuses the
  top-bar brain search, `⌘\`` go to terminal, `⌘1/2/3/4` views (console / org / receipts / settings),
  `⌘,` settings.
- Theme: `.dark` class on `<html>`, following the OS by default with 深色 / 浅色 / 跟随系统 in 设置 ·
  外观.
- Empty states: no brains → a centered 新建 card with the three choices; no messages → one line.

## Quality bar

- Pixel-close to the mockups at 1440x900; usable down to 1180 px wide (the right pane collapses to a
  toggleable drawer).
- No layout shift when events arrive; lists are virtualized only if they exceed 500 rows.
- Every action shows its receipt state inline (delivered / queued / unverified / blocked) with the
  same wording as the CLI.
- Lighthouse performance ≥ 90 on the built app; first paint under 300 ms from `sbb ui`.

## Column widths

The brain tree (left) and the brain pane (right) are resizable: a 12 px handle sits in each
gutter, drag it to change that column, double-click to restore the default (300 px / 460 px).
Widths are clamped (`web/src/lib/layout.js`: tree 220-560, pane 360-960, the stream keeps at
least 420 px) and remembered per browser in `localStorage` (`sbb-layout`). Below 1180 px the
pane becomes a drawer and only the tree handle remains.

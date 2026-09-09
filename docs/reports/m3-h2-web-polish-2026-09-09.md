# M3 h2: 控制台三处打磨（不换行 / 单行底栏 / 回执日志）

- 分支 `m3/h2-web-polish`，base `main`（PR #31 合并于 293a05b）
- 范围：`web/`（Web 设备线）。Desktop renderer 复用 Web 产物，随本次构建生效；Mobile 不适用。
- 日期：2026-09-09

## 1 终端画面绝不软换行

- 新增 `web/src/lib/screen.js`：`visibleWidth` / `widestLine` 去 ANSI、OSC、宽字符按 2 列计；`ScreenWidth` 跟踪输出流里已见行的最大可见宽度，作为 pane 列数的单调下界。
- `web/src/components/BrainPane.vue`：不再调用 `fitAddon.fit()`（只保留 `proposeDimensions()` 取面板几何）。
  - xterm 列数 = `max(pane 自带列数, 面板列数, 已见最大行宽)`，只增不减，因此 xterm 永远不窄于 pane，画面绝不折行。
  - 写入前先测量再写：`width.feed()` 抬高列数后才 `terminal.write(bytes)`，同一行分块到达也不会中途换行。
  - 画面区改为 `overflow-auto`，pane 比面板宽时横向滚动；内边距放在外层框上，避免 FitAddon 把 padding 算进面板宽度。
  - 面板宽度变化时发 `{type:'resize', cols, rows}` 请求（面板尺寸，非下界值）；是否真的 `resize-pane` 由服务端按 ui-server.md 判定（有其它 attach 客户端时拒绝，控制台只滚动）。
  - `web/src/api/fixture.js`：`openPane` 先发几何再发画面，`resize` 帧改为空操作（不再误触发 `onClosed`）。
  - `web/src/api/http.js`：容错接收可选 `geometry` 控制帧；不依赖它（当前 spec 未定义服务端回报几何）。
- `web/fixtures/panes.json` 改为 `{cols, rows, lines}`，`cols` 取罐头屏最大可见行宽（pane 真实列数的下界），`rows` 取行数。

## 2 右栏底栏与 TPS 底栏单行

- `TpsBar.vue`：`overflow-hidden + whitespace-nowrap` 锁死单行；每脑一行 `shrink-0`，中间区 `min-w-0 overflow-hidden` 先被裁；右侧块里「总吞吐」与数值 `shrink-0` 永不被裁，「来源」说明是唯一可压缩项（`shrink-[999] truncate`），空间不足时先省略/消失。
- `BrainPane.vue` 底部说明行：`overflow-hidden + whitespace-nowrap`，提示语 `min-w-0 truncate` 省略，`claims / 回执` 统计 `shrink-0` 完整保留。

## 3 回执日志真机初始化

- `store/sbb.js`：`applySnapshot` 从 `/api/state.receipts` 初始化（`slice(0, 500)`），`receipt` 事件继续 `unshift` 并把长度截到 500，与 h3 的服务端窗口一致。

## 验证（fixture 模式，`VITE_SBB_FIXTURE=1` 构建 + 静态服务 4189）

- `node --test test/web-screen-width.test.js`：10/10 通过（新增 3 项覆盖 `ScreenWidth`）。
- 根目录 `npm test`：419/419 通过（原 409 + 新增 10）。
- 浏览器点验（Playwright，1440×900，明暗两套）：
  - 三个罐头 pane（%48 cols 180、%30 cols 132、%21 cols 59）逐行比对渲染结果与罐头屏：`wrapped: 0`，全部行一字不差，无软换行。
  - 横向滚动：%48 内容 1300px / 面板 410px，%30 954/410，均可滚；%21 426/410 微滚。
  - TPS 底栏高 36px（单行）：「来源」说明 `truncated: true`，`总吞吐 477` 完整可见且在视口内。
  - 右栏底栏高 41px（单行）：提示语 `truncated: true`，`claims 2 · 回执 delivered 6 / queued 1` 完整。
  - 回执日志页：初始 7 条（来自 `/api/state.receipts`），脚本事件到达后 8 条，初始化 + 叠加事件均生效。
  - 控制台无 console error / pageerror。
- 视觉证据（已随本 PR 更新）：`docs/reports/m3-h2-screens/{console,org,receipts,held}-{light,dark}.png`、四张 mockup 对照 `compare-*.png`、23s 演示 `console-demo.webm`。

## 已知边界

- 服务端当前不上报 pane 几何，控制台用输出内容推断列数下界：pane 比面板窄时按面板宽度显示（右侧留白），比面板宽时横向滚动，两种情况都不折行。
- 罐头屏列数是「最大可见行宽」，是 pane 真实列数的下界（`capture-pane -p` 会裁掉行尾空白），因此 fixture 里 %21 比面板宽约 16px、会出现一条极短横向滚动条。
- `resize` 请求是否生效由服务端裁决，控制台不假设成功。

# 新建对话框二修（h2）

- 任务单：`docs/tasks/m4-h2-spawn-dialog.md`
- 分支：`m4/h2-spawn-dialog`，base `origin/main`（0b973b7）
- 日期：2026-09-10
- 设备线：Web 已改；Desktop 已改（同一渲染层 + 桌面壳原生选择器）；Mobile 不适用

## 交付内容

### 1. 账号额度按「真正会用的那一对」（`web/src/lib/spawn.js`、`SpawnDialog.vue`）
`quotaChipFor(quota, account, cli)` 的取值顺序：`${account}/${cli}` 这条 chip 有数字就用它；否则用该账号第一个有数字的 chip；账号完全没有数字才显示「按量」。账号按钮显示的是「选中账号用 `form.cli`、其他账号用它自己的第一个 CLI」的那一对，所以不会再出现截图里 `default 0`、`a 0` 这种来自另一个 CLI 的数字。已按这个口径写进单测，边界（同账号非数字 chip + 数字兄弟 chip、无 chip、未知账号）都有用例。

### 2. CLI 与模型列表（`cliOptions` / `modelOptions`）
CLI 下拉直接读 `store.accounts[i].clis`（服务端已合并目录，`default` 上是 claude/codex/agy/cursor）；模型列表按 `account + cli` 过滤 `store.catalog`（服务端 `flattenCatalog` 现在带 `account`）。该账号该 CLI 没有模型时，CLI 仍可选，模型为空（下拉里显示「该 CLI 默认」），提交时不带 `model`，交给 CLI 自己的默认。

### 3. 工作目录组合框（`cwdPicks`）
输入框保持手输，聚焦时下拉出快捷路径：上级脑的 cwd 排第一，然后服务端 `recentCwds`（新到旧、去重、最多 8 条）。桌面壳里额外显示「选择文件夹…」按钮，调用 `window.sbbDesktop.pickFolder({ defaultPath })` 并把返回值填进输入框；浏览器里按钮不渲染（无桥）。提交时取「手输 → 上级 cwd → 第一个快捷路径」，都为空就不带 `cwd`，由服务端决定。

### 4. 对话框本身（`SpawnDialog.vue` + `web/src/style.css`）
- 面板不透明：`.dialog-solid` 深色 `rgba(16,20,18,0.96)`、浅色 `rgba(255,255,255,0.96)`，没有 `backdrop-filter`，空状态卡片和页面透不上来。
- 页面被 `.scrim` 盖住并模糊（`rgba(0,0,0,0.28)` + `blur(6px)`）。
- 标题栏指针事件拖动，`clampOffset` 保证整块留在视口内（比视口还大时居中），位置存在模块里，同一会话内重开还在原处（`<script setup>` 每次挂载都会重跑，所以位置不能放在组件里）。
- `Esc` 关闭（快捷路径下拉打开时先关下拉）；打开后焦点在「名字」。

### 5. fixture
`web/fixtures/state.json`：`recentCwds`、`default` 的 `clis` 补上 agy/cursor、`c` 补上 cursor（且目录里没有 c/cursor 的模型行，用来验「无模型仍可选」）、catalog 行补 `account`、新增账号 `b`（没有任何额度行）。`web/fixtures/scenes.json` 新增 `spawn-quota`：账号 a 只有一条无数字的 chip，用来验「按量」。

## 顺手修掉的两个真实缺陷

### 生产构建里所有毛玻璃都没有模糊
构建产物只保留了 `-webkit-backdrop-filter`（`.glass`、`.bar`、桌面壳的 `--sbb-blur` 规则全中招），而当前 Chromium 已经不认这个前缀：

```
CSS.supports('backdrop-filter','blur(6px)')            -> true
CSS.supports('-webkit-backdrop-filter','blur(6px)')    -> false
构建产物：.glass{...;-webkit-backdrop-filter:blur(12px)}   （没有标准写法）
```

原因是最小化器把 `backdrop-filter` / `-webkit-backdrop-filter` 当成同一属性的别名对，只保留最后一条；源码里标准写法在前、前缀写法在后，于是留下前缀版。把 5 处写法改成前缀在前、标准在后（`web/src/style.css`），构建产物里两种都在，模糊恢复。这一条影响整个应用的玻璃面和桌面壳的窗口模糊，不只是新建对话框。

### 顶栏下拉被主区域盖住（上一条修完才暴露）
`header.bar` 一旦真的有了 `backdrop-filter` 就形成层叠上下文，下拉菜单的 `z-40` 被关在 header 里，而 header 在 DOM 里排在 `main` 前面，于是菜单画在主区域下面，点不到。给 header 加 `relative z-30` 后恢复。回归脚本里「点设置进入设置页」这条就是它的探针：修之前超时，修之后通过。

## 验证

- fixture 模式 21/21 通过、零 console 错误：不透明面板（深浅两套色值）、scrim 模糊、四个账号各自的一对额度、`default` 的 CLI 列表、按对过滤的模型、`c` 的 cursor 无模型仍可选、不串账号、快捷路径顺序与点选回填、手输可用、浏览器里没有选择器按钮、标题栏拖动位移 `translate(200px, 120px)`、拖出屏幕后被夹回视口、`Esc` 关闭、重开位置保留、桌面壳（stub 桥）按钮出现且调用 `pickFolder({defaultPath})` 并回填、`spawn-quota` 场景显示「按量」。
- 真实模式 10/10 通过、零 console 错误：隔离 `sbb ui`（`SBB_DIR=/tmp/sbb-h2-m4`、`SBB_TMUX_ARGS='-L sbb-h2'`、端口 4899、服务刚构建的 `web/dist`），认领一个假 CLI 面板为 SSL-0001。真实四账号额度 `default 69% / a 77% / b 31% / c 按量`，与 `web/src/lib/quota.js` 算出的期望逐字一致；`default` 的 CLI 列表 claude/codex/agy/cursor；`default/claude` 的模型 Fable 5.1/Opus 5/Sonnet 5/Haiku 4.5；快捷路径 = 服务端 `recentCwds`（`/private/tmp/sbb-h2-demo`）；桌面壳按钮 + 桥回填；深浅两套不透明色值。
- 回归：上一轮已合入的布局 v2 fixture 脚本 24/24（`/tmp` 里跑，截图写到临时目录，没有覆盖 `docs/reports/m4-h2-layout2/` 的已提交证据）。
- 单测：仓库根 `npm test` 553/553（新增 `test/web-spawn.test.js` 8 例）。无新增依赖。
- 截图 10 张 1440×900 在 `docs/reports/m4-h2-spawn-dialog/`：dialog-dark、dialog-light、dialog-desktop-dark、dialog-dragged-dark、cwd-open-dark、dialog-spawn-quota-dark，以及真实模式 real-spawn-dark、real-spawn-light、real-spawn-cwd-dark、real-spawn-desktop-dark。

## 未覆盖

- 没有真的执行一次 spawn（会拉起真实 CLI、消耗额度）。提交负载的形状由单测和 fixture 的 `/api/spawn` 覆盖，`model`/`cwd` 为空时不带该键。
- 「选择文件夹…」只在浏览器里用 stub 的 `window.sbbDesktop` 验证（fixture 与真实模式各一次），没有在打包后的 Electron 应用里点过原生对话框。
- 账号额度回退规则按任务单字面实现：该账号第一个有数字的 chip 可以来自另一个 CLI（例如 `b` 显示 31% 来自 b/codex）。如果这不是想要的语义，需要任务单方明确。

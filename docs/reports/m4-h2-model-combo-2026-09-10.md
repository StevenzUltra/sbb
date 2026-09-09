# 新建对话框：模型组合框 + 思考强度 + 名字规则（h2）

- 任务单：`docs/tasks/m4-h2-spawn-dialog.md`（「Follow-up」自定义模型名 + 「Follow-up 2」effort 与名字）
- 分支：`m4/h2-model-combo`，base `origin/main`（708a516）
- 日期：2026-09-10
- 设备线：Web 已改；Desktop 已改（同一渲染层，桌面壳无需改动）；Mobile 不适用

## 交付内容

### 1. 模型改成组合框（`web/src/lib/spawn.js`、`SpawnDialog.vue`）
- 模型字段是 `<input>`，不再是 `<select>`：目录里该「账号 + CLI」的模型是候选（沿用工作目录那套 `.glass` 下拉），任意手输的 id 原样提交给 `/api/spawn` 的 `model`，服务端已经会把它透传给 CLI（`--model` / `-m`）。
- 候选顺序：本 CLI 上次手输的 id 排第一（标记「· 上次手输」），然后是目录模型；重复的不重复出现。
- 页脚显示真正会传下去的值：`a · Claude · my-local-model · 剩余 89%`，没填时是「默认」。
- 每个 CLI 记住最后一次手输的 id，存在 `localStorage` 的 `sbb-spawn-models`（`readCustomModels` / `writeCustomModel`，脏数据、数组、写失败都退化成空表，不影响新建）。切换 CLI 会清空当前输入并刷新候选，但不动别的 CLI 的记忆。
- 下拉在 `focus` 与 `click` 都会打开：选完候选后输入框仍是焦点，只靠 `focus` 会打不开第二次（真实缺陷，见下）。

### 2. 思考强度（`effortOptions` + 对话框下拉）
- 下拉在模型旁边，选项「无 / low / medium / high / xhigh」，以 `effort` 提交；只对 `claude`、`codex` 出现（服务端 `src/lifecycle/launch.js` 只给这两个 CLI 拼 `--effort` / `-c model_reasoning_effort=`），`agy`、`cursor`、`kimi`、`grok` 直接不渲染该字段。
- 切换 CLI 时 effort 归零，避免把 claude 的档位带到别的 CLI。
- 页脚按顺序显示：`账号 · CLI · 模型 · effort · 额度`，没选 effort 就不占位。
- 脑图行 meta 在记录带 `effort` 时追加 `effort high`（`BrainTree.vue`）。

### 3. 名字规则（`sanitizeName` / `NAME_RE` / `errorText`）
- 输入时把空白替换成 `-`（`my brain` → `my-brain`），大小写和中文原样保留。
- 服务端 `invalid_name` 的报错不再把正则甩给用户：`store.act` 走 `errorText()`，命中 `invalid_name` 时只显示一条中文规则「名字只能用字母、数字、中文、-、_、.，不能有空格（最长 40 个字符）」；其他错误原样透传。
- `store.toast` 会先删掉同文案同色调的旧条目再插新的，重复失败不会叠成一摞。

### 4. fixture
- `/api/spawn` 镜像服务端名字规则（`NAME_RE`），非法名字抛 `invalid_name: ...`，用来在 fixture 里验中文提示；`effort` 会写进新建的脑记录。
- `web/fixtures/state.json` 给 `lead` 加了 `effort: high`，脑图行能看到 effort。

## 顺手修掉的一个真实缺陷

模型下拉只在 `focus` 打开。选中一个候选后 `modelOpen = false` 但输入框仍是焦点，再点它不会再触发 `focus`，下拉再也打不开；标题栏拖动带 `@mousedown.prevent`，也不会让输入框失焦。加了 `@click="modelOpen = true"` 后恢复正常。同一模式的工作目录输入框（上一单交付，已合入 main）仍有这个问题，本轮按派单边界未改，留给后续。

## 验证

- 单测：`node --test test/web-spawn.test.js` 15/15；全仓 `npm test` 573/573 通过。
- fixture 模式 Playwright（`VITE_SBB_FIXTURE=1 npm run build:fixture` + `http.server 4189`）：
  - 模型组合框 15/15：字段是 input、候选=该对目录模型、手输原样进 `/api/spawn`、脑记录带 `my-local-model`、localStorage 按 CLI 记忆、重开时记忆排第一、切 CLI 后 codex 无记忆、点候选填入并收起、Esc 关闭、深浅两套页脚。
  - 思考强度与名字 14/14：claude/codex 有下拉且选项正确、页脚带档位、agy/cursor 隐藏、空格转 `-`、大小写与中文保留、payload 同时带 `name/model/effort`、脑图行显示 `effort high`、非法名字只弹一条中文规则且第二次不叠加。
- 真实模式 Playwright（隔离 `SBB_DIR=/tmp/sbb-h2-m4`、`SBB_TMUX_ARGS='-L sbb-h2'`、端口 4899，认领一个假 codex 面板为 SSL-0001）11/11：`default/claude` 的候选=真实目录 `Fable 5.1|Opus 5|Sonnet 5|Haiku 4.5`，页脚 `default · Claude · my-local-model · high · 剩余 66%`（与 `/api/state` 算出的 chip 逐字一致），agy/cursor 隐藏 effort，名字空格转 `-`，无 effort 的已认领脑行不带 effort，零 console 错误、零 toast。
- 布局 v2 回归脚本仍全绿，无 console 错误。
- 截图 11 张在 `docs/reports/m4-h2-model-combo/`（深浅 + 桌面壳 + 真实模式）。

## 未覆盖 / 风险

- 真实 `sbb spawn --effort` 没有实跑（会真的拉起 CLI）；服务端拼参由 main 的 `6b7100e` 与 `test/lifecycle-launch.test.js` 覆盖，本轮只验 Web 侧提交的 payload。
- 真实模式没有点「新建」（不拉起真 CLI），所以「真实 spawn 后脑图行带 effort」只有 fixture 证据。
- 工作目录下拉与模型下拉是同一套 `focus` 打开模式，前者未修（超出本轮派单范围）。

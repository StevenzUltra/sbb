# 思考强度 max 与按 CLI 降级提示（h2）

- 任务来源：派单消息 `sbb:8db41a18`（`docs/tasks/m4-h2-spawn-dialog.md` 尚无对应小节）
- 分支：`m4/h2-effort-max`，base `origin/main`（f8d50f8）
- 日期：2026-09-10
- 设备线：Web 已改；Desktop 已改（同一渲染层）；Mobile 不适用

## 交付内容

### 1. 档位加 `max`（`web/src/lib/spawn.js`）
`EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']`，下拉顺序「无 / low / medium / high / xhigh / max」，仍然只对 claude、codex 出现。

### 2. 按 CLI 的档位上限与降级提示
- `EFFORT_CEILING = { claude: 'max', codex: 'xhigh' }`，与服务端「Codex 的 max 跑成 xhigh、记录里带 `effortApplied`」的口径对齐；服务端降级逻辑本轮不在 main（main 上 `launch.js` 仍是原样透传），所以这张表在 Web 侧也放了一份，并在注释里指回 `src/lifecycle/launch.js`。
- `effortApplied(cli, level)` 给出实际生效档：超过上限就截到上限，未知档位原样透传（由服务端决定），无 effort 开关的 CLI 返回空串。
- `effortNote(cli, level)` 只在档位会被降级时返回提示，文案按派单原文：`Codex 最高 xhigh，将按 xhigh 运行`；页脚把它接在额度后面。
- 提交时仍发送用户选的档（`effort: 'max'`），降级由服务端负责。

### 3. 脑行 meta 显示实际生效档
`BrainTree.vue` 用 `brain.effortApplied ?? brain.effort`，所以记录里带降级结果时显示的是真正跑起来的档位。

### 4. fixture
- `/api/spawn` 用同一份 `effortApplied` 规则写回 `effortApplied`，记录里同时保留 `effort`（选的值）与 `effortApplied`（生效值）。
- `web/fixtures/state.json` 的 `ops`（codex）标成 `effort: max` / `effortApplied: xhigh`，脑行直接能看到降级后的档位。

## 验证

- 单测：`node --test test/web-spawn.test.js` 17/17（新增 max 顺序、`effortApplied` 截断/透传、`effortNote` 文案、页脚追加提示）。
- 全仓 `npm test` 575/575。
- fixture 模式 Playwright 9/9：档位表以 max 结尾；claude 选 max 无提示；切 CLI 归零；codex 选 max 页脚为 `a · Codex · 默认 · max · 剩余 94% · Codex 最高 xhigh，将按 xhigh 运行`；提交的 payload 仍是 `effort: 'max'`；新建记录 `{effort: 'max', effortApplied: 'xhigh'}`；脑行显示 `effort xhigh`；深浅两套一致。
- 真实模式 Playwright 5/5（隔离 `SBB_DIR`、`SBB_TMUX_ARGS='-L sbb-h2'`、端口 4899，认领假 codex 面板为 SSL-0001）：档位表以 max 结尾；`default/claude` 选 max 无提示；`default/codex` 选 max 页脚 `default · Codex · 默认 · max · 剩余 16% · Codex 最高 xhigh，将按 xhigh 运行`（额度与 `/api/state` 算出的 chip 逐字一致）；无 effort 的已认领脑行不带 effort；零 console 错误。
- 回归：上一轮模型组合框脚本 15/15、follow-up 2 脚本 14/14（其中「档位表」断言按新列表更新），布局 v2 未受影响。
- 截图 4 张在 `docs/reports/m4-h2-effort-max/`（fixture 深浅、脑行、真实模式深浅）。

## 未覆盖 / 风险

- 服务端降级与 `effortApplied` 字段尚未合入 main，本轮只按派单口径在 Web 侧镜像；服务端合入后需核对上限表（尤其 codex 是否就是 xhigh）与字段名是否一致。
- 没有实跑真实 `sbb spawn --effort max`（会真的拉起 CLI），所以「真实 spawn 后脑行显示 xhigh」只有 fixture 证据。

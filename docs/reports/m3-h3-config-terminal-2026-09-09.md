# h3 报告：config.terminal 在 policy 写回后仍保留（派单补充 cb6fd9e0）

- 分支：`m3/h3-config-terminal`（base `origin/main` @ 769ecc0，已含合入的 PR #33）
- 日期：2026-09-09
- 结论：`mergeConfig` 现在把 `terminal` 当已知键保留，`sbb policy` 写回后不再抹掉它。`npm test` 501 项、连续 3 次 `pass 500 / fail 0`（1 项 skip 是 web 构建，需 `web/node_modules`）；未新增依赖。

## 问题与修法

`src/policy/config.js` 的 `mergeConfig` 只输出已知键，而 h1 的 `sbb ui` 读 `~/.sbb/config.json` 的 `terminal`（`ghostty`|`iterm2`，见 `docs/spec/ui-server.md`「Go to terminal」）。任何 `sbb policy ...` 都会 read→mutate→write 整个 config，于是 `terminal` 被静默丢掉。

`src/policy/config.js`：

- 新增 `TERMINALS = ['ghostty','iterm2']`，typedef 增加可选 `terminal?: 'ghostty'|'iterm2'`。
- `mergeConfig` 保留合法值并归一化为小写；缺失或非法值一律省略该键。

**与派单措辞的一处偏差（请主脑确认）**：派单要求 typedef/defaults/merge 都加，我没有给 `defaults` 加值。原因是 `src/ui/switch.js` 的 `goToTerminal` 在偏好缺失时用 `TERMINALS.find(installed)` 自动挑一个已安装的终端；若 `defaultConfig()` 给出 `ghostty`，没装 Ghostty 的机器会从「自动挑 iTerm2」退化成 `Ghostty.app is not installed`。规格同句写的也是「whichever is installed」。保留键已修掉丢值问题；若确实要固定默认值，请确认可接受这一行为变化，我再加。

## 验证

- 新增测试（`test/policy.test.js`）：文件没有 `terminal` 时 `mergeConfig` 不发明该键；`sbb policy peers off` 真实写回后内存与磁盘上的 `terminal` 仍在；`Ghostty` 归一化为 `ghostty`；`kitty` 与非字符串被丢弃。
- `npm test` 连续 3 次：`ℹ tests 501 / pass 500 / fail 0`（1 项 skip：`web: npm run build`，需 `web/node_modules`）。
- 未新增依赖；`git status` 只有 `src/policy/config.js` 与 `test/policy.test.js`。

## 环境说明

h1 的 PR #32 给 `package.json` 加了 `ws`。我的 worktree 此前没装依赖，`test/ui-cli.test.js` 与 `test/ui-server.test.js` 因 `ERR_MODULE_NOT_FOUND: ws` 整文件失败；在 worktree 执行 `npm install --no-package-lock` 后两项通过（未提交 lockfile，未改 `package.json`）。

## 回主脑

`sbb reply cb6fd9e0` 结果见回执。

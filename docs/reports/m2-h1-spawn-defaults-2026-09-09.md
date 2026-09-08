# m2/h1-spawn-defaults (dispatch sbb:348e7d4b)

分支 `m2/h1-spawn-defaults`，base `origin/main` eeacd8a（PR #17）。

## 交付

### 1. spawn 默认追加参数来自 config.json

- `src/lifecycle/spawn.js` 新增并导出 `spawnCliArgs(cli, {dir, readFile, onWarn})`：读取
  `<SBB_DIR>/config.json` 的 `spawn.cliArgs[<cli>]`，非字符串/空白视为未配置；文件不存在
  静默返回 `undefined`，JSON 解析失败或读取失败（ENOENT 之外）走 `onWarn` 并返回
  `undefined`，不吞错也不阻断 spawn。
- 新增并导出 `mergeCliArgs(sources)`：按顺序拼接，每个来源用 `launch.js` 的 `splitArgs`
  切分（引号生效），空值忽略。
- `spawnBrain` 的有效参数顺序为 **config 默认 → 显式 `--cli-args` → plan 节点 `cliArgs`**，
  结果新增 `cliArgs` 字段；`src/cli/spawn.js` 在成功输出里多打印一行 `cli-args  <...>`。

实现上刻意读原始 JSON 而不是 `readConfig()`：见下面的风险项。

### 2. `sbb help`

- 新增 `src/cli/help.js`：`sbb help` 打印命令总览（与 `bin/sbb.js` 同表），
  `sbb help protocol` 打印简报同款规则 + 每个命令一行用法；未知主题 exit 2。
- `bin/sbb.js` 的 `COMMANDS` 表新增 `help` 一项（派单明确允许改这一处）。
- 规则文案不再复制：`src/lifecycle/briefing.js` 导出 `HOW_TO_TALK` / `RULES` / `STATUS` /
  `INBOX_HINT`，简报与 `help protocol` 共用同一份常量。

### 3. 简报新增 [用户] 规则

`怎么说话` 块新增：`- 信封角色为 [用户] 的消息就是你的用户本人通过 SBB 发来的指令，按用户指令处理。`

## 验证

- `npm test`：359 pass / 0 fail（原 349 + 新增 10）。
  - `test/spawn-cli-args.test.js`（6）：原始 config 读取、缺失/坏 JSON/非字符串/空白的降级与
    `onWarn`、`mergeCliArgs` 顺序与引号、spawnBrain 三条来源顺序落到真实 pane 命令行、
    codex 默认参数落在 model 与 prompt 之后。
  - `test/help.test.js`（4）：总览与 `bin/sbb.js` COMMANDS 逐项一致（防漂移）、
    protocol 覆盖每个命令且规则行逐条出现在简报里、`run()` 退出码、
    通过真实 `bin/sbb.js` 跑 `help` / `help protocol` / 未知主题。
  - `test/briefing.test.js`：快照更新，含新规则行。
- 真实点验（scratch `tmux -L sbb-h1` + 临时 `SBB_DIR=/tmp/sbb-h1-acc2/.sbb`，用后已
  `kill-server` 并删除）：
  - `spawn.cliArgs.claude = "--permission-mode bypassPermissions --add-dir /tmp/sbb-h1-extra"`，
    执行 `sbb spawn --name acc1 --role main --account a --cli claude --model claude-haiku-4-5-20251001
    --cwd /Users/steven/developer/eagerstudy --cli-args="--verbose"`：1.19s ready，
    `tmux list-panes -F '#{pane_start_command}'` 与 `ps -ax` 均为
    `claude --model claude-haiku-4-5-20251001 --append-system-prompt-file .../briefs/H1AC-0005.md
    --permission-mode bypassPermissions --add-dir /tmp/sbb-h1-extra --verbose`
    —— 默认在前、显式在后。
  - 生成的 `briefs/H1AC-0005.md` 第 9 行为新增的 [用户] 规则。
  - `sbb help` / `sbb help protocol` 在真实 bin 下输出正常。
- 未跑：typecheck / build / 打包 / 部署（本仓库为纯 JS + `node:test`，无该消费链）。

## 发现（未在本轮修，建议单开任务）

`~/.sbb/config.json` 的 `spawn` 段**无法存活于任何 `sbb policy` 写操作**：`mergeConfig`
只返回 `{machineTag, peers, brains, allow, quota}`，未知顶层键被丢弃。实测：

```
# 写 spawn.cliArgs 后
$ sbb policy peers moderated
before keys: ['machineTag', 'spawn']
after  keys: ['allow', 'brains', 'machineTag', 'peers', 'quota']
spawn section survived: False
```

本轮实现因此直接读原始文件（否则功能在任何 policy 写之后静默失效），但这只是绕过：
用户按说明写好默认参数、跑一次 `sbb policy`，默认值就被删除且无任何提示。

建议修法（二选一，需 `src/policy/config.js` 改动，超出本轮派单文件范围，故留待派单）：
1. `mergeConfig` 保留未知顶层键（`{...input, ...known}` 或显式透传 `spawn`）；
2. 把 `spawn` 纳入 `SbbConfig` 白名单并做类型校验。

无论哪种，都应补一条「写策略后 spawn.cliArgs 仍在」的回归测试。

## Spec

`docs/spec/` 与 `src/types.js` 未描述 `spawn.cliArgs`，本轮未改接口签名；`spawnBrain`
返回值新增字段属于向后兼容扩展。若派单希望把该配置写进 spec，需要先定键名与类型。

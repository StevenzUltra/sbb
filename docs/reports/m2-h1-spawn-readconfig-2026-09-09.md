# m2/h1-spawn-readconfig (dispatch sbb:685ecf4f)

分支 `m2/h1-spawn-readconfig`，base `origin/main` 3042693（PR #19）。

## 改动

- `src/lifecycle/spawn.js`：`spawnCliArgs(cli, {dir, readConfig, onWarn})` 改为调用
  `policy/config.js` 的 `readConfig({sbbDir: dir, onWarn})` 取 `config.spawn.cliArgs[cli]`，
  删掉原来读原始文件的实现和那段已经过时的注释（#18 已把 `spawn` 纳入 `mergeConfig`）。
  参数名 `readFile` 换成 `readConfig`，测试注入点随之变化。
- 行为差异（有意）：配置文件缺失或 JSON 损坏时不再自己 warn，改为走 policy 层的既有约定
  「缺失或损坏 → 默认值，不阻断」；缺省参数因此丢失但 spawn 继续。非字符串/空白值仍被忽略。
- `test/spawn-cli-args.test.js`：读取类用例继续用真实 `config.json` 走 policy reader；
  新增/改写用例覆盖「缺文件与坏 JSON 静默回默认」、「注入 readConfig 时空白与非字符串被忽略」。

## 验证

- `npm test`：362 pass / 0 fail（main 361 + 新增 1）。
- 真实点验（scratch `tmux -L sbb-h1` + 临时 `SBB_DIR=/tmp/sbb-h1-acc3/.sbb`，用后
  `kill-server` 并删除）：
  1. `sbb policy spawn-args claude "--permission-mode bypassPermissions --add-dir /tmp/sbb-h1-extra"`
  2. 再执行 `sbb policy peers moderated`（第二次写盘，验证 #18 的保留）
  3. `sbb spawn --name acc3 --role main --account a --cli claude --model claude-haiku-4-5-20251001
     --cwd /Users/steven/developer/eagerstudy --cli-args="--verbose"`：1.18s ready，
     `pane_start_command` 与 `ps -ax` 均为
     `claude --model claude-haiku-4-5-20251001 --append-system-prompt-file .../briefs/SSL-0001.md
     --permission-mode bypassPermissions --add-dir /tmp/sbb-h1-extra --verbose`
     —— 由 `sbb policy spawn-args` 写入的默认参数排在显式 `--verbose` 之前。
- 未跑：typecheck / build / 部署（纯 JS + `node:test`，无该消费链）。

## 遗留（未改，供派单参考）

`src/lifecycle/spawn.js` 里还有一个本地 `readConfig`（读原始 JSON，供 `quotaFloor` 使用），
与本文件新导入的 policy `readConfig`（别名为 `readPolicyConfig`）同名不同义。本轮派单只覆盖
`spawnCliArgs`，未动 quota 通路；若要一并统一，需要单独任务并补 quota floor 的回归测试。

## Spec

`src/types.js` / `docs/spec/` 未描述该内部函数，接口签名（`spawnBrain` 的入参与返回）不变。

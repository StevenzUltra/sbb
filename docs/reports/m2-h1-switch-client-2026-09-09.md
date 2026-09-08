# m2/h1-switch-client (dispatch sbb:946c4c0c)

分支 `m2/h1-switch-client`，base `origin/main`（PR #20 之后）。

## 事故与根因

`src/lifecycle/switch.js:51` 的 `switch-client -t <session>` 不带 `-c`，tmux 会挑「最近活动的
客户端」，也就是用户本人的 Ghostty，于是 `sbb switch` 把用户从自己的窗口拉进了排练 session。

## 改动

- `src/lib/tmux.js`：新增 `listClients()`，`tmux list-clients -F '#{client_tty}\t#{client_session}'`
  解析为 `{tty, session}[]`。
- `src/lifecycle/switch.js`：
  - 新增导出 `callerTty({isatty, readlink, env, exec})`：先看 stdin/stdout 是否 tty
    （`node:tty` + `/dev/fd/<n>` 的 readlink），再退到 `$SSH_TTY`，最后用 `tty` 命令；都没有就返回
    `undefined`。
  - `switchTo` 用调用者 tty 在 `listClients()` 里找自己的客户端；命中且不在目标 session 时执行
    `switch-client -c <tty> -t <session>`；**命中失败时一个 `switch-client` 都不发**，只做
    `select-window`/`select-pane`，并返回 `attach: tmux switch-client -t <session>`。
  - 返回值新增 `attach`（无客户端时的提示）与 `client`（自己的 tty，null 表示没有）；
    `listClients` 失败按 `tmux_failed` blocked，不猜。
- `src/cli/switch.js`：非 JSON 输出时在 `switched ...` 后追加打印 `attach:` 提示；用法说明同步。
- `docs/spec/lifecycle.md` 的 `sbb switch` 小节改为「只移动调用者自己的客户端 + 无客户端时打印
  attach 提示」。
- `test/fixtures/lifecycle/fake-tmux.js`：新增 `clients` / `failListClients` 与 `listClients()`。

## 验证

- `npm test`：365 pass / 0 fail（main 362 + 3）。
  `test/lifecycle-switch.test.js` 10 项覆盖三种情形（命中自己的客户端；有 tty 但不在客户端列表；
  完全没有 tty）以及「已在目标 session 不重复切换」「list-clients 失败 blocked」「callerTty 的
  四级回退」「CLI 打印 attach 提示」「gone 仍 exit 4 并写 paneId=null」。
- 真实点验（scratch `tmux -L sbb-h1` + 临时 `SBB_DIR=/tmp/sbb-h1-acc4/.sbb`，用 expect 提供 pty
  附着一个真客户端，用后 `kill-server` 并删除全部临时文件）：
  - 真客户端 `/dev/ttys073` 附着在 session `other`；从非 tty 进程执行
    `sbb switch acc4`：输出 `switched H1AC-0001 acc4 brain:2.1` + `attach: tmux switch-client -t brain`，
    `list-clients` 仍为 `/dev/ttys073 other` —— 用户客户端没有被移动。
  - 再以 `SSH_TTY=/dev/ttys073` 执行：`list-clients` 变为 `/dev/ttys073 brain`，即
    `switch-client -c <tty> -t <session>` 在真实服务器上按预期只移动该客户端。
  - 目标 session 的活动 pane 为 `brain:2.1`（%1），`select-window`/`select-pane` 生效。
- 未跑：typecheck / build / 部署（纯 JS + `node:test`）。

## 备注

`attach:` 提示只在没有自己的客户端时出现；已附着在目标 session 的调用者也不会被重复切换
（`switch-client` 会顺带改窗口，故跳过）。

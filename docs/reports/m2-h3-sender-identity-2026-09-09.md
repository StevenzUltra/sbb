# h3 报告：发送方会话身份、reply 路由顺序与坐标的 tmux 服务器前缀

- 分支：`m2/h3-sender-identity`（base `origin/main` @ 82a26a1，PR #10 已合入）
- 派单：主脑 msgId `66827cf5`（三项）
- 日期：2026-09-09
- 结论：三项全部实现；`npm test` 220/220 通过（main 基线 211，新增 9 项）；5 项在 scratch tmux + scratch home/`SBB_DIR` + 真 unix socket 上真机点验通过；未装依赖、未合并、未 push main。

## 交付物

新增：

- `src/lib/coord.js`（33 行）：`formatCoordFull(coord, serverPath)` / `splitCoordFull(text)`，`<tmux server socket path>@<coord>` 的组装与拆分，空值一律 `null`。

修改：

- `src/lib/tmux.js`：新增 `serverSocketPath()`。`$TMUX` 的第一段就是 socket 路径，直接读、不起子进程；只有 `SBB_TMUX_ARGS`（可能指向别的服务器）才 `tmux display-message -p '#{socket_path}'`。按 `$TMUX|$SBB_TMUX_ARGS` 缓存，重复发送不再起进程。
- `src/cli/util.js`：新增 `senderSessionFromEnv()`（读 `CLAUDE_CODE_MESSAGING_SOCKET`，补 `uds:` 前缀并解析 pid）、`targetFromSessionSock()`（由 `<pid>.*.key` 反查账号，让 uds 传输能认证）、`resolveServerPath()`；`deliver()` 在回执里写 `senderSock`/`senderPid`/`fromCoordFull`/`toCoordFull`；`enforceDelivery()` 把 `senderSession`/`serverPath` 透传给 `blockResult()`，被拦回执与已发回执字段一致。
- `src/cli/tell.js`、`src/cli/ask.js`：新增 `--force` 并透传到闸门（只绕 `quota.floorWeekly`，永不绕 moderation）。
- `src/cli/reply.js`：路由顺序改为 `fromSock`（等待中的 ask/tell 收件箱）→ `senderSock`（会话 socket 仍能连）→ 脑记录 / 回执里的 `fromAddress` → 裸坐标。坐标兜底只在 `fromCoordFull` 的服务器与本进程一致时使用；回执没记服务器路径时按旧行为。
- `docs/spec/receipts.md`：补回执新字段表、`senderSock` 语义、reply 四段顺序与 `--force` 边界。
- `test/sender-identity.test.js`（9 项）：env 解析与 `uds:` 归一化；坐标前后缀往返；已发/被拦回执字段；reply 的四段顺序（含跨服务器拒绝）；tell/ask `--force` 绕过真实额度闸门。

## 设计要点

- 回执里的 `fromAddress`/`address` 保持原样（`a/claude:24:3.4`），服务器前缀只进日志字段，显示不受影响。
- `senderSock` 是"会话身份"而不是"等待中的监听者"：ask/tell 退出后 `fromSock` 立刻失效，会话 socket 仍在，这正是上一轮 `sbb reply` 失败的根因。
- 坐标兜底必须带服务器校验：两个 tmux 服务器可以有同名的 `session:window.pane`，裸坐标跨服务器会投给错误的人。

## 测试

`test/sender-identity.test.js` 9 项；全量 `npm test` 220/220（新增 9，未改既有断言）。

```
ℹ tests 220
ℹ pass 220
ℹ fail 0
```

修过一处本轮引入的回归：`serverSocketPath()` 起初无条件起 tmux 子进程，导致 `test/delivery.test.js` 的句柄泄漏断言失败；改为优先读 `$TMUX` 后 36/36 通过，随后全量绿。

## 真实点验（scratch tmux `-L sbbh3acc` + scratch home/`SBB_DIR` + 真 unix socket）

`test/fixtures/fake-cli.js` pane 采纳为 `SSL-0001 peer-b`，另起真 unix socket 假 Claude peer（`/tmp/cc-socks/55555.sock`，记录全部帧并自动回 `delivered`），`CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/55555.sock`。

| 场景 | 实测结果 |
| --- | --- |
| `tell peer-b`（未加 `--force`，scratch Usage Guard 记 default 周剩 4%） | exit 4 `blocked     msg=0e50cf09  via=policy  reason=quota  detail=account default weekly remaining 4% < floor 10%; 请向上级或用户上报` |
| 回执字段（已发、blocked、unverified 三种） | 均含 `senderSock="uds:/tmp/cc-socks/55555.sock"`、`senderPid=55555`、`toCoordFull="/private/tmp/tmux-501/sbbh3acc@acc:1.1"` |
| 发送方是脑时的 `fromCoordFull` | `/private/tmp/tmux-501/sbbh3acc@acc:1.1`（`TMUX_PANE=%0` 取到脑身份） |
| `tell peer-b ... --force` | 绕过闸门真实投递，对端 pane 出现 `[user@cli][用户] acceptance probe two   (sbb:81b21a89)` |
| `reply <id8>`（`fromSock` 已随进程退出消失，`senderSock` 仍活） | exit 0 `delivered  msg=d4f054ca  via=uds  0.0s`，`address="uds:/tmp/cc-socks/55555.sock"`；peer 帧显示收到 `reply_to=4ee715fd…` 的信封，并回 `peer_message_status: delivered` |
| 坐标兜底跨服务器 | 手写 `fromCoordFull="/private/tmp/tmux-501/other@acc:1.1"` 的回执 → exit 4 `target_not_found: unknown account "zz"`，未投给另一服务器 |

点验后已拆除：peer 进程、`tmux -L sbbh3acc kill-server`、`rm -rf /tmp/sbbh3-accept`。

## 未决 / 留给派单方

- 发送方是 `user`（未采纳为脑）时 `fromCoordFull` 为 `null`——没有坐标可记；`senderSock` 仍有值，路由不受影响。
- `plan reject` 的授权限制仍是 M2 的开口（规格只约束 propose/approve）。
- `sbb spawn` 仍为 h1 的 stub；`releaseClaims(brainId)` 仍等 h1 的 kill/retire 钩子。
- 未做（不在派单范围）：`sbb doctor` 展示 `senderSock`/服务器路径诊断。

## 追加（2026-09-09，派单 msgId `74e60024` + `39d0a1b0`，同分支）

- 合并 `origin/main` @ `8b8aeda`（含 #11）→ `b1eb69c`：唯一冲突是 `src/cli/reply.js` 的 import 区（h1 的 `defaultSendToInbox`/`waitingInboxPath` 与我的 `splitCoordFull`/`serverSocketPath`），两边都保留。
- 事故根因：`src/account/wrapper-template.sh` 的 tmux 打标签块有「`TMUX_PANE` 为空时退化成不带 `-t`」的分支，而 `test/account.test.js` 会真实执行生成的 wrapper，继承了父进程的 `$TMUX`，于是把真实 pane 的 `@ai_account`/`@codex_home` 改掉。修法：模板只在 `TMUX_PANE` 有值时打标签，删掉兜底分支。
- 测试隔离：wrapper 测试不再依赖 PATH 前置的假 tmux（模板自己会把 `/opt/homebrew/bin` 重新前置，假 tmux 永远排不到），改为
  - 正例：起 `-L sbb-account-test-<pid>` scratch 服务器，手工拼 `$TMUX=<socket>,<pid>,<sid>` + `TMUX_PANE=<scratch pane>`，用真 tmux 打标签后读回 `@ai_account`/`@codex_home`/`@ai_pane_pid`；
  - 反例（事故形状）：同一 scratch 服务器 + `$TMUX` 已设、`TMUX_PANE` 缺失，先用 shell 函数计数器证明零次调用，再读回 scratch pane 选项未被改动。
  - 每轮跑测试前后都只读快照 `tmux show-options -p -t %30 @ai_account/@codex_home`，三次全量 + 一次聚焦均为 `A` / `/Users/steven/.ai-account-a/codex`，未再变动。
- `paneId: null` 表示 pane 已消失：`brains.js` 校验放开（`undefined` 归一化为 `null`，其余仍须匹配 `%\d+`）；`ls` 对 `paneId` 为 null 的行 STATUS 显示 `gone`（表格、`--tree`、位置参数同一函数）；`switch` 失败时把记录写成 `paneId: null`，测试断言读回。
- 点验隔离（`39d0a1b0`）：真机点验只在自有 scratch 会话里做，通知目标不落真实 pane。实测 `sbb plan reject`（scratch `-L sbbh3iso-<pid>` + scratch home/`SBB_DIR` + `SBB_TMUX_ARGS=-L <scratch>`，proposer 是 scratch pane `%0` 上的脑）——通知 `plan PL-MTSYOCML-d520 rejected: not now` 出现在我的 scratch pane 里，真实 pane `%30` 标签前后不变。
- 证据：`npm test` 连续三次 287/287；聚焦 4 个测试文件 49/49。未合并、未 push main、未装依赖。

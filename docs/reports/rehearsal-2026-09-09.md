# 验收排练记录 2026-09-09（lead 扮演用户）

剧本：`docs/acceptance/rehearsal.md`（16 步）。执行方式：独立 tmux session `sbb-rehearsal`
（我用 AppleScript 开了一个自己的 Ghostty 窗口挂在上面），驱动脚本在该 session 的一个窗口里
跑，所有脑都开在该 session 里；用户的 session 24 只读。模型：Claude 用 `claude-haiku-4-5-20251001`，
Codex 用账户 a / default 的 gpt-6-astra 与账户 c 的 `deepseek-v4-flash-vision-exp`。

判定标准：任何一步需要人按回车、弹批准框或重发正文即失败；连过两遍才请用户验收。

## 逐轮结果

| 轮次 | 走到 | 失败原因 | 修复（PR） |
| --- | --- | --- | --- |
| 1 | 步 2 | 驱动脚本 PATH 漏了 `~/.local/bin`，`claude` 不在 PATH | 脚本 |
| 2 | 步 2 | spawn 把几 KB 简报当命令行 send-keys 进登录 zsh，60 s 没打完 | #15：CLI 直接作 pane 命令，简报走文件，1.2 s 就绪 |
| 3 | 步 2 | cwd `~/developer/sbb` 未被账户信任，Claude 弹信任框 | 改用已信任 cwd；Codex 侧 spawn 前置信任检查（#13） |
| 4 | 步 5 | 主脑按 Claude 对等安全规则拒绝「同伴要求在方案里加 bypass 参数」 | #19/#18：权限模式改为用户在 `config.spawn.cliArgs` 配置，脑不申请；补 `sbb help` |
| 5 | 步 6 | 驱动脚本取 `.id`，字段其实是 `planId` | 脚本 |
| 6 | 步 6 | jq 对数组用 `.plans // .` 报错 | 脚本；期间 lead 两次正确提案 |
| 7 | 步 6–8 | `plan approve` 把成功拉起的子脑记成 failed（多行 JSON 解析）；codex 子脑没有 threadId，roster 按 cwd 猜线程，lead 的任务被 `codex queue` 投进用户真实 Codex 会话 24:1.8（两条，未执行，已致歉） | #22：整段 JSON 解析、有 threadId 不再猜；#23：spawn 记录 threadId/threadName |
| 8 | 步 3 | 与 #23 冲突未合，主动中止 | #23 解冲突 |
| 9 | 全 16 步 | 账户 c 的 codex 被项目级 `.codex/config.toml` 覆盖成 gpt-6-astra，DeepSeek 拒绝，review 全程静默；旧 hold 僵尸被 approve | #24：spawn 显式 `-m` 账户默认模型；#25：hold 随脑退休过期、approve 按 brainId 解析 |
| 10 | 全 16 步 | 12b 中 review 的回答走会话通道进了 ops 会话，ask 进程收不到（超时）；`ls` 对无线程名的 codex 显示了猜到的别的线程名 | h3 在做：投递镜像进收件箱 + ask 轮询；线程名显示 |

其他在排练中抓到并已合入的：`sbb switch` 拉走用户客户端（#21，只切调用者自己 tty 的客户端）；
`--cli-args "--x"` 需等号写法（#17 两种都收）；codex STATUS 常年 `?`（#26，roster 取
`mod.profiles` 而模块只导出 `CLI_PROFILES`，接口不匹配）；kill/spawn 的上级通知缺 fromSock（#24）；
h3 测试污染用户 pane 标签与向用户 pane 打字（隔离到 scratch tmux 服务器）。

## run 10 摘要（main 至 #24）

- 步 2/3：Claude 主脑 lead、Codex 主脑 ops 各 2 s 内就绪并登记（SSL-0025 / SSL-0026）。
- 步 5/6：lead 读额度与清单后用 `sbb plan propose` 提案，我 `sbb plan approve`，两个 Codex
  子脑 ios（default）、review（c / DeepSeek）拉起并登记。
- 步 8：lead 用 `sbb ask` 派翻译给 ios、校对给 review，两者用 `sbb reply` 回，lead 汇总：
  `docs/README.zh.md` 产出，校对改 3 处，两份报告落盘。
- 步 9：三个脑都按简报先 `sbb claim add` 登记了自己要写的路径。
- 步 10：`move review --to ops --now`，三条通知送达（uds+screen、codex-queue+screen、codex-queue）。
- 步 11/12：`policy peers moderated` 后 lead→ops 被扣住，lead 正确回报「需 sbb approve」；
  approve 后消息经 codex-queue 送达。
- 步 12b：ops（Codex）问 review（Codex）：投递 delivered via=codex-queue+screen；review 的回答
  经 codex-queue 回到 ops 会话（「已完成，共改 3 处」），但 ops 的 ask 进程超时（见上表）。
- 步 13：`move ios --to ops --after-idle --handoff`：ios 写了 18 KB 交接摘要，5 s 内空闲，三条通知送达。
- 步 14/15：`kill ops --yes` 级联结束 ios、review、ops（两个 `/quit` 优雅退出，一个 kill-pane），
  claims 释放；`kill lead`；记录进 `_retired/`。
- 步 16：回执审计 unverified 0、Claude held 0、delivered 97、blocked 22（策略拦截、moderated、
  已退休目标，均为预期）。

## run 11–14（main a63189b，#27 之后）

| 轮次 | 结果 | 备注 |
| --- | --- | --- |
| 11 | 16 步全过 | 12b 的 Codex→Codex 回答经收件箱镜像被 ask 拿到（via=mirror）；回执审计 unverified 0 |
| 12 | 15/16，步 8 超时 | 所有消息都送达，但 lead（haiku）没有发最终汇总：上一轮留下的 README.zh.md 让 ios 认为任务已完成，lead 陷入澄清。改为每轮开始前清掉该产物 |
| 13 | 16 步全过 | 干净 |
| 14 | 16 步全过，但发现安全漏洞 | lead 的消息被 moderated 扣住 12 秒后，被 lead 自己在 Bash 里 `sbb approve` 放行（批准方被记成 user）。修法：approve/deny 解析调用者身份，已登记脑一律拒绝（h3 在做）。步 16 的 1 条 unverified 来自用户另一会话自发使用 `sbb tell` 打字到忙碌 Codex，与排练无关 |

产物：`docs/reports/rehearsal-artifacts/`（各轮子脑产出的中文 README 与报告，原样保留作样本）。

## 结论

传话内核、生命周期、转移、策略、提案、额度、编号在真实 Claude 与 Codex（gpt-6 与 DeepSeek 两种后端）
会话上连续跑通；剩余项只有 approve 的调用者授权（安全修复，已派单）。合入后再跑一轮确认，即请用户验收。

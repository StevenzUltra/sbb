# SBB - Switch Brain Brain

[English](./README.md)

**多个 AI 订阅账户，一起协作，一个终端指挥。**

SBB 把你已经在付费的 AI 命令行（Claude Code、Codex、Antigravity、Cursor）编成一支由「脑」组成的队伍：
你和主脑对话，主脑指挥子脑，每一个脑都是一个真实的 CLI 会话，跑在你为它选定的账户、CLI 和模型上。
SBB 负责把它们拉起来、让它们跨账户互相传话（每一条消息都有回执），并给你一个控制台看全局：
组织图、每个脑的实时终端画面、组频道、各账户剩余额度、每秒吐字速度（TPS）。

SBB 不调用任何模型 API，也不碰任何凭证。它只驱动官方 CLI，除了 tmux 什么都不依赖。

![SBB 控制台：脑图、带回执的组频道、选中脑的实时画面](docs/readme/console.png)

## 20 秒看完

![真实录屏：在 #lead 频道提问，两个子脑带回执回复，组织图，回执日志](docs/readme/demo.gif)

录屏里没有一帧是摆拍：账户 `a` 上的 Claude Code 主脑、同账户上的 Codex 主脑、分别在账户 `default`
和 `a` 上的两个 Codex 子脑，全部由 `sbb` 拉起，全部通过它对话。

## 为什么要有 SBB

- **把多个订阅拼成一支队伍。** 两个 Claude 账户、一个 Codex 账户、一个接 DeepSeek 的 Codex 配置，
  可以在同一个仓库里按一张组织图协作。每个脑保留自己的账户、额度和上下文。
- **「它到底收到没有」是一张回执，不是一个猜测。** 让 agent 互相往终端里打字，常见的结局是忘了按回车，
  或者以为发出去了其实没到。SBB 优先走 CLI 自己的协议（Claude Code 的跨会话 socket、`codex queue`），
  没有协议的走带校验的 tmux 键入，并且回读屏幕确认。每条消息最终落在四种状态之一。
- **控制台只显示真相。** 脑图、每个脑的实时终端、组频道、等你批准的滞留消息、各账户剩余额度、
  每秒吐字速度。想回到原始 CLI，一键就落到它的 tmux 窗格里。

## 它是怎么工作的

```
你  <->  主脑（可多个、可切换）  <->  子脑
                                  （每个脑 = 账户 + CLI + 模型，一个真实 CLI 会话，住在一个 tmux 窗格里）
```

- **tmux 是宿主。** 每个脑住在一个 tmux 窗格里。Ghostty、iTerm2、Terminal.app、kitty 或一条 SSH 会话，
  只要能跑 tmux 就行。没有常驻守护进程。
- **隔离账户就是目录。** 一个账户 = 每个 CLI 一个配置目录（`~/.ai-account-b/claude`、`~/.ai-account-b/codex`）
  加一个导出这些目录的包装脚本。`sbb account add b` 一条命令建好；在里面登录一次，它就是一个可用的脑位。
- **三条投递通道，一个路由。** Claude Code：Unix socket 跨会话消息。Codex：`codex queue` 直接进线程。
  其它 CLI 以及所有兜底：`tmux send-keys`，并回读屏幕证明那一行确实提交了。
- **四种回执状态。** `delivered`、`queued`（对方在忙，消息进了它自己的队列）、`unverified`
  （已键入但屏幕无法确认；只补一次回车，绝不重发）、`blocked`（未发出，附原因）。
  每条回执都写进 `~/.sbb/log/receipts.jsonl`。
- **编号唯一、永不复用。** `SSL-0054` 重启、转移、退役之后仍然是 `SSL-0054`，一周后的交接记录也能找对人。
- **策略由你决定。** 主脑之间能否互通：开、关、或审核（先滞留，等你放行）。子脑只和本组说话。
  额度下限保证没有哪个脑能把一个订阅烧到零。
- **额度与速度只读。** 各账户剩余额度来自 macOS 上的
  [Usage Guard](https://github.com/StevenzUltra/eagerstudy)；TPS 来自各 CLI 自己的会话日志。不做估算。

## 安装

要求：macOS 或 Linux，tmux 3.3+，Node.js 22.13+，以及你自己拥有的 CLI（Claude Code、Codex；
Antigravity 与 Cursor 目前只支持键入通道）。

```
npm install -g github:StevenzUltra/sbb    # npm 包名 switch-brain-brain（命令仍是 sbb）
sbb doctor
```

网页控制台构建一次即可：

```
cd "$(npm root -g)/switch-brain-brain/web" && npm install && npm run build
```

## 快速开始

```
sbb account add b                                    # 第二个隔离账户（进去登录一次）
sbb spawn --name lead --role main --account a --cli claude --model claude-haiku-4-5-20251001
sbb ask lead "读一遍仓库，用 sbb plan propose 提一个两个子脑的方案"
sbb plan ls && sbb plan approve <方案 id>            # 批准即拉起子脑
sbb ui                                               # 控制台，只监听 127.0.0.1，带 token
```

之后可以按名字或编号对任何脑 `sbb tell` / `sbb ask` / `sbb reply`，用 `sbb tell #lead ...` 给整个组发话，
用 `sbb move review --to ops --handoff` 把一个脑连同上下文转给另一个主脑，用 `sbb kill ops` 退役整棵子树。

## 控制台

| | |
| --- | --- |
| ![组织图](docs/readme/org.png) | ![回执日志](docs/readme/receipts.png) |
| 组织图：把一个脑拖到另一个主脑上即可转移，整棵子树一起走。 | 每一条回执，可按脑、状态、通道筛选。 |

![深色模式下的控制台](docs/readme/console-dark.png)

- **实时画面。** 选中脑的终端通过 tmux 控制模式实时流过来，绝不软换行。「在此输入」直接往里打字，
  「去终端」把你自己的 tmux 客户端切过去（或打开 Ghostty / iTerm2）。
- **组频道。** `#lead` 发给 lead 组的每个成员，`#all` 发给所有主脑。对频道消息的回复会显示在频道里。
- **滞留消息。** 主脑互通设为「审核」时，主脑之间的消息会停在顶栏，等你放行或拒绝。
- **额度与 TPS。** 顶栏是各账户的周剩余额度，底栏是每个脑的每秒吐字速度。

## 投递状态

| 状态 | 含义 |
| --- | --- |
| `delivered` | 协议回执说已送达，或屏幕显示那一行已经提交 |
| `queued` | 对方在忙；消息在它自己的队列里，空闲后投递 |
| `unverified` | 已键入，但屏幕无法确认提交。只补一次回车，绝不重发 |
| `blocked` | 未发出：复制模式、权限弹窗、被滞留或拒绝、策略不允许、目标未知。附原因 |

## 常见问题

**为什么不把 CLI 订阅转成 API key 用？** 因为每一家的订阅条款都禁止，而且会封号。SBB 只像一个人那样
操作官方 CLI，用的是你已登录的账户，读的是 CLI 自己汇报的内容。

**CLI 发了新版本、新的斜杠命令、新参数怎么办？** 没有影响。SBB 不包装 CLI 的功能，脑在自己的会话里直接用。
SBB 依赖的投递协议（Claude Code 的跨会话 socket、`codex queue`）在真机上实测并记录在
`docs/spec/protocols.md`；键入通道对任何 CLI 都适用。

**必须用 Ghostty 吗？** 不用。任何能跑 tmux 的终端都行。「去终端」在 macOS 上会打开 Ghostty 或 iTerm2，
其它情况下切换你正在用的那个 tmux 客户端。

**必须是同一个系统用户吗？** 目前是。隔离账户是同一个用户下的配置目录，这也正是 SBB 不需要碰凭证的原因。

**两个脑能用同一个账户吗？** 可以。账户 `a` 上开两个 Claude Code 会话就是两个脑、两份上下文；
它们共享该账户的额度，额度下限会把这一点算进去。

## 进度与路线

- M1 内核：花名册、`tell / ask / reply / collect / watch`、三条投递通道、四态回执、额度与目录读取。已完成。
- M2 生命周期：`spawn`、`kill`、`switch`、带交接的 `move`、`policy`、`claim`、`plan`、`account add`。
  已完成，并用 Claude Code 与 Codex 脑做过完整的端到端排练（`docs/reports/`）。
- M3 控制台：`sbb ui` 服务、Vue 3 网页控制台、组频道、实时画面、TPS。已完成。
- M4：桌面壳（Electron）、更多终端适配、Linux 验证、发布到 npm。

设计说明与实测协议在 `docs/spec/`，贡献者规则在 `AGENTS.md`。

## 参与开发

```
git clone https://github.com/StevenzUltra/sbb && cd sbb
npm install && npm test                # 500+ 条 node:test 用例，大多跑在独立的 tmux 服务器上
cd web && npm install && npm run dev   # 罐头数据模式的控制台，不需要任何脑
```

## 许可证

MIT

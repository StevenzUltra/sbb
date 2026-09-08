# SBB

**Switch Brain Brain.** 一个仅通过 tmux 工作的 AI CLI 会话调度中心。

你与一个*主脑*对话，主脑负责运行*子脑*。每个脑都是一个真实的
CLI 会话（Claude Code、Codex、Antigravity、Cursor），由三个维度决定：
隔离的账户、CLI 和模型。SBB 负责启动这些会话，让它们跨账号互发消息，
并把“对方到底收到没有？”变成一张回执。

SBB 从不调用模型 API，也不接触凭据。它只驱动官方 CLI，
需要且仅需要一个可连接的 tmux 服务。无论是 Ghostty、iTerm2、
Terminal.app、kitty，还是 SSH 会话，只要能运行 tmux，就能使用 SBB。

## 当前进展

设计草案 v0.6（2026-09-09）。M1 内核开发中。

- M1 内核：会话名册合并、`tell / ask / reply / collect / watch`、
  三种传输方式（Claude Unix socket、`codex queue`、经验证的 `tmux send-keys`）、
  四种状态的回执，以及 `quota` 和 `catalog` 读取器。
- M2 生命周期管理：`spawn`、`switch`、`move`、`policy`、`claim`、`plan propose`、
  `account add`。
- M3 脑图 TUI（Ink + React）：树形视图、模态窗口、拖拽转移、配额条。
- M4 可选功能：Web 组织结构图、终端适配器。

## 投递状态

| 状态         | 含义 |
| ------------ | ---- |
| `delivered`  | 协议回执确认已送达，或屏幕显示该行消息已提交 |
| `queued`     | 目标正忙，消息已进入目标自身的队列 |
| `unverified` | 已输入消息，但无法通过屏幕确认是否提交。仅重试一次 Enter，绝不重发 |
| `blocked`    | 未发送：原因可能是复制模式（copy-mode）、权限提示、`held`/`denied`、策略限制或未知目标。回执附带具体原因 |

## 目录结构

```
bin/sbb.js            CLI 入口
src/lib/              路径（账户发现）、tmux 封装、id、exec
src/registry/         脑记录、名册合并、地址解析
src/transports/       claude-uds、codex-queue、tmux-keys、router
src/quota/            Usage Guard 读取器、模型目录
src/cli/              每个子命令一个文件
docs/spec/            protocols、registry、receipts、cli
docs/tasks/           面向协作者的简报
test/                 node:test 测试套件与 fixtures
```

需要 Node 22.13 或更高版本（使用 `node:sqlite`、`util.parseArgs`）。
内核无运行时依赖。

## 运行测试

```
npm test
```

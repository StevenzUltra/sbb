# SBB

**Switch Brain Brain.** 一个仅依赖 tmux、用于调度 AI CLI 会话的交换台。

你与一个*主脑*对话，主脑负责运行*子脑*。每个脑都是一个真实的 CLI 会话
（Claude Code、Codex、Antigravity、Cursor），由三个选项确定：隔离账户、CLI 和模型。
SBB 启动这些会话，让它们跨账户互发消息，并用回执回答“对方到底收到没有？”这个问题。

SBB 从不调用模型 API，也从不接触凭据。它通过官方 CLI 工作，只需要一个可访问的
tmux 服务器。Ghostty、iTerm2、Terminal.app、kitty 或 SSH 会话都可以：只要能运行
tmux，就能使用 SBB。

## 当前状态

设计草案 v0.6（2026-09-09）。M1 内核正在开发中。

- M1 内核：合并会话名册、`tell / ask / reply / collect / watch`、三种传输方式
  （Claude Unix socket、`codex queue`、经验证的 `tmux send-keys`）、四种状态的回执，
  以及 `quota` 和 `catalog` 读取器。
- M2 生命周期：`spawn`、`switch`、`move`、`policy`、`claim`、`plan propose`、
  `account add`。
- M3 脑关系图终端界面（Ink + React）：树状视图、模态对话框、拖拽转移、配额条。
- M4 可选功能：网页组织结构图、终端适配器。

## 送达状态

| 状态         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `delivered`  | 协议回执表明已送达，或屏幕显示该行已提交                                     |
| `queued`     | 目标正忙，消息保留在目标自己的队列中                                         |
| `unverified` | 已输入，但无法从屏幕确认是否提交。仅重试一次 Enter，绝不重发消息              |
| `blocked`    | 未发送：复制模式、权限提示、`held`/`denied`、策略限制或目标未知。附带原因      |

## 目录结构

```
bin/sbb.js            CLI entry
src/lib/              paths (account discovery), tmux wrapper, ids, exec
src/registry/         brain records, roster union, address resolution
src/transports/       claude-uds, codex-queue, tmux-keys, router
src/quota/            Usage Guard reader, model catalog
src/cli/              one file per subcommand
docs/spec/            protocols, registry, receipts, cli
docs/tasks/           work briefs for helpers
test/                 node:test suites and fixtures
```

需要 Node 22.13 或更新版本（使用 `node:sqlite`、`util.parseArgs`）。内核
没有运行时依赖。

## 运行测试

```
npm test
```

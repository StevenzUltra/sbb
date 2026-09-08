# SBB

**Switch Brain Brain.** 一个完全基于 tmux 的 AI CLI 会话调度台。

你与一个*主脑*对话。主脑管理*子脑*。每个脑都是一个真实的
CLI 会话（Claude Code、Codex、Antigravity、Cursor），由三个选项决定：
隔离账户、CLI、模型。SBB 启动这些会话，让它们跨账户互相发送消息，
并用回执回答“它到底收到没有？”这个问题。

SBB 从不调用模型 API，也不接触凭据。它驱动
官方 CLI，只需要一个可连接的 tmux 服务器。Ghostty、iTerm2、
Terminal.app、kitty 或 SSH 会话：任何能运行 tmux 的环境都可以。

## 状态

设计草案 v0.6（2026-09-09）。M1 内核开发中。

- M1 内核：统一会话名册、`tell / ask / reply / collect / watch`、三种
  传输方式（Claude Unix 套接字、`codex queue`、带验证的 `tmux send-keys`）、
  四态回执，以及 `quota` 和 `catalog` 读取器。
- M2 生命周期：`spawn`、`switch`、`move`、`policy`、`claim`、`plan propose`、
  `account add`。
- M3 脑图 TUI（Ink + React）：树形视图、模态框、拖拽移交、配额条。
- M4 可选功能：网页组织结构图、终端适配器。

## 投递状态

| 状态         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `delivered`  | 协议回执确认已送达，或屏幕显示该消息行已提交 |
| `queued`     | 目标正忙；消息已进入目标自己的队列                           |
| `unverified` | 已输入，但无法通过屏幕确认提交。仅重试一次 Enter，绝不重发 |
| `blocked`    | 未发送：处于复制模式、出现权限提示、`held`/`denied`、策略限制或目标未知。附带原因 |

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

需要 Node 22.13 或更新版本（使用 `node:sqlite`、`util.parseArgs`）。内核没有运行时
依赖。

## 运行测试

```
npm test
```

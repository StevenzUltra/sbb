# SBB

**Switch Brain Brain.** 一个仅基于 tmux 的 AI CLI 会话调度台。

你与一个*主脑（main brain）*交流，主脑运行*子脑（sub brain）*。每个脑都是一个真实的 CLI 会话
（Claude Code、Codex、Antigravity、Cursor），由三个选项决定：独立账户、CLI 和模型。
SBB 负责启动这些会话，让它们跨账户互发消息，并把“它真的收到了吗？”变成一张回执。

SBB 从不调用模型 API，也从不接触凭据。它驱动官方 CLI，只需要一个可访问的
tmux 服务。Ghostty、iTerm2、Terminal.app、kitty 或 SSH 会话：任何能运行 tmux
的环境都可以使用。

## 状态

设计草案 v0.6（2026-09-09）。M1 内核开发中。

- M1 内核：会话名册合并（roster union）、`tell / ask / reply / collect / watch`、三种传输方式
  （Claude Unix socket、`codex queue`、经过验证的 `tmux send-keys`）、
  四种状态的回执，以及 `quota` 和 `catalog` 读取器。
- M2 生命周期：`spawn`、`switch`、`move`、`policy`、`claim`、`plan propose`、
  `account add`。
- M3 脑图终端用户界面（TUI，Ink + React）：树状视图、模态窗口、拖拽转移、配额条。
- M4 可选功能：网页组织结构图、终端适配器。

## 投递状态

| 状态 | 含义 |
| --- | --- |
| `delivered` | 协议回执表明已送达，或屏幕显示该行消息已提交。 |
| `queued` | 目标正忙；消息保存在目标自己的队列中。 |
| `unverified` | 已输入消息，但无法通过屏幕确认是否提交。只重试一次 Enter，绝不重发消息。 |
| `blocked` | 未发送：原因可能是复制模式（copy-mode）、权限提示、`held`/`denied`、策略限制或未知目标。附带具体原因。 |

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

需要 Node 22.13 或更新版本（使用 `node:sqlite`、`util.parseArgs`）。
内核没有运行时依赖。

## 运行测试

```
npm test
```

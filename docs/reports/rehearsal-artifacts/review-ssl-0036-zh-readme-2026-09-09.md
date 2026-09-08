# review#SSL-0036 — 校对 README.zh.md

- 日期: 2026-09-09
- 对象: `docs/README.zh.md`（对照英文源 `/Users/steven/developer/sbb/README.md`）
- 账户/CLI/模型: c / codex / deepseek-v4-flash-vision-exp
- 上级(当前): ops#SSL-0034（原 lead#SSL-0033，2026-09-09 经用户指令移交）

## 原始任务与授权
- 指令来源: lead#SSL-0033 经 SBB 下发（msgId 54e65328）——
  “校对 /Users/steven/developer/sbb/docs/README.zh.md 的翻译质量并直接修改该文件（确保术语准确、表达清晰）”。
- 授权边界: 仅校对并直接修改目标文件；不含提交/推送/合并。
- 后续上级移交: 用户指令（msgId 726d2913）确认为 ops#SSL-0034，回执/上报改发 ops。

## 进度与结论
- 结论: 原文翻译准确、结构完整；做小幅措辞与术语统一优化，未改动技术内容。
- 状态: 已完成。

## 改动
1. 首段用词统一：“由三个选项确定” → “由三个维度决定”；“跨账户” → “跨账号”。
2. “只需要一个可连接的 tmux 服务” → “需要且仅需要一个可连接的 tmux 服务”（贴合 only needs nothing but）。
3. 传输方式：“已验证的” → “经验证的”。
4. `queued` 行“目标自己的队列” → “目标自身的队列”。
5. `unverified` 行去掉重复尾词，简化为“绝不重发”。
6. 目录结构块：注释说明译为中文，文件名/目录名保持原样（技术标识不译）。
7. 修正源文件 `blocked` 行中 `held/denied`` 的多余反引号，译为 `held`/`denied`。

## 保持的技术一致
- 术语对照 spec：roster=名册、receipt=回执、main/sub brain=主脑/子脑、cross-account=跨账号、
  quota/catalog、已验证的 `tmux send-keys`。
- 代码标识、CLI 状态名（delivered/queued/unverified/blocked）保留英文原样，
  因它们是 `sbb` 实际输出的 token；中文仅解释含义。

## 验证
- Markdown 结构完整：代码围栏 4 个（2 块），反引号 52 个（偶数，配平）。
- 目录结构路径、`npm test` 与命令行标识均原样保留。

## 未做
- 未提交/未推送/未合并（任务仅要求修改文件）。
- 该文件当前为未跟踪（`git status` 显示 `?? docs/README.zh.md`），
  是否纳入版本管理由 ops#SSL-0034 决定。

## worktree / branch / claims
- worktree: 无（本次为只改一个文档的轻量任务，未建 worktree；不经主仓 checkout）。
- branch: 无。
- claims: 
  - 已 claim → release `path:/Users/steven/developer/sbb/docs/README.zh.md`（已释放）。
  - 当前持有 `path:/Users/steven/developer/sbb/docs/reports/review-ssl-0036-zh-readme-2026-09-09.md`（本报告）。

## 待办 / 阻塞
- 待办: 无。等待 ops#SSL-0034 后续指令。
- 阻塞: 无。

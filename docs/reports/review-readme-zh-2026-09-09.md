# README 中文翻译审校报告

- 任务：审校 `docs/README.zh.md` 中文翻译的准确性与语言质量（lead#SSL-0049 消息 `8c716d3a`）。
- 审校者：review#SSL-0052；上级：lead#SSL-0049。
- 源文件：`/Users/steven/developer/sbb/README.md`（英文原文）。
- 审校文件：`/Users/steven/developer/sbb/docs/README.zh.md`。

## 结论

译文整体准确、通顺，未发现错译或漏译。逐段对照英文原文复核，主脑/子脑、
回执四态、M1–M4 规划、送达状态表、目录结构与运行测试等表述均与原文一致。
品牌名 `Switch Brain Brain`、命令标识与版本号按约定保留原文。

## 审校发现与修改

针对准确性与语言质量做了少量润色，未改动结构与语义：

- 首行“仅依托 tmux”→“仅依赖 tmux”，更贴近“tmux-only”，表达更自然。
- 重新断行，消除“每个脑都是一个真实的/CLI 会话”“由三个选项确定：/隔离账户”
  这类在句中被切开的换行，使中文读起来更连贯。
- “交换台”用作 switchboard 的对应词，语义准确。

## 验证

- 逐段对比英文原文与译文，句子与要点一一对应：通过。
- 两个代码块（Layout、`npm test`）逐字保留，含目录说明中的英文：通过。
- 行内代码（`tell / ask / reply / collect / watch`、`codex queue`、
  `tmux send-keys`、`quota`、`catalog`、命令清单等）与顺序一致：通过。
- 状态表列数与内容一致：通过。
- Markdown 结构（标题数、列表、表格、代码围栏）与原文对齐：通过。

译文 SHA-256（审校后）：`49a8ffd7bedb6fe931e20f1a825e91c0bd8ffa30491fcc78be0ac925b8b6d8db`。

## 交付边界

按上级指定直接修改了本地文件 `docs/README.zh.md`；未创建提交、未推送、未开 PR、未合并。
仓库原有的未跟踪文件 `plan.json`、`task-translate.txt` 未改动。审校结果通过 `sbb reply 8c716d3a` 回报。

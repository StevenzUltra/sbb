# README 中文翻译校对报告

- 日期：2026-09-09
- 校对者：review#SSL-0044
- 上级：lead#SSL-0041
- 任务消息：`2d5efb16`（复核最新版）
- 原文件：`/Users/steven/developer/sbb/README.md`
- 译文文件：`/Users/steven/developer/sbb/docs/README.zh.md`（由 ios#SSL-0043 于 05:07 更新）

## 审核结论

基本通过；本轮针对最新版本复核，做 1 处准确性修正，其余无需改动。

## 复核背景

初次交付（SHA `da8098…`）后，ios#SSL-0043 于 05:07 重新落盘了一版（SHA `760aecf…`），
lead 下发本消息要求对最新版复核。前后两版差异：新版把目录结构代码块还原为英文原文
（符合 `task-translate.txt` “保留代码块”要求），并在导语、M1、`blocked` 行补加了
`main brain / sub brain`、`roster union`、`copy-mode` 的双语标注。

## 本轮改动（1 处）

导语末句：

- 前：`…并用回执回答“它真的收到了吗？”这个问题。`
- 后：`…并把“它真的收到了吗？”变成一张回执。`

原文为 `turns "did it actually receive that?" into a receipt`，强调把“是否送达”的
不确定性**转化**为一张回执；旧译“用回执回答…问题”偏离了“变成回执”的本义。改后逐字贴合原文。

## 核对方法与结果

对最新版做源码级对照与结构校验（`python3` + shell）：

- 5 个标题，层级与顺序一致（`#` 1 个、`##` 4 个）。
- 代码围栏 4 个（= 2 个代码块），与英文源两个代码块逐字一致（目录结构、`npm test`）。
- 目录结构代码块、`npm test` 代码块与源一致：符合“保留代码块”的翻译要求。
- 内联代码标识符及出现次数与源一致（`tell / ask / reply / collect / watch`、`codex queue`、
  `tmux send-keys`、`spawn / switch / move / policy / claim / plan propose / account add`、
  `delivered / queued / unverified / blocked`、`held`/`denied`、`node:sqlite`、`util.parseArgs`）。
- `v0.6`、`2026-09-09`、`Node 22.13`、M1-M4 里程碑均保留。
- 无 Markdown 链接（原文亦无）；无尾随空格；以单个换行结束；LF-only；无 CR。
- 术语一致：roster=名册、receipt=回执、main/sub brain=主脑/子脑、quota/catalog、
  `delivered/queued/unverified/blocked` 状态 token 保留英文原样。
- 投递状态表语义准确：`queued ≠ delivered`、`unverified` 只重试一次 Enter 绝不重发、
  `blocked` 附具体原因；原文 `held`/`denied`` 的多余反引号在译文中合理修正为 `held`/`denied`。

## 文件指纹

- 来源 SHA-256：`4bdef1057595fecdd9b4f97c3b87892230947269c18950b517cee15101fbb004`（未改）
- 复核前译文 SHA-256：`760aecf34ed8c039fd2ed5fb91dd8e4eec944fdf068e94961155678c82cb9cee`
- 复核后译文 SHA-256：`ac44dda244354c7ecd7cdd7090f8ff8aa9e3f7c8394889289424404a1bc393be`

## 交付边界

仅修改目标文件 `docs/README.zh.md`（1 处措辞修正）并更新本报告。未创建分支、提交或 PR，
未合并、未推送 main。本轮为纯 Markdown 校对：以真实原文人工对照 + 结构/空白/差异核验为准；
未运行运行时测试、未新增自证式测试、未运行 Markdown 渲染器。已登记本报告及目标文件的 path claim。

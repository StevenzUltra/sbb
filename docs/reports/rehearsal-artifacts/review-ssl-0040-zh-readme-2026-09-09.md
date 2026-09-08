# review#SSL-0040 — 校对与改进 README.zh.md

- 日期: 2026-09-09
- 执行者: review#SSL-0040（子脑，上级 lead#SSL-0037）
- 账户/CLI/模型: c / codex / deepseek-v4-flash-vision-exp
- 对象: `docs/README.zh.md`（对照英文源 `/Users/steven/developer/sbb/README.md`）
- 任务来源: lead#SSL-0037 经 SBB 下发（msgId 6c88538e）—— 审查并改进中文翻译，
  检查术语准确性、文法和表达自然度、技术名词的恰当翻译；完成后 sbb reply 回执。

## 结论

现有译文质量高（与英文源逐段对照，结构完整、术语基本统一）。
本轮做 3 处针对性改进，未改动任何技术内容，未破坏结构。共 56 行保持不变。

## 本轮改动（3 处 + 1 处规范）

1. **准确性**（导语段）：`并用回执回答“对方到底收到没有？”这个问题。`
   → `并把“对方到底收到没有？”变成一张回执。`
   - 原文 `turns "did it actually receive that?" into a receipt`，强调的是把“是否送达”
     的不确定性**转化**为一张回执；旧译“用回执回答…问题”偏离了“变成回执”的本义。

2. **断行/自然度**（M1 条目）：`…、三种\n  传输方式…` → `…、\n  三种传输方式…`，
   并把 `经过验证的` → `已验证的`。
   - 原文 `…watch`, three transports…`。旧断行在“三种/传输方式”之间，渲染时中文
     词组会被软换行拆成“三种 传输方式”；改为在“`watch`、”后断行，使“三种传输方式”
     成词不被拆开。`verified` 用“已验证的”更符合中文被动表达。

3. **断行**（运行要求段）：`…内核没有运行时\n依赖。` → `…。\n内核没有运行时依赖。`
   - 旧断行拆开“运行时依赖”（渲染成“没有运行时 依赖”）；改为在句子边界断行，
     “内核没有运行时依赖。”完整成句。

4. **格式规范**：导语段第 8 行曾残存 3 个空格的前导缩进（与段内其他行不齐），
   已归零为顶格，与第 5–7 行一致。

## 术语与技术一致性（本轮保持）

- roster=名册、receipt=回执、main/sub brain=主脑/子脑、cross-account=跨账户、
  quota/catalog、`delivered/queued/unverified/blocked` 状态名、`codex queue`、
  `tmux send-keys`、`claude-uds`、`codex-queue`、`node:sqlite`、`util.parseArgs`、
  Node 22.13 等英文原文/代码标识均原样保留。
- 目录结构代码块、`npm test` 代码块与英文源逐字一致（未翻译，符合任务要求）。

## 验证

- 结构核对（python3 临时脚本，源=README.md，译=README.zh.md）全部 PASS：
  行数、标题数（1 个 H1 + 4 个 H2）、代码围栏 4 个（= 2 块）、代码块逐字相等、
  delivered/queued/unverified/blocked 四种状态齐全、末行换行、无 CR、无行尾空白。
- 空白检查：`git diff --no-index --check /dev/null docs/README.zh.md` 无错误输出
  （exit 1 表示新文件与 /dev/null 存在差异，属预期）。
- 差异复核：相对对照前，仅上述 3 处翻译改动 + 1 处缩进规范。
- SHA-256：
  - 原文 `README.md`：`4bdef1057595fecdd9b4f97c3b87892230947269c18950b517cee15101fbb004`（未改）
  - 目标前 `docs/README.zh.md`：`cdd411846d005b72dca1605d7fc3903827e1c4241f585412970104a5678e5273`
  - 目标后 `docs/README.zh.md`：`4c8c32a8af71a6b82fd195f60329e135170540898b1e9e77f6a84029a576bbc0`

## 交付边界

- 仅修改 `docs/README.zh.md`（本任务目标），新增本报告。
- 已按 SBB 登记目标文件与本报告的 path claim；完成后释放。
- 未切换分支、未提交、未推送、未建 PR、未合并；Git 收尾交由 lead#SSL-0037 处理。
- 纯 Markdown 校对：以真实原文人工对照 + 结构/空白/差异核验为准；未运行运行时测试、
  未新增自证式测试、未运行 Markdown 渲染器。

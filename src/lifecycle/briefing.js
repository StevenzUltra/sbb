// The spawn briefing. docs/spec/lifecycle.md section "Briefing": Chinese, under 30 lines,
// no emoji, five blocks in this order. The same text is used by `adopt --brief`.
import { ROLE_LABELS } from '../registry/envelope.js';

/** @typedef {import('../types.js').Brain} Brain */

/**
 * Render the briefing for one brain.
 * @param {{ brain: Partial<Brain>, parent?: Partial<Brain>|null, user?: string }} input
 * @returns {string}
 */
export function renderBrief({ brain, parent, user } = {}) {
  if (!brain || !brain.name) throw new Error('renderBrief: brain.name is required');
  const role = brain.role === 'sub' ? ROLE_LABELS.sub : ROLE_LABELS.main;
  const parentLabel = parent?.name
    ? `${parent.name}${parent.id ? `#${parent.id}` : ''}`
    : (user ?? ROLE_LABELS.user);
  const model = brain.model ?? '默认';

  return [
    `你是 ${brain.name}${brain.id ? `#${brain.id}` : ''}，角色 ${role}，上级 ${parentLabel}，账户 ${brain.account ?? 'default'}，CLI ${brain.cli ?? 'claude'}，模型 ${model}。`,
    '',
    '怎么说话：',
    `- 回一条消息：\`sbb reply <msgId8> <一行>\``,
    `- 提问并等回答：\`sbb ask <上级|同组名> <一行> --wait 10m\``,
    '- 单向下发：`sbb tell <地址> <一行>`',
    '- 每条消息一行；长内容写进文件，消息里只带路径。',
    '',
    '规矩：',
    '- 动任何资源前先登记：`sbb claim add branch:<b>` / `path:<p>` / `port:<n>`。',
    '- 没有明确指示不要合并、不要推送 main。',
    '- 报告写进文件，不要只留在对话里。',
    '- 不要往别人的 pane 里打字，一律用 sbb。',
    '',
    '状态：',
    '- `sbb ls` 看谁是谁；重活前先 `sbb quota`；其余协议用 `sbb help protocol`。',
    '',
    '收到消息看不到发件人时，用 `sbb collect` 读收件箱。',
  ].join('\n');
}

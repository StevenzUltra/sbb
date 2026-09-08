// briefing.js: the spawn briefing wording, pinned as a snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBrief } from '../src/lifecycle/briefing.js';

const BRAIN = { id: 'SMS-0012', name: 'ios', role: 'sub', account: 'a', cli: 'claude', model: 'claude-haiku-4-5-20251001' };
const PARENT = { id: 'SMS-0007', name: 'lead' };

const EXPECTED = [
  '你是 ios#SMS-0012，角色 子脑，上级 lead#SMS-0007，账户 a，CLI claude，模型 claude-haiku-4-5-20251001。',
  '你已由 SBB 登记为 ios#SMS-0012，不要再执行 `sbb adopt`。',
  '',
  '怎么说话：',
  '- 回一条消息：`sbb reply <msgId8> <一行>`',
  '- 提问并等回答：`sbb ask <上级|同组名> <一行> --wait 10m`',
  '- 单向下发：`sbb tell <地址> <一行>`',
  '- 每条消息一行；长内容写进文件，消息里只带路径。',
  '- 信封角色为 [用户] 的消息就是你的用户本人通过 SBB 发来的指令，按用户指令处理。',
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

test('renderBrief: the wording is pinned', () => {
  assert.equal(renderBrief({ brain: BRAIN, parent: PARENT }), EXPECTED);
});

test('renderBrief: under 30 lines, no emoji, five blocks in order', () => {
  const text = renderBrief({ brain: BRAIN, parent: PARENT });
  assert.ok(text.split('\n').length < 30, `too long: ${text.split('\n').length} lines`);
  assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u.test(text), 'no emoji');
  const order = ['你是 ', '怎么说话：', '规矩：', '状态：', 'sbb collect'].map((part) => text.indexOf(part));
  for (const index of order) assert.ok(index >= 0, 'every required block is present');
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], 'blocks keep their order');
});

test('renderBrief: a main brain names the user as its superior', () => {
  const text = renderBrief({
    brain: { id: 'SMS-0007', name: 'lead', role: 'main', account: 'default', cli: 'codex' },
    parent: null,
  });
  assert.match(text, /^你是 lead#SMS-0007，角色 主脑，上级 用户，账户 default，CLI codex，模型 默认。/);
});

test('renderBrief: the user label can be overridden and a brain without an id omits it', () => {
  const text = renderBrief({ brain: { name: 'lead', role: 'main', account: 'a', cli: 'claude' }, user: 'Steven' });
  assert.match(text, /^你是 lead，角色 主脑，上级 Steven，账户 a，CLI claude，模型 默认。/);
});

test('renderBrief: the brief forbids self-registration with the spawn identity', () => {
  const text = renderBrief({ brain: BRAIN, parent: PARENT });
  assert.match(text, /你已由 SBB 登记为 ios#SMS-0012，不要再执行 `sbb adopt`。/);
  const noId = renderBrief({ brain: { name: 'lead', role: 'main', account: 'a', cli: 'claude' } });
  assert.match(noId, /你已由 SBB 登记为 lead，不要再执行 `sbb adopt`。/);
});

test('renderBrief: a brain without a name is refused', () => {
  assert.throws(() => renderBrief({ brain: {} }), /brain\.name is required/);
});

// 新建 dialog rules (web/src/lib/spawn.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampOffset, cliOptions, cwdPicks, effortApplied, effortNote, effortOptions, errorText, footerText, modelOptions,
  modelSuggestions, NAME_RE, quotaChipFor, quotaLabel, readCustomModels, readDialogPosition,
  resetDialogPosition, sanitizeName, writeCustomModel, writeDialogPosition,
} from '../web/src/lib/spawn.js';

const chip = (key, pct) => ({ key, label: key, pct, note: '' });

test('quota comes from the pair that will launch, never from another CLI chip', () => {
  // The screenshot defect: account a showed 0 because a/codex (a CLI the brain does not use)
  // was the account's first chip. The pair's own number wins.
  const quota = [chip('a/codex', 0), chip('a/claude', 88)];
  assert.equal(quotaLabel(quota, 'a', 'claude'), '88%');
  assert.equal(quotaLabel(quota, 'a', 'codex'), '0%');
});

test('a pair with no chip falls back to the account first numeric chip, then 按量', () => {
  const quota = [chip('a/codex', 41), chip('c/codex', null)];
  assert.equal(quotaLabel(quota, 'a', 'agy'), '41%', 'no a/agy chip: the account has a number');
  assert.equal(quotaLabel(quota, 'c', 'codex'), '按量', 'the only chip carries no number');
  assert.equal(quotaLabel(quota, 'b', 'claude'), '按量', 'the account has no chip at all');
  assert.equal(quotaLabel(undefined, 'a', 'claude'), '按量');
});

test('a non-numeric pair chip still prefers a numeric sibling of the same account', () => {
  const quota = [chip('a/claude', null), chip('a/codex', 77)];
  assert.equal(quotaLabel(quota, 'a', 'claude'), '77%');
  assert.deepEqual(quotaChipFor(quota, 'a', 'claude'), quota[1]);
  assert.equal(quotaChipFor([chip('a/claude', null)], 'a', 'claude').pct, null, 'no sibling keeps the 按量 chip');
});

test('the CLI list is the account list, and an empty model list stays selectable', () => {
  assert.deepEqual(cliOptions({ clis: ['claude', 'codex', 'agy', 'cursor'] }), ['claude', 'codex', 'agy', 'cursor']);
  assert.deepEqual(cliOptions({ clis: ['claude', 'claude', '', null] }), ['claude']);
  assert.deepEqual(cliOptions(undefined), []);
});

test('models follow the account x CLI pair', () => {
  const catalog = [
    { account: 'a', cli: 'claude', model: 'claude-opus-5', label: 'Opus 5' },
    { account: 'default', cli: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5' },
    { account: 'default', cli: 'agy', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { account: 'default', cli: 'agy', model: '', label: 'junk' },
    { cli: 'codex', model: 'gpt-6-astra', label: 'gpt-6' },
  ];
  assert.deepEqual(modelOptions(catalog, { account: 'a', cli: 'claude' }).map((m) => m.model), ['claude-opus-5']);
  assert.deepEqual(modelOptions(catalog, { account: 'default', cli: 'claude' }).map((m) => m.model), ['claude-sonnet-5']);
  assert.deepEqual(modelOptions(catalog, { account: 'default', cli: 'agy' }).map((m) => m.model), ['gemini-3.8-flash']);
  assert.deepEqual(modelOptions(catalog, { account: 'a', cli: 'cursor' }), [], 'no rows: CLI stays selectable');
  assert.deepEqual(modelOptions(catalog, { account: 'a', cli: 'codex' }).map((m) => m.model), ['gpt-6-astra'], 'account-less rows apply everywhere');
  assert.deepEqual(modelOptions(undefined, { account: 'a', cli: 'claude' }), []);
});

test('working directory picks put the parent first, then the server recent list', () => {
  assert.deepEqual(
    cwdPicks({ recent: ['/b', '/c', '/b', ''], parent: '/a' }),
    ['/a', '/b', '/c'],
  );
  assert.deepEqual(cwdPicks({ recent: ['/b', '/a'], parent: '/a' }), ['/a', '/b'], 'parent is not repeated');
  assert.deepEqual(cwdPicks({ recent: Array.from({ length: 12 }, (_, i) => `/d${i}`), limit: 3 }), ['/d0', '/d1', '/d2']);
  assert.deepEqual(cwdPicks({ recent: [null, 7, '/x'] }), ['/x']);
  assert.deepEqual(cwdPicks(), []);
});

test('the drag clamp keeps the whole dialog inside the viewport', () => {
  const box = { width: 520, height: 560, viewportWidth: 1440, viewportHeight: 900 };
  assert.deepEqual(clampOffset({ ...box, x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(clampOffset({ ...box, x: 9999, y: 9999 }), { x: 452, y: 162 });
  assert.deepEqual(clampOffset({ ...box, x: -9999, y: -9999 }), { x: -452, y: -162 });
  assert.deepEqual(clampOffset({ ...box, x: 'wide', y: undefined }), { x: 0, y: 0 }, 'junk becomes the centre');
  assert.deepEqual(
    clampOffset({ x: 100, y: 100, width: 900, height: 800, viewportWidth: 400, viewportHeight: 300 }),
    { x: 0, y: 0 },
    'a dialog larger than the viewport stays centred',
  );
});

test('the dragged position lives in the module, so a reopened dialog lands there', () => {
  resetDialogPosition();
  assert.equal(readDialogPosition(), null, 'a fresh session starts centred');
  writeDialogPosition({ x: 200, y: -120 });
  assert.deepEqual(readDialogPosition(), { x: 200, y: -120 });
  writeDialogPosition({ x: 'wide', y: undefined });
  assert.deepEqual(readDialogPosition(), { x: 0, y: 0 }, 'junk becomes the centre');
  resetDialogPosition();
  assert.equal(readDialogPosition(), null);
});

const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    read: (k) => map.get(k) ?? null,
  };
};

test('the model combo suggests the remembered custom id first, then the catalog', () => {
  const catalog = [
    { account: 'default', cli: 'claude', model: 'claude-opus-5', label: 'Opus 5' },
    { account: 'default', cli: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5' },
    { account: 'a', cli: 'claude', model: 'claude-opus-5', label: 'Opus 5' },
  ];
  assert.deepEqual(modelSuggestions(catalog, { account: 'default', cli: 'claude' }), [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  ]);
  assert.deepEqual(modelSuggestions(catalog, { account: 'default', cli: 'claude', custom: ' my-local-model ' }), [
    { id: 'my-local-model', label: 'my-local-model · 上次手输' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  ]);
  assert.deepEqual(
    modelSuggestions(catalog, { account: 'default', cli: 'claude', custom: 'claude-opus-5' }).map((p) => p.id),
    ['claude-opus-5', 'claude-sonnet-5'],
    'a remembered id that is already in the catalog is not repeated',
  );
  assert.deepEqual(modelSuggestions(catalog, { account: 'a', cli: 'cursor', custom: '' }), []);
  assert.deepEqual(modelSuggestions(undefined, { account: 'a', cli: 'claude' }), []);
});

test('the last custom model id is remembered per CLI', () => {
  const storage = fakeStorage();
  assert.deepEqual(readCustomModels(storage), {});
  writeCustomModel(storage, 'claude', ' my-local-model ');
  writeCustomModel(storage, 'codex', 'local-gpt');
  assert.deepEqual(readCustomModels(storage), { claude: 'my-local-model', codex: 'local-gpt' });
  assert.deepEqual(writeCustomModel(storage, 'claude', 'another'), { claude: 'another', codex: 'local-gpt' });
  assert.deepEqual(writeCustomModel(storage, 'claude', '  '), { codex: 'local-gpt' }, 'blank forgets it');
  assert.deepEqual(readCustomModels(fakeStorage({ 'sbb-spawn-models': '{bad' })), {});
  assert.deepEqual(readCustomModels(fakeStorage({ 'sbb-spawn-models': '[1,2]' })), {});
  assert.deepEqual(readCustomModels(fakeStorage({ 'sbb-spawn-models': '{"claude":"","codex":7}' })), {});
  assert.doesNotThrow(() => writeCustomModel({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'claude', 'x'));
  assert.deepEqual(readCustomModels(undefined), {});
});

test('the footer shows the pair and the model that will be passed', () => {
  const chip = { key: 'default/claude', label: 'default · Claude', pct: 62 };
  assert.equal(footerText({ chip, account: 'default', cli: 'claude', model: 'my-local-model' }),
    'default · Claude · my-local-model · 剩余 62%');
  assert.equal(footerText({ chip, account: 'default', cli: 'claude', model: '  ' }),
    'default · Claude · 默认 · 剩余 62%');
  assert.equal(footerText({ chip: { ...chip, pct: null }, account: 'c', cli: 'codex', model: 'x' }),
    'default · Claude · x · 按量');
  assert.equal(footerText({ account: 'c', cli: 'cursor', model: 'my-local-model' }),
    'c · cursor · my-local-model · 额度未知');
});

test('effort is offered only for the CLIs whose launch command takes it', () => {
  assert.deepEqual(effortOptions('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortOptions('codex'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortOptions('agy'), [], 'no switch: the field is hidden');
  assert.deepEqual(effortOptions('cursor'), []);
  assert.deepEqual(effortOptions('kimi'), []);
  assert.deepEqual(effortOptions('grok'), []);
  assert.deepEqual(effortOptions(''), []);
  assert.deepEqual(effortOptions(undefined), []);
});

test('the footer adds the effort level only when one is chosen', () => {
  const chip = { key: 'a/claude', label: 'a · Claude', pct: 89 };
  assert.equal(footerText({ chip, account: 'a', cli: 'claude', model: 'my-local-model', effort: 'high' }),
    'a · Claude · my-local-model · high · 剩余 89%');
  assert.equal(footerText({ chip, account: 'a', cli: 'claude', model: '', effort: 'xhigh' }),
    'a · Claude · 默认 · xhigh · 剩余 89%');
  assert.equal(footerText({ chip, account: 'a', cli: 'claude', model: '', effort: '  ' }),
    'a · Claude · 默认 · 剩余 89%');
});

test('spaces in the name become - while typing; the server rule is mirrored', () => {
  assert.equal(sanitizeName('my brain'), 'my-brain');
  assert.equal(sanitizeName('  spaced   out  '), '-spaced-out-');
  assert.equal(sanitizeName('Main'), 'Main', 'case is kept');
  assert.equal(sanitizeName('审核'), '审核');
  assert.equal(sanitizeName(undefined), '');
  assert.equal(NAME_RE.test('Main'), true);
  assert.equal(NAME_RE.test('审核'), true);
  assert.equal(NAME_RE.test('review.v2_x-1'), true);
  assert.equal(NAME_RE.test('has space'), false);
  assert.equal(NAME_RE.test('-leading'), false);
  assert.equal(NAME_RE.test('a'.repeat(41)), false);
  assert.equal(NAME_RE.test('a'.repeat(40)), true);
});

test('an invalid_name error becomes one plain Chinese rule, other errors pass through', () => {
  assert.equal(errorText('invalid_name: invalid brain name "has space": letters, digits, - _ . only, no spaces, up to 40 characters'),
    '名字只能用字母、数字、中文、-、_、.，不能有空格（最长 40 个字符）');
  assert.equal(errorText('name_invalid: something'), 'name_invalid: something', 'lookalikes are left alone');
  assert.equal(errorText('duplicate_name: 名字已被占用'), 'duplicate_name: 名字已被占用');
  assert.equal(errorText(undefined), '');
});

test('a level above the CLI ceiling is applied lower, and the footer says so', () => {
  assert.equal(effortApplied('claude', 'max'), 'max', 'claude takes max');
  assert.equal(effortApplied('codex', 'max'), 'xhigh', 'codex tops out at xhigh');
  assert.equal(effortApplied('codex', 'xhigh'), 'xhigh');
  assert.equal(effortApplied('codex', 'low'), 'low');
  assert.equal(effortApplied('codex', 'ultra'), 'ultra', 'an unknown level is passed through');
  assert.equal(effortApplied('agy', 'max'), '', 'no switch, nothing to apply');
  assert.equal(effortApplied('codex', '  '), '');
  assert.equal(effortApplied(undefined, 'max'), '');

  assert.equal(effortNote('codex', 'max'), 'Codex 最高 xhigh，将按 xhigh 运行');
  assert.equal(effortNote('codex', 'high'), '', 'no note when the level runs as chosen');
  assert.equal(effortNote('claude', 'max'), '', 'claude reaches max');
  assert.equal(effortNote('agy', 'max'), '', 'no effort switch, no note');
  assert.equal(effortNote('codex', 'ultra'), '', 'unknown levels are left to the server');
  assert.equal(effortNote('codex', ''), '');
});

test('the footer appends the downgrade hint after the quota', () => {
  const chip = { key: 'a/codex', label: 'a · Codex', pct: 94 };
  assert.equal(
    footerText({ chip, account: 'a', cli: 'codex', model: '', effort: 'max', note: effortNote('codex', 'max') }),
    'a · Codex · 默认 · max · 剩余 94% · Codex 最高 xhigh，将按 xhigh 运行',
  );
  assert.equal(
    footerText({ chip, account: 'a', cli: 'codex', model: 'gpt-6-astra', effort: 'high', note: effortNote('codex', 'high') }),
    'a · Codex · gpt-6-astra · high · 剩余 94%',
  );
  assert.equal(footerText({ chip, account: 'a', cli: 'codex', model: '', note: '  ' }), 'a · Codex · 默认 · 剩余 94%');
});

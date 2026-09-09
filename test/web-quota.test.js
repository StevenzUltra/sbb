// Top-bar quota chips built from real Usage Guard rows (web/src/lib/quota.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQuotaChips, quotaTone } from '../web/src/lib/quota.js';

const row = (account, provider, window, remaining, status = 'fresh') => ({
  account, alias: account, provider, window, usedPercent: remaining === null ? null : 100 - remaining, remaining, status, note: null,
});

test('usage guard rows become one chip per account x CLI, weekly first, live accounts first', () => {
  const rows = [
    row('a', 'claude', 'session', 81), row('a', 'claude', 'weekly', 84), row('a', 'claude', 'fable', 69),
    row('default', 'codex', 'weekly', 41),
    row('b', 'claude', 'unknown', null, 'authenticationRequired'),
    row('a', 'grok', 'weekly', 100), // not an SBB CLI
    row('a', 'cursor', 'weekly', 0),
    row('default', 'antigravity', 'weekly', 89.1),
  ];
  const chips = toQuotaChips(rows, { brains: [{ account: 'a', cli: 'claude' }] });
  assert.deepEqual(chips.map((c) => c.key), ['a/claude', 'a/cursor', 'default/codex', 'default/agy', 'b/claude']);
  assert.deepEqual(chips[0], { key: 'a/claude', label: 'a · Claude', pct: 84, note: '5h 剩 81% · 7d 剩 84% · Fable 剩 69%', live: true });
  assert.equal(chips[3].pct, 89);
  assert.deepEqual(chips[4], { key: 'b/claude', label: 'b · Claude', pct: null, note: '未登录', live: false });
});

test('the chip list is capped and ready-made chips pass through', () => {
  const many = Array.from({ length: 9 }, (_, i) => row(`acc${i}`, 'codex', 'weekly', i * 10));
  assert.equal(toQuotaChips(many).length, 6);
  const fixture = [{ key: 'a/claude', label: 'a · Claude', pct: 89, note: '5h 17% · 7d 11%' }];
  assert.equal(toQuotaChips(fixture), fixture);
  assert.deepEqual(toQuotaChips(undefined), []);
});

test('tone follows the policy floors', () => {
  assert.equal(quotaTone(84), 'green');
  assert.equal(quotaTone(20), 'yellow');
  assert.equal(quotaTone(10), 'red');
  assert.equal(quotaTone(null), 'muted');
  assert.equal(quotaTone(25, { quota: { floorWeekly: 15, mainReserve: 30 } }), 'yellow');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAccounts, accountFromPaneTag } from '../src/lib/paths.js';
import { newMsgId, shortId, idMatcher } from '../src/lib/ids.js';
import { send, STATUS } from '../src/transports/index.js';

test('accounts discovery returns default first when ~/.claude or ~/.codex exists', () => {
  const accounts = discoverAccounts();
  assert.ok(Array.isArray(accounts));
  if (accounts.length) assert.equal(accounts[0].name, 'default');
});

test('pane tag normalisation', () => {
  assert.equal(accountFromPaneTag('A'), 'a');
  assert.equal(accountFromPaneTag(''), 'default');
  assert.equal(accountFromPaneTag(undefined), 'default');
});

test('message ids', () => {
  const id = newMsgId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(shortId(id).length, 8);
  assert.ok(idMatcher(shortId(id))(id));
  assert.throws(() => idMatcher('zz'));
});

test('router reports no transport while stubs are in place', async () => {
  const receipt = await send(
    { address: 'x', account: 'default', cli: 'agy', paneId: '%1', coord: '1:1.1' },
    { msgId: newMsgId(), text: 'hi', priority: 'next', fromBrain: 'user' },
  );
  assert.equal(receipt.status, STATUS.BLOCKED);
});

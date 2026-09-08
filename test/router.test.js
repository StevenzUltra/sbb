import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, STATUS } from '../src/transports/index.js';

const target = { address: 'x', account: 'a', cli: 'claude', paneId: '%9', coord: '1:1.1' };
const message = { msgId: 'a'.repeat(32), text: '[t] hi', priority: 'next', fromBrain: 'user', fromName: 'lead#T-0001' };

function fakeTransport(id, results) {
  const calls = [];
  return {
    id,
    calls,
    supports: () => true,
    async send(t, m, opts) {
      calls.push({ t, m, opts });
      const r = results.shift();
      return typeof r === 'function' ? r() : { msgId: m.msgId, elapsedMs: 1, via: id, ...r };
    },
  };
}

test('falls back to the next transport on fallback reasons only', async () => {
  const first = fakeTransport('uds', [{ status: 'blocked', reason: 'transport_unavailable' }]);
  const second = fakeTransport('send-keys', [{ status: 'delivered' }]);
  const router = createRouter({ chain: { claude: [first, second] }, loadConfirm: async () => null });
  const r = await router.send(target, message);
  assert.equal(r.status, STATUS.DELIVERED);
  assert.equal(r.via, 'send-keys');
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
});

test('held is final: no typing fallback', async () => {
  const first = fakeTransport('uds', [{ status: 'blocked', reason: 'held' }]);
  const second = fakeTransport('send-keys', [{ status: 'delivered' }]);
  const router = createRouter({ chain: { claude: [first, second] }, loadConfirm: async () => null });
  const r = await router.send(target, message);
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.reason, 'held');
  assert.equal(second.calls.length, 0);
});

test('last fallback receipt is returned when every transport is unavailable', async () => {
  const first = fakeTransport('uds', [{ status: 'blocked', reason: 'socket_connect_failed' }]);
  const second = fakeTransport('send-keys', [{ status: 'blocked', reason: 'transport_unavailable', detail: 'no tmux' }]);
  const router = createRouter({ chain: { claude: [first, second] }, loadConfirm: async () => null });
  const r = await router.send(target, message);
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.via, 'send-keys');
  assert.equal(r.detail, 'no tmux');
});

test('no supporting transport yields blocked/no_transport', async () => {
  const none = { id: 'x', supports: () => false, send: async () => { throw new Error('must not be called'); } };
  const router = createRouter({ chain: { claude: [none] }, loadConfirm: async () => null });
  const r = await router.send(target, message);
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.reason, 'no_transport');
});

test('queued uds receipt is upgraded when the screen confirms', async () => {
  const uds = fakeTransport('uds', [{ status: 'queued', detail: 'no peer_message_status within 4000ms' }]);
  let confirmArgs;
  const router = createRouter({
    chain: { claude: [uds] },
    loadConfirm: async () => async (t, m, o) => { confirmArgs = { t, m, o }; return 'delivered'; },
  });
  const r = await router.send(target, message, { verifyTimeoutMs: 1234 });
  assert.equal(r.status, STATUS.DELIVERED);
  assert.equal(r.via, 'uds+screen');
  assert.match(r.detail, /confirmed on screen/);
  assert.deepEqual(confirmArgs.m, { text: message.text, fromName: message.fromName });
  assert.equal(confirmArgs.o.timeoutMs, 1234);
});

test('queued stays queued when the screen does not confirm, confirm is absent, or opted out', async () => {
  for (const [loadConfirm, opts] of [
    [async () => async () => 'pending', {}],
    [async () => null, {}],
    [async () => async () => 'delivered', { confirm: false }],
  ]) {
    const uds = fakeTransport('uds', [{ status: 'queued' }]);
    const router = createRouter({ chain: { claude: [uds] }, loadConfirm });
    const r = await router.send(target, message, opts);
    assert.equal(r.status, STATUS.QUEUED);
    assert.equal(r.via, 'uds');
  }
});

test('a throwing confirm never changes the status', async () => {
  const uds = fakeTransport('uds', [{ status: 'queued' }]);
  const router = createRouter({ chain: { claude: [uds] }, loadConfirm: async () => async () => { throw new Error('capture failed'); } });
  const r = await router.send(target, message);
  assert.equal(r.status, STATUS.QUEUED);
  assert.match(r.detail, /screen confirm failed: capture failed/);
});

test('send-keys receipts are never screen-confirmed twice', async () => {
  const keys = fakeTransport('send-keys', [{ status: 'queued' }]);
  let called = false;
  const router = createRouter({ chain: { cursor: [keys] }, loadConfirm: async () => async () => { called = true; return 'delivered'; } });
  const r = await router.send({ ...target, cli: 'cursor' }, message);
  assert.equal(r.status, STATUS.QUEUED);
  assert.equal(called, false);
});

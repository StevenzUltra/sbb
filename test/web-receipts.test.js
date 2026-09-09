// Receipt-log rows as the console renders them (web/src/lib/receipts.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptRow, envelopeBody } from '../web/src/lib/receipts.js';

test('a receipt-log line becomes a log row with time, ids and the envelope body', () => {
  const row = receiptRow({
    t: Date.UTC(2026, 8, 9, 7, 48, 26), msgId: 'ff0b5ab7', from: 'user', fromId: null, to: 'demo', toId: 'SSL-0053',
    status: 'delivered', via: 'uds+screen', textPreview: '[user@cli][用户 → #demo] 请用一句话自我介绍 (sbb:ff0b5ab7)',
  });
  assert.equal(row.from, '你');
  assert.equal(row.to, 'SSL-0053');
  assert.equal(row.preview, '请用一句话自我介绍');
  assert.match(row.at, /^\d\d:\d\d$/);
  assert.equal(row.status, 'delivered');

  const peer = receiptRow({ t: 1, from: 'Claude', fromId: null, to: '24:3.1', toId: null, status: 'queued', via: 'uds', textPreview: '[Claude@zz/claude:24:3.2][协作方] hi' });
  assert.equal(peer.from, 'Claude');
  assert.equal(peer.to, '24:3.1');
  assert.equal(peer.preview, 'hi');
});

test('fixture rows pass through and envelopeBody tolerates plain text', () => {
  const fixture = { at: '05:27', from: '你', to: 'lead', status: 'delivered', via: 'uds+screen', preview: 'x', msgId: 'eb46b602' };
  assert.deepEqual(receiptRow(fixture), fixture);
  assert.equal(envelopeBody('plain'), 'plain');
  assert.equal(receiptRow(null), null);
});

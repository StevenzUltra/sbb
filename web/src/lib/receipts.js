// Receipt-log rows for the console. The server hands over the log's own lines
// (docs/spec/receipts.md: t, msgId, from, fromId, to, toId, status, via, textPreview, ...);
// the log view renders { at, from, to, status, via, preview, msgId }. Fixture rows already
// have that shape and pass through.

const ENVELOPE_RE = /^(?:\[[^\]\n]*\]\s*)+/;
const TRAILER_RE = /\s*\(sbb:[0-9a-f]{8}\)\s*$/;

/** @param {number} t */
export function clock(t) {
  const d = new Date(Number(t) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Envelope body: drop the `[name#id@account/cli:coord][role]` prefixes and the `(sbb:xxxxxxxx)` trailer. */
export function envelopeBody(text) {
  return String(text ?? '').replace(ENVELOPE_RE, '').replace(TRAILER_RE, '').trim();
}

/** @param {Record<string, any>} row */
export function receiptRow(row) {
  if (!row || typeof row !== 'object') return row;
  const from = row.from === 'user' ? '你' : row.fromId ?? row.from ?? '';
  return {
    ...row,
    at: row.at ?? clock(row.t),
    from,
    to: row.toId ?? row.to ?? '',
    preview: row.preview ?? envelopeBody(row.textPreview ?? row.text ?? ''),
  };
}

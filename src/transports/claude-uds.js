// claude-uds transport. Implemented by h1; see docs/tasks/h1-*.md and docs/spec/protocols.md.
/** @type {import('../types.js').Transport} */
export const claudeUds = {
  id: 'uds',
  supports() {
    return false; // TODO(h1): implement per docs/spec/protocols.md
  },
  async send(target, message) {
    return {
      status: 'blocked',
      via: 'uds',
      msgId: message.msgId,
      elapsedMs: 0,
      reason: 'transport_unavailable',
      detail: 'claude-uds transport not implemented yet',
    };
  },
};

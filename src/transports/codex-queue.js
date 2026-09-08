// codex-queue transport. Implemented by h2; see docs/tasks/h2-*.md and docs/spec/protocols.md.
/** @type {import('../types.js').Transport} */
export const codexQueue = {
  id: 'codex-queue',
  supports() {
    return false; // TODO(h2): implement per docs/spec/protocols.md
  },
  async send(target, message) {
    return {
      status: 'blocked',
      via: 'codex-queue',
      msgId: message.msgId,
      elapsedMs: 0,
      reason: 'transport_unavailable',
      detail: 'codex-queue transport not implemented yet',
    };
  },
};

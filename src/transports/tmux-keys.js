// tmux-keys transport. Implemented by h2; see docs/tasks/h2-*.md and docs/spec/protocols.md.
/** @type {import('../types.js').Transport} */
export const tmuxKeys = {
  id: 'send-keys',
  supports() {
    return false; // TODO(h2): implement per docs/spec/protocols.md
  },
  async send(target, message) {
    return {
      status: 'blocked',
      via: 'send-keys',
      msgId: message.msgId,
      elapsedMs: 0,
      reason: 'transport_unavailable',
      detail: 'tmux-keys transport not implemented yet',
    };
  },
};

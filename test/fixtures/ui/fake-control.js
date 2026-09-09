// Fake tmux control-mode client for pane-stream tests. Mirrors the interface
// src/host/tmux.js controlClient() returns: on('data'|'error'|'close'|'exit'),
// write(line), kill(signal), close().
export function createFakeControl() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {string[]} */
  const lines = [];
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
  };
  return {
    lines,
    written: lines,
    write(line) {
      lines.push(String(line));
      return true;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return this;
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
      return this;
    },
    kill() {
      emit('close', { code: null, signal: 'SIGTERM' });
    },
    close() {
      emit('close', { code: 0, signal: null });
    },
    feed(text) {
      emit('data', Buffer.from(String(text)));
    },
    fail(err) {
      emit('error', err instanceof Error ? err : new Error(String(err)));
    },
    exit(code = 0) {
      emit('exit', code);
    },
  };
}

/** A control factory that records every session it was asked to attach to. */
export function createControlFactory() {
  /** @type {any[]} */
  const clients = [];
  const factory = ({ session }) => {
    const client = createFakeControl();
    client.session = session;
    clients.push(client);
    return client;
  };
  factory.clients = clients;
  return factory;
}

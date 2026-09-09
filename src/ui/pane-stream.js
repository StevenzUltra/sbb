// tmux control-mode pane stream for the UI server (docs/spec/ui-server.md
// "Live pane stream (WebSocket)"). One control client per server process; every socket
// that watches a pane becomes a subscriber here, and input is refused until that
// subscriber asks for it.
import { host as defaultHost } from '../host/index.js';

/** Default scrollback sent as the initial screen when a socket subscribes. */
export const DEFAULT_CAPTURE_LINES = 40;

/** Refusal reasons this module returns instead of throwing. */
export const REFUSED = Object.freeze({
  INPUT_OFF: 'input_off',
  INVALID_INPUT: 'invalid_input',
  INVALID_KEY: 'invalid_key',
  INVALID_SIZE: 'invalid_size',
  CLIENT_ATTACHED: 'client_attached',
  PANE_GONE: 'pane_gone',
});

/**
 * A tmux key name the console may send. Refuses anything that could be read as a tmux
 * option or as extra arguments (`-l`, `;`, a space) before it reaches send-keys.
 */
export const KEY_NAME_RE = /^(?:C-|M-|S-|C-M-)?(?:[A-Za-z0-9]|F[0-9]{1,2}|Up|Down|Left|Right|Home|End|PPage|NPage|BSpace|DC|IC|Enter|Escape|Space|Tab|BTab)(?:-(?:[A-Za-z0-9]|Up|Down|Left|Right))?$/;

/**
 * Unescape a `%output` payload. tmux writes any byte outside printable ASCII as the octal
 * form `\ooo` (a literal backslash is `\134`, confirmed against tmux 3.7c on 2026-09-09);
 * `\\` is accepted too for older versions.
 * @param {string} text
 * @returns {Buffer}
 */
export function unescapeOutput(text) {
  const source = String(text ?? '');
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '\\') {
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte);
      continue;
    }
    const rest = source.slice(i + 1);
    const octal = /^([0-7]{3})/.exec(rest);
    if (octal) {
      bytes.push(Number.parseInt(octal[1], 8));
      i += 3;
      continue;
    }
    if (rest.startsWith('\\')) {
      bytes.push(0x5c);
      i += 1;
      continue;
    }
    bytes.push(0x5c);
  }
  return Buffer.from(bytes);
}

/**
 * Parse one control-mode line.
 * @param {string} line
 * @returns {{type: 'output', paneId: string, data: Buffer}
 *   | {type: 'exit'|'session-changed'|'window-close'|'layout-change'|'block'|'error'|'other', text: string, session?: string, windowId?: string}}
 */
export function parseControlLine(line) {
  const text = String(line ?? '').replace(/\r?\n$/, '');
  if (text.startsWith('%output ')) {
    const rest = text.slice('%output '.length);
    const space = rest.indexOf(' ');
    if (space === -1) return { type: 'output', paneId: rest, data: Buffer.alloc(0), text };
    return { type: 'output', paneId: rest.slice(0, space), data: unescapeOutput(rest.slice(space + 1)), text };
  }
  if (text === '%exit') return { type: 'exit', text };
  if (text.startsWith('%session-changed ')) {
    return { type: 'session-changed', session: text.slice('%session-changed '.length).split(' ').pop(), text };
  }
  if (text.startsWith('%window-close ') || text.startsWith('%unlinked-window-close ')) {
    return { type: 'window-close', windowId: text.split(' ')[1], text };
  }
  if (text.startsWith('%layout-change ') || text.startsWith('%window-add ') || text.startsWith('%window-close')) {
    return { type: 'layout-change', text };
  }
  if (text.startsWith('%begin ') || text.startsWith('%end ')) return { type: 'block', text };
  if (text.startsWith('%error ')) return { type: 'error', text };
  return { type: 'other', text };
}

/** @param {string} paneId */
function assertPaneId(paneId) {
  const id = String(paneId ?? '').trim();
  if (!/^%\d+$/.test(id)) throw new Error(`pane-stream: invalid pane id "${paneId}"`);
  return id;
}

/**
 * @typedef {Object} PaneSubscriber
 * @property {string} paneId
 * @property {boolean} inputOn
 * @property {(value: boolean) => boolean} setInput
 * @property {(text: string) => Promise<{refused: false} | {refused: true, reason: string}>} input
 * @property {(name: string) => Promise<{refused: false} | {refused: true, reason: string}>} key
 * @property {(cols: number, rows: number) => Promise<{refused: false} | {refused: true, reason: string}>} resize
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ session: string, host?: typeof defaultHost, controlFactory?: Function,
 *           captureLines?: number, onError?: (err: Error) => void,
 *           sleep?: (ms: number) => Promise<void> }} [opts]
 */
export function createPaneStream(opts = {}) {
  const host = opts.host ?? defaultHost;
  const session = String(opts.session ?? '').trim();
  if (!session) throw new Error('createPaneStream: session is required');
  const captureLines = opts.captureLines ?? DEFAULT_CAPTURE_LINES;
  const onError = opts.onError ?? (() => {});
  const controlFactory = opts.controlFactory ?? ((o) => defaultHost.controlClient(o));

  /** @type {Map<string, Set<PaneSubscriber>>} */
  const subscribers = new Map();
  /** @type {Set<string>} panes tmux is currently told to stream */
  const watched = new Set();
  /** @type {any} */
  let client = null;
  let started = false;
  let stopped = false;
  let buffered = '';
  let paneCheckTimer = null;

  /** @param {string} line */
  function handleLine(line) {
    const event = parseControlLine(line);
    if (event.type === 'output') {
      const subs = subscribers.get(event.paneId);
      if (!subs) return;
      for (const sub of [...subs]) {
        try {
          sub.handlers.onOutput?.(event.data, { initial: false });
        } catch (err) {
          onError(err);
        }
      }
      return;
    }
    if (event.type === 'exit') {
      closeAll('control_exit');
      return;
    }
    if (event.type === 'session-changed') {
      // The attach itself reports our own session; only a move away from it closes.
      if (event.session && event.session !== session) closeAll('session_changed');
      return;
    }
    if (event.type === 'window-close' || event.type === 'layout-change') schedulePaneCheck();
    if (event.type === 'error') onError(new Error(`tmux control error: ${event.text}`));
  }

  function schedulePaneCheck() {
    if (paneCheckTimer || stopped) return;
    paneCheckTimer = setTimeout(() => {
      paneCheckTimer = null;
      checkPanes().catch(onError);
    }, 100);
    paneCheckTimer.unref?.();
  }

  /** Close every subscriber whose pane no longer exists on the server. */
  async function checkPanes() {
    if (!subscribers.size) return;
    let panes;
    try {
      panes = await host.listPanes();
    } catch (err) {
      onError(err);
      return;
    }
    const live = new Set(panes.map((p) => p.paneId));
    for (const paneId of [...subscribers.keys()]) {
      if (!live.has(paneId)) closePane(paneId, 'pane_closed');
    }
  }

  /** @param {string} reason */
  function closeAll(reason) {
    for (const paneId of [...subscribers.keys()]) closePane(paneId, reason);
    watched.clear();
  }

  /** @param {string} paneId @param {string} reason */
  function closePane(paneId, reason) {
    const subs = subscribers.get(paneId);
    if (!subs) return;
    subscribers.delete(paneId);
    unwatch(paneId);
    for (const sub of [...subs]) {
      sub.closed = true;
      try {
        sub.handlers.onClosed?.({ type: 'closed', paneId, reason });
      } catch (err) {
        onError(err);
      }
    }
  }

  /** @param {string} paneId */
  function unwatch(paneId) {
    if (!watched.has(paneId) || !client) return;
    watched.delete(paneId);
    client.write(`refresh-client -A "${paneId}:off"`);
  }

  /** @param {string} paneId */
  function watch(paneId) {
    if (watched.has(paneId) || !client) return;
    watched.add(paneId);
    // tmux needs the value quoted: an unquoted `%0:on` is a parse error (tmux 3.7c).
    client.write(`refresh-client -A "${paneId}:on"`);
  }

  /**
   * @param {string} paneId
   * @param {{ onOutput?: (data: Buffer, meta: {initial: boolean}) => void,
   *           onClosed?: (info: {type: 'closed', paneId: string, reason: string}) => void }} [handlers]
   * @returns {PaneSubscriber}
   */
  function subscribe(paneId, handlers = {}) {
    const id = assertPaneId(paneId);
    /** @type {PaneSubscriber} */
    const sub = {
      paneId: id,
      inputOn: false,
      handlers,
      closed: false,
      setInput(value) {
        sub.inputOn = value === true;
        return sub.inputOn;
      },
      async input(text) {
        if (sub.closed) return { refused: true, reason: REFUSED.PANE_GONE };
        if (!sub.inputOn) return { refused: true, reason: REFUSED.INPUT_OFF };
        const body = String(text ?? '');
        if (!body || /[\r\n]/.test(body)) return { refused: true, reason: REFUSED.INVALID_INPUT };
        try {
          await host.sendLiteral(id, body);
        } catch (err) {
          onError(err);
          return { refused: true, reason: REFUSED.PANE_GONE };
        }
        return { refused: false };
      },
      async key(name) {
        if (sub.closed) return { refused: true, reason: REFUSED.PANE_GONE };
        if (!sub.inputOn) return { refused: true, reason: REFUSED.INPUT_OFF };
        const key = String(name ?? '').trim();
        if (!KEY_NAME_RE.test(key)) return { refused: true, reason: REFUSED.INVALID_KEY };
        try {
          await host.sendKey(id, key);
        } catch (err) {
          onError(err);
          return { refused: true, reason: REFUSED.PANE_GONE };
        }
        return { refused: false };
      },
      async resize(cols, rows) {
        if (sub.closed) return { refused: true, reason: REFUSED.PANE_GONE };
        const c = Number(cols);
        const r = Number(rows);
        if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 1 || c > 1000 || r > 1000) {
          return { refused: true, reason: REFUSED.INVALID_SIZE };
        }
        if (await paneHasHumanClient(id)) return { refused: true, reason: REFUSED.CLIENT_ATTACHED };
        try {
          await host.resizePane(id, { cols: c, rows: r });
        } catch (err) {
          onError(err);
          return { refused: true, reason: REFUSED.PANE_GONE };
        }
        return { refused: false };
      },
      async close() {
        if (sub.closed) return;
        sub.closed = true;
        const subs = subscribers.get(id);
        subs?.delete(sub);
        if (!subs || subs.size === 0) {
          subscribers.delete(id);
          unwatch(id);
        }
      },
    };
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(sub);
    if (started) {
      watch(id);
      sendInitial(id).catch(onError);
    }
    return sub;
  }

  /** @param {string} paneId */
  async function sendInitial(paneId) {
    const subs = subscribers.get(paneId);
    if (!subs?.size) return;
    const screen = await host.capturePaneEscaped(paneId, captureLines);
    const data = Buffer.from(`${screen}\r\n`, 'utf8');
    for (const sub of [...subs]) {
      if (sub.closed) continue;
      try {
        sub.handlers.onOutput?.(data, { initial: true });
      } catch (err) {
        onError(err);
      }
    }
  }

  /** A pane a human is looking at is never resized. */
  async function paneHasHumanClient(paneId) {
    let panes;
    let clients;
    try {
      [panes, clients] = await Promise.all([host.listPanes(), host.listClients()]);
    } catch (err) {
      onError(err);
      return true; // cannot prove nobody is attached: do not resize
    }
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return true;
    return clients.some((c) => !c.controlMode && c.tty && c.session === pane.session);
  }

  async function start() {
    if (started) return api;
    started = true;
    client = controlFactory({ session });
    client.on('data', (chunk) => {
      buffered += String(chunk);
      let nl;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        try {
          handleLine(line);
        } catch (err) {
          onError(err);
        }
      }
    });
    client.on('error', (err) => onError(err instanceof Error ? err : new Error(String(err))));
    client.on('close', () => closeAll('control_closed'));
    client.on('exit', () => closeAll('control_exit'));
    for (const paneId of subscribers.keys()) {
      watch(paneId);
      sendInitial(paneId).catch(onError);
    }
    return api;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (paneCheckTimer) clearTimeout(paneCheckTimer);
    paneCheckTimer = null;
    closeAll('server_stopped');
    const current = client;
    client = null;
    if (current) await current.close();
  }

  const api = {
    session,
    start,
    stop,
    subscribe,
    /** @returns {string[]} panes currently streamed */
    watched() {
      return [...subscribers.keys()];
    },
    get started() {
      return started;
    },
  };
  return api;
}

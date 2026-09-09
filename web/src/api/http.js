// Real transport: /api/state, /api/events (SSE), /api/* actions and /ws/pane/:paneId.
// Token handling follows ui-server.md: ?t= on first load, then X-SBB-Token / sbb_ui cookie.
const TOKEN_KEY = 'sbb-token';

export function readToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    document.cookie = `sbb_ui=${fromUrl}; path=/; SameSite=Strict`;
    url.searchParams.delete('t');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function createHttpClient() {
  const token = readToken();
  const auth = { 'X-SBB-Token': token };

  const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(path, {
      method,
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new Error('unauthorized: 缺少或错误的 sbb ui token');
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const reason = data?.error?.reason ?? `http_${res.status}`;
      throw new Error(`${reason}${data?.error?.detail ? `: ${data.error.detail}` : ''}`);
    }
    return data;
  };

  return {
    fixture: false,
    token,
    loadState: () => request('/api/state'),
    post: (path, body) => request(path, { method: 'POST', body }),

    subscribe(onEvent) {
      const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
      const names = ['brain', 'receipt', 'message', 'held', 'plan', 'claim', 'quota', 'tps', 'policy'];
      for (const event of names) {
        source.addEventListener(event, (msg) => {
          try {
            onEvent({ event, data: JSON.parse(msg.data) });
          } catch (err) {
            console.warn('sbb: bad event payload', event, err);
          }
        });
      }
      return () => source.close();
    },

    openPane(paneId, { onData, onClosed, onGeometry, onRefused }) {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${proto}://${window.location.host}/ws/pane/${encodeURIComponent(paneId)}?t=${encodeURIComponent(token)}`,
      );
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (msg) => {
        if (typeof msg.data === 'string') {
          try {
            const frame = JSON.parse(msg.data);
            // 'closed' ends the stream; 'refused' answers one request (resize while a person
            // has the pane open in a terminal, input before 在此输入) and the stream goes on.
            if (frame.type === 'closed') onClosed?.(frame.reason);
            if (frame.type === 'refused') onRefused?.(frame.reason);
            // Optional: adopt the pane's geometry if the server ever reports it. The console
            // otherwise infers a lower bound from the output and asks for the panel width.
            if (frame.type === 'geometry') onGeometry?.(frame);
          } catch {
            /* ignore malformed control frames */
          }
          return;
        }
        onData?.(new Uint8Array(msg.data));
      };
      socket.onclose = () => onClosed?.();
      return {
        send(frame) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
        },
        close() {
          socket.onclose = null;
          socket.close();
        },
      };
    },
  };
}

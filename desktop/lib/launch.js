// Pure helpers for the desktop shell: how the app finds the CLI, reads the line `sbb ui
// --json` prints, and dresses the console header for a window without a title bar.

/**
 * Find the `{ url, port, token }` document in what `sbb ui --json` has printed so far. The
 * CLI pretty-prints it over several lines, so the buffer is scanned from its first `{`;
 * an incomplete document (still streaming) or anything else yields undefined.
 * @param {string} output
 * @returns {{ url: string, port: number, token: string }|undefined}
 */
export function parseUiOutput(output) {
  const text = String(output ?? '');
  let start = text.indexOf('{');
  while (start >= 0) {
    const end = text.indexOf('}', start);
    if (end < 0) return undefined;
    // try every closing brace after the opening one until the document parses
    for (let close = end; close >= 0; close = text.indexOf('}', close + 1)) {
      try {
        const value = JSON.parse(text.slice(start, close + 1));
        if (typeof value?.url === 'string' && typeof value?.token === 'string' && Number.isInteger(value?.port)) {
          return { url: value.url, port: value.port, token: value.token };
        }
        break; // parsed, but not our document: look for the next opening brace
      } catch {
        // not complete yet at this brace
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}

/**
 * The command that starts the console server. The `sbb` on the user's PATH wins so the app
 * and the brains (which run `sbb tell` / `sbb reply` in their panes) share one version; the
 * copy bundled in the app is the fallback and needs a system Node.js.
 * @param {{ sbbPath?: string|null, nodePath?: string|null, bundledDir: string, port?: number }} input
 * @returns {{ file: string, args: string[], source: 'path'|'bundled' }}
 */
export function resolveCommand({ sbbPath, nodePath, bundledDir, port = 0 }) {
  const uiArgs = ['ui', '--port', String(port), '--no-open', '--json'];
  if (sbbPath) return { file: sbbPath, args: uiArgs, source: 'path' };
  if (!nodePath) throw new Error('Node.js 22.13 or newer is required (node was not found on the login shell PATH)');
  return { file: nodePath, args: [`${bundledDir}/bin/sbb.js`, ...uiArgs], source: 'bundled' };
}

/**
 * Parse the login-shell probe output: PATH on the first line, then one line per looked-up
 * command (empty when missing).
 * @param {string} stdout
 * @returns {{ path: string, node: string|null, sbb: string|null, tmux: string|null }}
 */
export function parseProbe(stdout) {
  const [path = '', node = '', sbb = '', tmux = ''] = String(stdout ?? '').split('\n').map((l) => l.trim());
  const or = (v) => (v && !v.includes(' not found') ? v : null);
  return { path, node: or(node), sbb: or(sbb), tmux: or(tmux) };
}

/**
 * CSS injected into the console when the window has no title bar: room for the traffic
 * lights on the left, the header drags the window, its controls do not.
 */
export function headerCss() {
  return [
    'header.bar { padding-left: 86px; -webkit-app-region: drag; }',
    'header.bar button, header.bar a, header.bar input, header.bar select, header.bar .glass { -webkit-app-region: no-drag; }',
  ].join('\n');
}

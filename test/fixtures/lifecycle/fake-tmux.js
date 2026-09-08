// Fake tmux for lifecycle tests: records every call and serves scripted screens.
// Screens come from test/fixtures/lifecycle/*.txt (samples of the real CLIs' idle and
// busy composers, see src/transports/cli-profiles.js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} name file name without the .txt suffix */
export function screen(name) {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8');
}

/**
 * @param {{ paneId?: string, coord?: string, key?: string, clientSession?: string,
 *           screens?: string[], panes?: Record<string, any>[],
 *           exitAfterEnter?: boolean, failNewWindow?: boolean }} [opts]
 */
export function createFakeTmux(opts = {}) {
  const paneId = opts.paneId ?? '%30';
  const key = opts.key ?? '24:@16.%30';
  const coord = opts.coord ?? '24:3.4';
  /** @type {any[][]} */
  const calls = [];
  let panes = opts.panes ?? [{ paneId, session: '24', windowId: '@16', coord, command: 'zsh' }];
  const screens = opts.screens ?? [];
  let screenIndex = 0;
  let enterCount = 0;

  const nextScreen = () => screens[Math.min(screenIndex++, Math.max(screens.length - 1, 0))] ?? '';

  const api = {
    calls,
    get panes() {
      return panes;
    },
    setPanes(next) {
      panes = next;
    },
    async tmux(args) {
      calls.push(args);
      const command = args[0];
      if (command === 'new-window' || command === 'split-window') {
        if (opts.failNewWindow) throw new Error('no current session');
        return paneId;
      }
      if (command === 'display-message') {
        const format = args[args.length - 1];
        if (format.includes('client_session')) {
          if (opts.clientSession === undefined) throw new Error('no client');
          return opts.clientSession;
        }
        if (format.includes('window_index')) return coord;
        return key;
      }
      if (command === 'kill-pane') {
        panes = [];
        return '';
      }
      if (command === 'set-option') return '';
      return '';
    },
    async capturePane() {
      return nextScreen();
    },
    async listPanes() {
      return panes;
    },
    async resolvePaneId() {
      if (!panes.some((p) => p.paneId === paneId)) throw new Error(`can't find pane ${paneId}`);
      return paneId;
    },
    async sendLiteral(pane, text) {
      calls.push(['send-literal', pane, text]);
    },
    async sendKey(pane, press) {
      calls.push(['send-key', pane, press]);
      if (press !== 'Enter') return;
      if (opts.exitAfterEnter) panes = [];
      else if (opts.exitAfterEnters) {
        enterCount += 1;
        if (enterCount >= opts.exitAfterEnters) panes = [];
      }
    },
    async selectPane(pane) {
      calls.push(['select-pane', pane]);
    },
    async paneInMode() {
      return false;
    },
  };
  return api;
}

/** Every literal typed into the fake pane, in order. */
export function typedLiterals(api) {
  return api.calls.filter((c) => c[0] === 'send-literal').map((c) => c[2]);
}

/** Every tmux argv issued, in order. */
export function tmuxCommands(api) {
  return api.calls.filter((c) => Array.isArray(c) && typeof c[0] === 'string' && !c[0].startsWith('send-') && c[0] !== 'select-pane');
}

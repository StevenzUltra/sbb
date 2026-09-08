// Envelope builder. Callers pass only the body; SBB adds the sender prefix and the
// `(sbb:<id8>)` suffix so the receiver can answer with `sbb reply <id>`.
// Format: [<sender>@<account>/<cli>:<coord>][<role>] <body>   (sbb:<id8>)
import { shortId } from '../lib/ids.js';

/** CLI display names, matching the cross-ai-tmux-bridge skill (agy runs Gemini). */
export const CLI_DISPLAY_NAMES = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Gemini',
  cursor: 'Cursor',
  other: 'CLI',
});

/** Role labels. main -> 主脑, sub -> 子脑, the user -> 用户. */
export const ROLE_LABELS = Object.freeze({ main: '主脑', sub: '子脑', user: '用户' });

/** Collapse a body to one line: no newlines, no runs of spaces. */
export function collapseBody(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Sender prefix. Inside tmux: `[sender@account/cli:coord]`. Outside tmux (a script)
 * the spec fixes the identity as `user@cli`.
 * @param {{ sender: string, account?: string|null, cli?: string|null, coord?: string|null }} identity
 */
export function senderPrefix(identity) {
  const { sender, account, cli, coord } = identity;
  if (account && cli && coord) return `[${sender}@${account}/${cli}:${coord}]`;
  if (cli) return `[${sender}@${cli}]`;
  return `[${sender}@cli]`;
}

/**
 * @param {{ sender: string, account?: string|null, cli?: string|null, coord?: string|null,
 *           role: string, body: string, msgId: string }} input
 * @returns {string} one line
 */
export function buildEnvelope(input) {
  const body = collapseBody(input.body);
  if (!body) throw new Error('buildEnvelope: body must not be empty');
  return `${senderPrefix(input)}[${input.role}] ${body}   (sbb:${shortId(input.msgId)})`;
}

/**
 * Sender identity for the calling pane, derived from the roster.
 * Not in tmux, or in a pane that is not a CLI session, means the human is the sender.
 * @param {{ paneId?: string|undefined, rows: import('./roster.js').RosterRow[] }} input
 */
export function identityFromRows({ paneId, rows }) {
  if (!paneId) return { sender: 'user', account: null, cli: null, coord: null, role: ROLE_LABELS.user, brain: null };
  const row = rows.find((r) => r.paneId === paneId);
  if (!row) return { sender: 'user', account: null, cli: null, coord: null, role: ROLE_LABELS.user, brain: null };
  if (row.brain) {
    return {
      sender: row.brain,
      account: row.account,
      cli: row.cli,
      coord: row.coord,
      role: row.role === 'main' ? ROLE_LABELS.main : ROLE_LABELS.sub,
      brain: row.brain,
    };
  }
  return {
    sender: CLI_DISPLAY_NAMES[row.cli] ?? 'CLI',
    account: row.account,
    cli: row.cli,
    coord: row.coord,
    role: ROLE_LABELS.sub,
    brain: null,
  };
}

/**
 * Resolve the caller's identity. Builds a roster unless one is injected.
 * @param {{ paneId?: string, rows?: import('./roster.js').RosterRow[], roster?: Function }} [opts]
 */
export async function selfIdentity(opts = {}) {
  const paneId = opts.paneId ?? process.env.TMUX_PANE;
  const rows = opts.rows ?? (await (opts.roster ?? (await import('./roster.js')).roster)({ withStatus: false }));
  return identityFromRows({ paneId, rows });
}

/**
 * `sbb tell --file <path>` sends "见 <path>" plus the first line of the file
 * instead of the content.
 * @param {string} filePath
 * @param {string} content
 */
export function bodyFromFile(filePath, content) {
  const firstLine = String(content ?? '').split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return collapseBody(`见 ${filePath} ${firstLine}`);
}

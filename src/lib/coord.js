// Server-qualified coordinates. A bare coord (`24:3.4`) repeats across tmux servers, so
// receipts record the full form `<server socket path>@<coord>` (docs/spec/receipts.md);
// display keeps the bare coord. `splitCoordFull` is the inverse, used when a receipt's
// coord has to be checked against the server this process is talking to.

export const COORD_FULL_SEP = '@';

/**
 * @param {string|null|undefined} coord
 * @param {string|null|undefined} serverPath
 * @returns {string|null} `<serverPath>@<coord>`, or the bare coord when the server is unknown
 */
export function formatCoordFull(coord, serverPath) {
  const c = String(coord ?? '').trim();
  if (!c) return null;
  const s = String(serverPath ?? '').trim();
  return s ? `${s}${COORD_FULL_SEP}${c}` : c;
}

/**
 * @param {string|null|undefined} text
 * @returns {{ serverPath: string|null, coord: string|null }} serverPath is null for a bare coord
 */
export function splitCoordFull(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { serverPath: null, coord: null };
  const at = raw.lastIndexOf(COORD_FULL_SEP);
  if (at <= 0) return { serverPath: null, coord: raw };
  return { serverPath: raw.slice(0, at), coord: raw.slice(at + 1) || null };
}

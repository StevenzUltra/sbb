// Quota chips for the top bar. The server hands over Usage Guard rows as they are
// (docs/spec/protocols.md: one row per account x provider x window with usedPercent /
// remaining / status); the bar shows one chip per account x CLI with the weekly window's
// remaining percent, ranked so the accounts that run a brain right now come first.
// Fixture mode already ships chips ({ key, label, pct, note }) and passes through unchanged.

const PROVIDER_CLI = Object.freeze({ claude: 'claude', codex: 'codex', antigravity: 'agy', cursor: 'cursor' });
const PROVIDER_LABEL = Object.freeze({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor' });
const WINDOW_LABEL = Object.freeze({ session: '5h', weekly: '7d', fable: 'Fable' });
const STATUS_LABEL = Object.freeze({ authenticationRequired: '未登录', unavailable: '不可用', stale: '已过期' });

/** Default floors when the policy has none (docs/spec/policy.md). */
const DEFAULT_QUOTA = Object.freeze({ floorWeekly: 10, mainReserve: 20 });

/**
 * @param {any[]} rows Usage Guard rows or ready-made chips
 * @param {{ brains?: any[], limit?: number }} [opts]
 * @returns {{ key: string, label: string, pct: number|null, note: string, live: boolean }[]}
 */
export function toQuotaChips(rows, { brains = [], limit = 6 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (rows.every((row) => row && typeof row === 'object' && ('pct' in row || 'key' in row))) return rows;
  const groups = new Map();
  for (const row of rows) {
    const cli = PROVIDER_CLI[row?.provider];
    if (!cli) continue;
    const key = `${row.account}/${cli}`;
    const group = groups.get(key) ?? { key, account: row.account, provider: row.provider, windows: [] };
    group.windows.push(row);
    groups.set(key, group);
  }
  const live = new Set((brains ?? []).map((brain) => `${brain.account}/${brain.cli}`));
  const chips = [...groups.values()].map((group) => {
    const known = group.windows.filter((w) => typeof w.remaining === 'number');
    const main = known.find((w) => w.window === 'weekly') ?? known.find((w) => w.window === 'session') ?? known[0] ?? null;
    const first = group.windows[0];
    return {
      key: group.key,
      label: `${group.account} · ${PROVIDER_LABEL[group.provider]}`,
      pct: main ? Math.round(main.remaining) : null,
      note: main
        ? known.map((w) => `${WINDOW_LABEL[w.window] ?? w.window} 剩 ${Math.round(w.remaining)}%`).join(' · ')
        : STATUS_LABEL[first?.status] ?? first?.note ?? '不可用',
      live: live.has(group.key),
    };
  });
  chips.sort((a, b) => Number(b.live) - Number(a.live) || (a.pct ?? 101) - (b.pct ?? 101) || a.key.localeCompare(b.key));
  return chips.slice(0, limit);
}

/**
 * Colour of a chip's track from the policy floors: at or under floorWeekly is red, at or
 * under mainReserve is yellow, otherwise green; no number means muted.
 * @param {number|null} pct @param {{ quota?: { floorWeekly?: number, mainReserve?: number } }} [policy]
 */
export function quotaTone(pct, policy) {
  if (typeof pct !== 'number') return 'muted';
  const floor = policy?.quota?.floorWeekly ?? DEFAULT_QUOTA.floorWeekly;
  const reserve = policy?.quota?.mainReserve ?? DEFAULT_QUOTA.mainReserve;
  if (pct <= floor) return 'red';
  if (pct <= reserve) return 'yellow';
  return 'green';
}

export const TONE_COLOR = Object.freeze({ green: '#2d6b4f', yellow: '#e5a835', red: '#d94b4b', muted: '#9aa39e' });

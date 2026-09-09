// Copy the ui-data fixture tree into a temp SBB_DIR. Shared by test/ui-data.test.js,
// h1's server tests and h2's console fixtures; nothing here writes to the real ~/.sbb.
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DATA_FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} sbbDir  destination, usually `<temp home>/.sbb`
 * @param {{ omit?: string[] }} [opts] top-level entries to leave out
 * @returns {string} sbbDir
 */
export function installUiDataFixture(sbbDir, opts = {}) {
  const omit = new Set(opts.omit ?? []);
  for (const name of readdirSync(UI_DATA_FIXTURE_DIR)) {
    if (name === 'install.js' || omit.has(name)) continue;
    cpSync(join(UI_DATA_FIXTURE_DIR, name), join(sbbDir, name), { recursive: true });
  }
  return sbbDir;
}

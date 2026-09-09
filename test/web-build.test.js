// The console package builds: `npm --prefix web run build` -> web/dist/index.html.
// Skipped when web/node_modules is absent, so the root suite stays green on a fresh clone
// and in CI without the web toolchain installed (task M3-h2, deliverable 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const installed = existsSync(join(webDir, 'node_modules'));
const bundle = join(webDir, 'dist', 'index.html');

test(
  'web: npm run build produces dist/index.html',
  { skip: installed ? false : 'web/node_modules is not installed' },
  () => {
    execFileSync('npm', ['run', 'build'], { cwd: webDir, stdio: 'pipe' });
    assert.ok(existsSync(bundle), 'web/dist/index.html is missing after the build');
  },
);

#!/usr/bin/env node
// Build, sign (Developer ID from the keychain), optionally notarize, write latest-mac.yml and
// publish a GitHub release with gh. electron-builder's own GitHub publisher created a draft
// and then failed on a duplicate create (2026-09-09), so the upload is done here instead.
// Secrets never enter the repo: signing identity and notarization credentials come from the
// keychain (`xcrun notarytool store-credentials sbb`) or the environment.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const release = join(root, 'release');
const dryRun = process.argv.includes('--dry-run');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
}
const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64');

// 1. build (signs when a Developer ID certificate is in the keychain, see electron-builder.config.cjs)
run('npx', ['electron-builder', '--mac', '--arm64', '--publish', 'never', '-c', 'electron-builder.config.cjs']);

const dmg = join(release, `SBB-${version}-arm64.dmg`);
const zip = join(release, `SBB-${version}-arm64.zip`);
for (const f of [dmg, zip]) if (!existsSync(f)) throw new Error(`missing ${f}`);

// 2. refuse to publish an unsigned app: macOS would never install it as an update
const sig = execFileSync('codesign', ['-dvv', join(release, 'mac-arm64', 'SBB.app')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const signed = /Authority=Developer ID Application/.test(sig) || (spawnSync('codesign', ['-dvv', join(release, 'mac-arm64', 'SBB.app')], { encoding: 'utf8' }).stderr || '').includes('Developer ID Application');
if (!signed) throw new Error('the app is not signed with a Developer ID Application certificate; not publishing');

// 3. update manifest for electron-updater
const entry = (file) => `  - url: ${file.split('/').pop()}\n    sha512: ${sha512(file)}\n    size: ${statSync(file).size}`;
const manifest = `version: ${version}\nfiles:\n${entry(zip)}\n${entry(dmg)}\npath: ${zip.split('/').pop()}\nsha512: ${sha512(zip)}\nreleaseDate: '${new Date().toISOString()}'\n`;
writeFileSync(join(release, 'latest-mac.yml'), manifest);
console.log(manifest);

if (dryRun) { console.log('dry run: not publishing'); process.exit(0); }

// 4. publish (create or complete the release for this tag)
const exists = spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' }).status === 0;
const notes = process.env.SBB_RELEASE_NOTES || `SBB ${version}`;
if (!exists) run('gh', ['release', 'create', tag, '--title', `SBB ${version}`, '--notes', notes]);
run('gh', ['release', 'upload', tag, dmg, zip, join(release, 'latest-mac.yml'), '--clobber']);
run('gh', ['release', 'edit', tag, '--draft=false']);
console.log(`published ${tag}`);

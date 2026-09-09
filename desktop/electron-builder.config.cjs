'use strict';
// electron-builder config for SBB desktop. Everything here is public: the update feed is the
// project's GitHub Releases, so anyone who downloaded the app from the repo gets updates.
// Secrets never live in the repo: the Developer ID certificate is read from the maintainer's
// keychain and notarization credentials from the environment (docs/spec/desktop.md).
const pkg = require('./package.json');

const { execFileSync } = require('node:child_process');

const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
// Sign only with a Developer ID Application certificate (the one macOS accepts for apps
// distributed outside the App Store and for auto-updates). An Apple Development or
// Distribution certificate is never used: electron-builder would pick it up and produce an
// app that only runs on registered devices. Without Developer ID the build is ad-hoc
// signed: fine for a local install, but macOS refuses to auto-update it.
function developerIdPresent() {
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return false;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return true;
  try {
    return /Developer ID Application/.test(execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}
const sign = developerIdPresent();

module.exports = {
  ...pkg.build,
  mac: {
    ...pkg.build.mac,
    ...(sign ? { identity: undefined, hardenedRuntime: true, gatekeeperAssess: false, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist', notarize } : { identity: null, hardenedRuntime: false, notarize: false }),
  },
  publish: [{ provider: 'github', owner: 'StevenzUltra', repo: 'sbb', releaseType: 'release' }],
};

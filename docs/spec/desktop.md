# SBB desktop (M4)

`desktop/` is an Electron shell around `sbb ui`: one window, no IPC, no node integration in
the page. The console stays the web console (web-console.md); the shell only starts the
server and shows its tokenized URL.

## Start-up

1. Probe the user's login shell (`/bin/zsh -lc`) for `PATH`, `node`, `sbb`, `tmux`. A GUI app
   starts with almost no PATH, and the brains run `sbb tell` / `sbb reply` from their panes, so
   the app uses the same `sbb` the brains use whenever one is on PATH.
2. Start `sbb ui --port 0 --no-open --json` (the `sbb` on PATH, else the copy bundled under
   `Contents/Resources/sbb` run with the system Node.js, 22.13 or newer) and read the
   `{ url, port, token }` document it prints.
3. Open a 1440x900 window (`titleBarStyle: hiddenInset`, macOS vibrancy `under-window`
   with a transparent background colour), load the URL with `&shell=desktop`, and inject a
   few lines of CSS so the header leaves room for the traffic lights and drags the window.
   With `shell=desktop` the page marks `<html data-shell="desktop">`, defaults to the dark
   theme, paints only a thin dark tint instead of an opaque ground, and turns the panels and
   the terminal frame into translucent glass (`web/src/style.css`), so the desktop looks like
   a terminal with background blur.
4. On quit, stop the server. If the server dies, the app quits.

Missing tmux or Node.js is an error dialog, not a blank window.

## Build

```
cd desktop && npm install && npm run dist      # release/SBB-<version>-arm64.dmg (+ zip)
npm run smoke                                  # starts, loads, screenshots to smoke.png, quits
```

Unsigned, not notarized: a locally built app opens without Gatekeeper prompts; a downloaded
one needs a right-click Open the first time. The app icon is built by electron-builder from
`desktop/build/icon.png` (the project mark on a dark rounded square; source in
`docs/readme/logo-source.png`).

## Updates

The update feed is the project's GitHub Releases (`electron-builder.config.cjs`,
`publish: github`), so every copy taken from the repo checks the same place. On launch, and
from SBB > 检查更新…, the app compares its version with the latest release, downloads a newer
one in the background, and offers a restart (`electron-updater`; a declined restart installs on
quit). Nothing but the version check leaves the machine; there is no telemetry.

macOS applies an update only to a signed app. Releases are therefore built on a maintainer's
Mac with a **Developer ID Application** certificate in the keychain (the config signs only
with that kind of certificate; Apple Development or Distribution certificates are never
used) and, when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set in the
environment, notarized. Nothing of that is in the repo: certificates live in the keychain,
credentials in the environment, the GitHub token in `GH_TOKEN`.

```
cd desktop && npm run release      # build, sign, notarize, upload dmg + zip + latest-mac.yml
npm run dist                       # local build only (ad-hoc signed without Developer ID)
```

An ad-hoc signed local build runs, but will not auto-update; a release built without the
certificate would leave every installed copy on that version.

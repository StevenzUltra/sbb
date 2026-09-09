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
one needs a right-click Open the first time. The app icon is a placeholder until the project
icon lands.

# Task M3-h2: the web console (Vue 3)

Branch `m3/h2-web`, worktree `~/developer/sbb-worktrees/h2` (branch from `origin/main`).
Spec: `docs/spec/web-console.md` (screens, stack, quality bar) and `docs/spec/ui-server.md` (the API
you consume). Visual reference: `docs/design/console/*.html` — open them in a browser and match them;
tokens in `docs/design/tokens.css`.

You own: everything under `web/` (a new package: `web/package.json`, Vite config, `src/`), plus
`test/web-build.test.js` (asserts `npm --prefix web run build` produces `web/dist/index.html`; skip
when `web/node_modules` is absent). Do not touch `src/`.

## Deliverables

1. Package scaffold: Vue 3 + Vite + Tailwind v4 + Pinia + `@vue-flow/core` + `@xterm/xterm` +
   `@xterm/addon-fit`; brand tokens as `@theme`; `.dark` class theming; no other dependency.
2. Store `useSbb`: loads `/api/state`, applies SSE events, exposes actions that call `/api/*` with
   the token; a fixture mode (`VITE_SBB_FIXTURE=1`) that serves the snapshot and a scripted event
   stream from `web/fixtures/` so the UI runs and can be screenshot without a server.
3. Screens and components from the spec: `TopBar`, `BrainTree`, `ConversationStream`, `Composer`,
   `BrainPane` (xterm over the pane WebSocket, 在此输入 mode ring, 去终端), `TpsBar`, `HeldCard`,
   `PolicyCard`, `SpawnDialog`, `MoveConfirm`, `KillConfirm`, `OrgChart` (Vue Flow, drag-to-transfer),
   `ReceiptLog`.
4. Keyboard shortcuts and empty states per the spec.
5. Screenshots: with the fixture mode, capture the four reference states at 1440x900 in both themes
   (Playwright from `node_modules/.pnpm/playwright@*` if present on this machine, else Chrome headless)
   into `docs/reports/m3-h2-screens/` and compare side by side with the mockups in your report.

## Acceptance

- `npm --prefix web run build` succeeds; `npm test` (root) stays green.
- Fixture mode renders all four states without console errors; real mode works against h1's
  `sbb ui` once it lands (say which you verified).
- Report `docs/reports/m3-h2-<date>.md` with the screenshots, then `sbb reply` to the lead.

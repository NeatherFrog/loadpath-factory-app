# RetroDrop Dashboard — notes for Claude

- Electron + React (Vite) + TypeScript desktop app. Main process bundled by esbuild (`scripts/build.mjs`), renderer by Vite.
- All npm packages are devDependencies on purpose: everything is bundled, so the installer ships no node_modules.
- **Shipping an update to the user** = bump `version` in `package.json`, rewrite `RELEASE_NOTES.md` (shown on the GitHub release), push to `main`. `.github/workflows/release.yml` builds the Windows installer and publishes a GitHub Release; electron-updater in the app installs it. Without a version bump nothing is released.
- **Research data** (`data/projects.json`) is fetched by the app from `main` on GitHub — bump its `version` field when editing so caches refresh. No app release needed.
- Before pushing: `npm run typecheck && npm test && npm run build`.
- Bot safety rules live in `src/main/bot/engine.ts` (hedge exactly the filled size, unwind on failed hedge, delta checks, daily loss limit). Keep them covered by `tests/engine.test.ts`.
- Autopilot strategies (`AutopilotConfig.strategy`): `entropy` (default; Entropy = Hyperliquid HIP-3 dex `io`, hedged on trade.xyz dex `xyz`, one HL account in Unified mode, isolated margin guarded by `src/main/bot/marginGuard.ts`, volume by rolling the hold) and `nado` (Nado vs Lighter + churn engine).
- UI language: Russian.
- Releases are published from `NeatherFrog/loadpath-factory-app` (repo could not be renamed/created from Claude's GitHub access). `index.html`, `privacy.html`, `usage.html`, `style.css` at the root are the old AXIS Video Factory public pages (GitHub Pages) — they are unrelated to the app; keep them unless the user says they are no longer needed.
- UX rule from the user: the main screens (Главная, Мои поинты, Настройки) must stay understandable to a beginner — plain Russian, no jargon (bps, APR, OI, delta) and one clear action. Detailed tools live under «Ещё (для продвинутых)».

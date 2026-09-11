# Flow Command Architecture

Minimal, Mac-first Tauri 2 desktop shell for Flow Gardens tools.

## Process Model

**Current (Phase 1 — Dashboard Wrap)**
```
Flow Command (Tauri main process)
  └─ WebView (React shell at localhost:1420)
       └─ iframe → Flow Gardens Dashboard (localhost:5173)
            ├─ Vite dev server (port 5173)
            └─ Express API (port 3000)
```

- **Tauri main**: native macOS window, menu, system tray.
- **Shell UI**: React app (this repo) renders chrome + sidebar + iframe.
- **Dashboard**: Vite + Express from `flow-gardens-dashboard` repo (run separately in dev).
- **Dev workflow**: Two processes — `npm run tauri dev` (shell) + `npm run dev` (dashboard).

**Production Path (Documented, Not Yet Implemented)**
```
Flow Command bundle
  ├─ Tauri main
  ├─ Shell UI (static assets in bundle)
  └─ Express sidecar (external bin spawned at runtime)
```

- Use Tauri `externalBin` or shell spawn to launch Express API.
- Serve dashboard static build (`dist/`) via Express at runtime.
- Shell iframe points to `http://localhost:3000` (Express).

**Phase 2 (FGINV — Separate WebView to Hosted App)**
```
Flow Command bundle
  ├─ Tauri main
  ├─ Shell UI
  ├─ Express sidecar (Dashboard API, port 3000)
  └─ FGINV WebView → https://fginv.netlify.app (or custom domain)
```

- **FGINV** is Next.js 16 + Supabase from [`fginv` repo](https://github.com/chasecurtis1991/fginv).
- **Deployment**: FGINV is hosted on Netlify (or Vercel) with Supabase cloud DB.
- **Integration**: Shell sidebar "Inventory → FGINV" opens a **separate Tauri WebView** (not iframe) pointing to the hosted URL.
- **Why not sidecar?**
  - Port conflict: Dashboard Express uses port 3000; FGINV `next dev` also defaults to 3000.
  - No local FGINV checkout on Mac (only review artifacts).
  - FGINV has Supabase dependency; simpler to point at hosted app than bundle Next.js standalone + Supabase local.
- **Future option**: If offline mode needed, explore local Docker Supabase + Next.js sidecar on port 3001.

## Secrets Management

**Never bundle secrets in the app.**

**Current (Phase 1 Dev)**
- **Dashboard** uses `.env` (dotenv on disk) — NOT copied into Flow Command.
- **FGINV** uses DB token encryption (`TOKEN_ENCRYPTION_KEY`) + Netlify environment variables.
- Dev workflow: secrets live in respective repos only; Flow Command has no secrets in Phase 1.

**Production (Mac)**
- Store secrets in **macOS Keychain** via Tauri plugin: [`tauri-plugin-keyring`](https://github.com/tauri-apps/tauri-plugin-keyring).
- On first launch, prompt for:
  - Shopify Client ID / Secret
  - Shop domains
  - OpenRouter API key
  - Google Service Account JSON
- Write to Keychain, read at runtime, pass to sidecar Express/Next.js via env vars.

**Windows Later**
- Use Windows Credential Manager (same Tauri plugin supports it).

**Pattern**: Reuse Hemp Dashboard credential flow. Flow Command fetches from Keychain → spawns sidecar with env vars injected.

## Update Strategy

**macOS**
- Use [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) (official Tauri 2 plugin).
- Host update manifests + signed `.dmg` bundles (S3 / GitHub Releases / Vercel Blob).
- In-app "Check for Updates" in Settings.
- Consider Sparkle integration if Tauri updater is insufficient.

**Windows Later**
- Tauri updater supports Windows (`.msi` / `.nsis`).
- May need separate signing cert.

## Open Blockers

**Apple Developer Signing/Notarization**
- Flow Command must be signed + notarized for Gatekeeper (required for macOS distribution).
- Need Apple Developer account ($99/year).
- Use `codesign` + `xcrun notarytool` (or Xcode) in build pipeline.
- Tauri CLI supports signing via `tauri.conf.json` → `bundle.macOS.signing`.

**Rust Toolchain on Mac**
- Local builds require **Rust** (not yet installed on Chase's Mac) + Xcode Command Line Tools (✅ present).
- Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Mac has Node 26.x + bun installed.
- `@tauri-apps/cli` resolves via npx but cannot compile without Rust toolchain.
- Cloud Linux (this environment) can validate structure but not build `.app` / `.dmg` for macOS.

**FGINV Integration (Hosted WebView)**
- **Port conflict**: Dashboard Express (port 3000) and FGINV `next dev` (default 3000) clash.
- **No local FGINV checkout**: Only `fginv-review-artifacts` (audit/tree + 807MB zip) on Mac.
- **Phase 2 approach**: Point separate Tauri WebView at hosted FGINV (Netlify/Vercel) instead of local sidecar.
- **Live repo**: https://github.com/chasecurtis1991/fginv
- **Future option**: If offline mode needed, run FGINV on port 3001 + local Docker Supabase (complex; defer).

**Sidecar Binary Paths**
- Tauri `externalBin` expects specific OS-dependent paths.
- Bundle `node` + `express/next` server scripts, or require Node.js installed on user machine.
- Recommend bundling Node binary (e.g., via `pkg` or `nexe`) to avoid dependency on system Node.

## Platform Differences

| Feature               | macOS (Phase 1)         | Windows (Later)            |
|-----------------------|-------------------------|----------------------------|
| Window chrome         | `titleBarStyle: Overlay`| Standard or custom         |
| Keychain              | Keychain Access         | Credential Manager         |
| Signing               | Apple cert + notarize   | Authenticode cert          |
| Updater               | `.dmg` / `.app`         | `.msi` / `.exe`            |
| Webview               | WKWebView (native)      | WebView2 (bundled/system)  |

## Tech Stack

- **Shell**: Tauri 2 (Rust) + React 19 + TypeScript + Vite
- **Dashboard**: Vite + Express (React 19, no TypeScript in original)
- **FGINV**: Next.js 16 + Supabase + TypeScript
- **Styling**: Vanilla CSS (dark theme, iOS Settings aesthetic)

## Development Workflow

**Prerequisites:**
- Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (not yet on Mac)
- Dashboard repo cloned (local path may have spaces; quote carefully in scripts)

**Run Phase 1:**
1. Terminal 1: `cd "/Users/chase/Documents/Dev/Projects/flow gardens dashboard" && npm run dev`
   - Vite dev server: port 5173
   - Express API: port 3000
2. Terminal 2: `cd flow-command && npm run tauri dev` (Tauri shell → iframe to 5173)
3. Edit shell UI in `flow-command/src/`; hot reload via Vite.
4. Dashboard changes hot reload independently.

**Note**: Dashboard local tree is dirty vs `origin/main` (payments feature + edits). Spike references the **GitHub repo pattern**, not a specific checkout state.

## Future: Monorepo?

Option: Merge `flow-gardens-dashboard` + `fginv` into this repo as workspace packages.
- Keep separate `package.json` for each.
- Use `npm workspaces` or `pnpm` workspace.
- Benefit: single repo, unified build.
- Trade-off: larger repo, more complex CI.

**Recommendation**: Keep separate for Phase 1 spike; evaluate monorepo after FGINV embed is stable.

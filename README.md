# Flow Command

Mac-first Tauri 2 desktop shell for Flow Gardens tools (Dashboard + FGINV).

Phase 1 spike: Tauri shell that loads Flow Gardens Dashboard UI.

## Prerequisites

### On macOS (local development)

1. **Rust** (required for Tauri compilation)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   ```
   **Note**: Not yet installed on Chase's Mac; required before first `tauri dev` run.

2. **Xcode Command Line Tools** (✅ already present)
   ```bash
   xcode-select --install
   ```

3. **Node.js** (✅ Node 26.x installed, bun also available)

4. **Flow Gardens Dashboard** (separate repo)
   - Repo: https://github.com/chasecurtis1991/flow-gardens-dashboard
   - Local path may contain spaces (e.g., `"/Users/chase/Documents/Dev/Projects/flow gardens dashboard"`)
   - Install deps: `npm install` in dashboard directory
   - Create `.env` with your secrets (Shopify, OpenRouter, etc.)
   - **Note**: Local tree may be dirty vs `origin/main` (payments feature, etc.)

## Installation

```bash
# Clone this repo
git clone https://github.com/chasecurtis1991/flow-command.git
cd flow-command

# Install dependencies
npm install
```

## Development

### Option 1: Manual (two terminals)

**Terminal 1 — Dashboard (Vite + Express)**
```bash
# If path has spaces, quote it:
cd "/Users/chase/Documents/Dev/Projects/flow gardens dashboard"
npm run dev
# Dashboard at http://localhost:5173, API at http://localhost:3000
```

**Terminal 2 — Flow Command (Tauri shell)**
```bash
cd flow-command
npm run tauri dev
# Tauri window opens, loads dashboard from localhost:5173
```

**First run**: Install Rust before `tauri dev` if not yet installed (see Prerequisites).

### Option 2: Single command (future)
```bash
# TODO: Add concurrently script to start both dashboard + tauri dev
npm run dev:all
```

## Project Structure

```
flow-command/
├── src/                    # React shell UI
│   ├── App.tsx            # Main shell with sidebar + iframe
│   ├── App.css            # Dark theme styles
│   └── main.tsx           # React entry point
├── src-tauri/             # Rust/Tauri backend
│   ├── src/               # Rust source
│   ├── icons/             # App icons
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri config
├── ARCHITECTURE.md        # System design docs
└── README.md              # This file
```

## What This Does (Phase 1)

- **Minimal shell UI**: dark theme, sidebar nav (Home, Orders, Inventory, etc.)
- **Global chrome stubs**: store switcher, ⌘K placeholder, alerts button
- **Dashboard embed**: iframe loads `http://localhost:5173` (Vite dev server)
- **Inventory tabs**: placeholder stubs for Shopify | FGINV toggle

## What's NOT Implemented Yet

- [ ] Production sidecar (bundled Express server)
- [ ] macOS Keychain integration for secrets
- [ ] FGINV integration (Phase 2: separate WebView to hosted Netlify app, not local sidecar)
- [ ] Apple signing/notarization
- [ ] Auto-updater
- [ ] Windows support

**Note**: Phase 2 FGINV will use a **hosted deployment** (Netlify/Vercel) accessed via separate Tauri WebView, not a local Next.js sidecar. This avoids port conflicts (dashboard uses 3000, FGINV defaults to 3000) and Supabase local setup complexity.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## Building for Production

**Note**: This requires macOS with Rust + Xcode installed.

```bash
npm run tauri build
```

Outputs:
- `.app` bundle: `src-tauri/target/release/bundle/macos/Flow Command.app`
- `.dmg` installer: `src-tauri/target/release/bundle/dmg/`

**Not yet configured**:
- Express sidecar bundling
- Code signing
- Notarization

## Configuration

### Tauri Config (`src-tauri/tauri.conf.json`)

```json
{
  "identifier": "com.flowgardens.command",
  "productName": "Flow Command",
  "app": {
    "windows": [
      {
        "title": "Flow Command",
        "width": 1400,
        "height": 900,
        "titleBarStyle": "Overlay"
      }
    ]
  }
}
```

### Dashboard URL

Hardcoded in `src/App.tsx`:
```typescript
const [dashboardUrl] = useState("http://localhost:5173");
```

For production, change to `http://localhost:3000` (Express sidecar).

## Troubleshooting

### "Dashboard not loading"
- Ensure dashboard is running: `npm run dev` in dashboard directory (port 5173)
- If path has spaces, quote it: `cd "/path/to/flow gardens dashboard"`
- Check browser console in DevTools (right-click Tauri window → Inspect)

### "Tauri build fails on Linux"
- This is expected — Tauri macOS builds require macOS.
- Cloud Linux environment can only validate structure, not build `.app`.

### "Rust not found" or "cargo: command not found"
- Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Restart terminal or run `source $HOME/.cargo/env`
- Verify: `cargo --version`

### "Port 3000 already in use"
- Dashboard Express API uses port 3000.
- Stop other processes on port 3000: `lsof -ti:3000 | xargs kill`

## Development Tips

- **Hot reload**: Changes to `src/` hot reload via Vite.
- **Rust changes**: Require `npm run tauri dev` restart.
- **Dashboard changes**: Independent hot reload (no Tauri restart needed).
- **DevTools**: Right-click Tauri window → Inspect Element.

## Next Steps (Phase 2)

1. **Install Rust on Mac** (prerequisite for local builds)
2. Bundle Express as sidecar (`externalBin` in Tauri config)
3. Integrate macOS Keychain for secrets (no `.env` in bundle)
4. **FGINV integration**: Separate WebView → hosted Netlify app (https://fginv.netlify.app or custom domain)
5. Apple Developer signing + notarization
6. Implement auto-updater (`tauri-plugin-updater`)

**FGINV Note**: Phase 2 uses hosted FGINV (Netlify/Vercel) instead of local Next.js sidecar to avoid:
- Port conflict with dashboard (both default to 3000)
- Supabase local setup complexity
- No local FGINV checkout needed

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full roadmap.

## License

Private — Flow Gardens internal use only.

## Contact

Chase Curtis · [GitHub](https://github.com/chasecurtis1991)

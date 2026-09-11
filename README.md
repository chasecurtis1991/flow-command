# Flow Command

Mac-first Tauri 2 desktop shell for Flow Gardens tools (Dashboard + FGINV).

Phase 1 spike: Tauri shell that loads Flow Gardens Dashboard UI.

## Prerequisites

### On macOS (local development)

1. **Rust** (required for Tauri)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   ```

2. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

3. **Node.js** (v18+)
   - Install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org)

4. **Flow Gardens Dashboard** (separate repo)
   - Clone `flow-gardens-dashboard` repo alongside this one.
   - Install deps: `cd flow-gardens-dashboard && npm install`
   - Create `.env` with your secrets (Shopify, OpenRouter, etc.)

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
cd ../flow-gardens-dashboard
npm run dev
# Dashboard at http://localhost:5173, API at http://localhost:3000
```

**Terminal 2 — Flow Command (Tauri shell)**
```bash
cd flow-command
npm run tauri dev
# Tauri window opens, loads dashboard from localhost:5173
```

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
- [ ] FGINV (Next.js) embed
- [ ] Apple signing/notarization
- [ ] Auto-updater
- [ ] Windows support

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
- Ensure `flow-gardens-dashboard` is running on port 5173.
- Check browser console in DevTools (right-click Tauri window → Inspect).

### "Tauri build fails on Linux"
- This is expected — Tauri macOS builds require macOS.
- Cloud Linux environment can only validate structure, not build `.app`.

### "Rust not found"
- Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Restart terminal or run `source $HOME/.cargo/env`.

## Development Tips

- **Hot reload**: Changes to `src/` hot reload via Vite.
- **Rust changes**: Require `npm run tauri dev` restart.
- **Dashboard changes**: Independent hot reload (no Tauri restart needed).
- **DevTools**: Right-click Tauri window → Inspect Element.

## Next Steps (Phase 2)

1. Bundle Express as sidecar (`externalBin` in Tauri config)
2. Integrate macOS Keychain for secrets (no `.env` in bundle)
3. Embed FGINV (Next.js standalone on port 3001)
4. Apple Developer signing + notarization
5. Implement auto-updater (`tauri-plugin-updater`)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full roadmap.

## License

Private — Flow Gardens internal use only.

## Contact

Chase Curtis · [GitHub](https://github.com/chasecurtis1991)

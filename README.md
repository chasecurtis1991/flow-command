# Flow Command

All-in-one Mac desktop app for Flow Gardens company operations. Built with Tauri 2 + React + Rust.

**Not a wrapper** — Flow Command directly integrates with Shopify Admin API via Rust backend commands. No Express sidecar, no iframe.

## Prerequisites

### On macOS

✅ **All installed on Chase's Mac:**

1. **Rust** (installed: `~/.cargo/bin/rustup`)
   - May need `source ~/.cargo/env` in new shells
   - Verify: `cargo --version`

2. **Node.js** (Node 26.x + bun available)

3. **Xcode Command Line Tools** (present)

## Installation

```bash
git clone https://github.com/chasecurtis1991/flow-command.git
cd flow-command
npm install
```

## Development

**Single command** (no separate dashboard process needed):

```bash
npm run tauri dev
```

This starts:
- Vite dev server (localhost:1420)
- Tauri Rust backend with Shopify API integration
- macOS window with React UI

**Hot reload**: Frontend changes reload automatically; Rust changes require restart.

## First-Time Setup

1. Launch Flow Command: `npm run tauri dev`
2. Navigate to **Settings** page
3. Enter your Shopify credentials:
   - **Client ID**: Your Shopify app client ID
   - **Client Secret**: Your Shopify app client secret
4. Click **Save to Keychain** (stores securely in macOS Keychain)
5. Return to **Home** page → click **"Fetch Shop Info"** to test connection

**Note**: Credentials are stored in macOS Keychain under service `"Flow Command"`. Never commit `.env` files with real secrets.

## Project Structure

```
flow-command/
├── src/                          # React frontend
│   ├── App.tsx                   # Router setup
│   ├── App.css                   # Dark theme styles
│   ├── components/
│   │   └── Layout.tsx            # Sidebar + header layout
│   ├── pages/                    # Page components
│   │   ├── Home.tsx              # Dashboard + Shopify test
│   │   ├── Orders.tsx
│   │   ├── Inventory.tsx         # Shopify | FGINV tabs
│   │   ├── Catalog.tsx
│   │   ├── Lab.tsx
│   │   ├── Customers.tsx
│   │   ├── Analytics.tsx
│   │   └── Settings.tsx          # Keychain credential setup
│   └── main.tsx
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── lib.rs                # Tauri commands (Shopify, Keychain)
│   │   └── main.rs
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration
├── ARCHITECTURE.md               # System design (read this!)
└── README.md                     # This file
```

## Features

### Current (Phase 1)

- ✅ Dark-first UI with sidebar navigation
- ✅ Global chrome (store switcher, ⌘K stub, alerts stub)
- ✅ **Shopify integration**:
  - Client credentials OAuth flow
  - Keychain credential storage
  - GraphQL Admin API queries
- ✅ Settings page (Keychain management)
- ✅ Home page (connection test)
- ✅ Page stubs for Orders, Inventory, Catalog, Lab, Customers, Analytics

### Future (Phase 2+)

- [ ] Full order management (CRUD)
- [ ] Product/inventory sync
- [ ] Customer lookups
- [ ] Analytics dashboards
- [ ] FGINV features (built in-app, not iframe)
- [ ] Multi-store aggregation
- [ ] Token caching (Shopify access tokens ~24h)

## Tauri Commands (Rust API)

Frontend calls Rust commands via `invoke`:

```typescript
import { invoke } from "@tauri-apps/api/core";

// Health check
const result = await invoke<string>("ping");

// Save credentials to Keychain
await invoke("save_shopify_credentials", {
  clientId: "...",
  clientSecret: "...",
});

// Fetch shop info (OAuth + GraphQL)
const info = await invoke<any>("fetch_shop_info");
```

**Backend commands** (see `src-tauri/src/lib.rs`):

- `ping()` — health check
- `save_shopify_credentials(client_id, client_secret)` — store to Keychain
- `get_shopify_credentials()` — read from Keychain
- `fetch_shopify_token(shop_domain)` — Shopify client credentials OAuth
- `fetch_shop_info()` — demo GraphQL query (shop name)

## Configuration

### Shopify Stores (hardcoded Phase 1)

```rust
// Default stores (src-tauri/src/lib.rs)
- Retail: flowgardensaz.myshopify.com
- B2B: flowgardensb2b.myshopify.com
- Bulk: flowgardensbulk.myshopify.com
```

**Phase 2**: Make store domains editable in Settings.

### Secrets Storage

**macOS Keychain** via `keyring` crate:

- Service: `"Flow Command"`
- Accounts: `shopify_client_id`, `shopify_client_secret`

**Never commit secrets** — `.gitignore` blocks `.env` files.

## Building for Production

**Internal app** (no Apple signing required):

```bash
npm run tauri build
```

Outputs:
- `.app` bundle: `src-tauri/target/release/bundle/macos/Flow Command.app`
- `.dmg` installer: `src-tauri/target/release/bundle/dmg/`

**Distribution**: Copy `.app` to Applications folder. Manual updates (drag new `.app`).

## Troubleshooting

### "Keychain access denied"
- First run: macOS prompts to allow Flow Command to access Keychain → click **Allow**
- If blocked: System Settings → Privacy & Security → Keychain → add Flow Command

### "Failed to fetch shop info"
- Verify credentials in Settings are correct
- Check shop domain (default: `flowgardensaz.myshopify.com`)
- Ensure Shopify app has Admin API access scope

### "Rust command not found"
- Run `source ~/.cargo/env` in current shell
- Verify: `cargo --version`

### "Port 1420 already in use"
- Kill existing Vite process: `lsof -ti:1420 | xargs kill`

## Development Tips

- **React changes**: Hot reload automatically
- **Rust changes**: Restart `npm run tauri dev`
- **DevTools**: Right-click window → Inspect Element
- **Logs**: Rust logs appear in terminal running `tauri dev`

## Architecture

Flow Command is an **all-in-one Tauri app**, not a wrapper around the old dashboard:

- **Old dashboard**: Vite frontend + Express API proxy → Shopify
- **Flow Command**: React + Rust Tauri commands → Shopify directly

**No Express, no iframe, no external dependencies.**

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

## Reference

**Old dashboard** (behavior reference, not code to copy): https://github.com/chasecurtis1991/flow-gardens-dashboard

**FGINV** (separate app, not embedded): https://github.com/chasecurtis1991/fginv

Flow Command reimplements features natively, targeting **feature parity over time**.

## License

Private — Flow Gardens internal use only.

## Contact

Chase Curtis · [GitHub](https://github.com/chasecurtis1991)

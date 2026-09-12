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

## Browser preview (no Tauri)

`npm run dev` and open http://localhost:1420 in a browser: Tauri `invoke` is mocked with the design's sample orders
(`src/lib/devMock.ts`) so every screen can be reviewed. Screens without a backend yet (inventory, catalog, COAs,
customers, analytics) show a **Sample data** pill in both modes. Use `npm run tauri dev` for live Shopify data.

## Usage

### Orders
1. **Home** → "Fetch Shop Info" verifies connection
2. Navigate to **Orders**
3. Recent orders load automatically (50 most recent)
4. Click any order row → detail panel shows line items, customer, totals
5. Switch store with the segmented switcher in the title bar (or ⌘1 / ⌘2 / ⌘3) → orders auto-refresh
6. Click "Refresh" to reload manually

Order IDs use Shopify GIDs (e.g., `gid://shopify/Order/123456789`).

### Settings
Store Shopify credentials in Keychain:
1. **Settings** → enter client ID & secret
2. Click **Save to Keychain**
3. Credentials persist across app launches

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
  - Token caching (23-hour expiry, reused across commands)
  - GraphQL Admin API queries (API version 2026-01)
  - Active store management
- ✅ **Orders page**:
  - List recent orders (50 most recent)
  - Click order → view detail with line items
  - Respects active store (auto-refreshes on store switch)
  - Loading & error states
- ✅ Settings page (Keychain management)
- ✅ Home page (connection test)
- ✅ Page stubs for Inventory, Catalog, Lab, Customers, Analytics

### Future (Phase 2+)

- [ ] Orders: Filters, search, actions (refund, fulfill, etc.)
- [ ] Product/inventory sync
- [ ] Customer lookups
- [ ] Analytics dashboards
- [ ] FGINV features (built in-app, not iframe)
- [ ] Multi-store data aggregation

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
- `get_active_store()` / `set_active_store(store)` — active store management
- `save_shopify_credentials(client_id, client_secret)` — store to Keychain
- `fetch_shopify_token(shop_domain)` — Shopify client credentials OAuth (legacy, token caching used internally)
- `fetch_shop_info()` — demo GraphQL query (shop name)
- `list_orders(first?)` — list recent orders for active store (default 25, up to 100)
- `get_order(order_id)` — fetch single order detail with line items (uses Shopify GID)

## Configuration

### Shopify Stores (real domains)

```rust
// Store domains (src-tauri/src/lib.rs)
- retail → 3wvfyr-1i.myshopify.com
- b2b → b8h8vg-ij.myshopify.com
- bulk → fg-craft-flower.myshopify.com
```

Active store is managed via header dropdown. Switch stores → Orders page auto-refreshes.

**API version**: `2026-01` (matches dashboard)

### Secrets Storage

**Secrets Storage**

**macOS Keychain** via `keyring` crate with `apple-native` feature:

- Service: `"com.flowgardens.command"`
- Accounts: `shopify_client_id`, `shopify_client_secret`

**Token caching**: Access tokens cached per shop domain with 23-hour expiry. Reused across commands to minimize auth requests.

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

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

`npm run dev` and open http://localhost:1420 in a browser: Tauri `invoke` is mocked with the design's sample orders,
inventory and catalog (`src/lib/devMock.ts`) so every screen can be reviewed. Screens without a backend yet (FGINV
inventory, COAs, customers, analytics) show a **Sample data** pill in both modes; live screens show a **Live** pill.
Use `npm run tauri dev` for live Shopify data.

## Usage

### Orders
1. **Home** → "Fetch Shop Info" verifies connection
2. Navigate to **Orders**
3. The first page of orders loads (50 rows by default, newest first). Page through **every** order with
   **‹ Prev / Next ›** in the footer; the footer shows `1–50 of 312` and `Page 1 of 7` from Shopify's
   `ordersCount` for the current filters (`10,000+` once Shopify stops counting exactly)
4. **Rows** (25 / 50 / 100 / 200) changes the page size and jumps back to page 1
5. Click any order row → detail panel shows line items, customer, totals (↑ ↓ move the selection, ← → page)
6. Switch store with the segmented switcher in the title bar (or ⌘1 / ⌘2 / ⌘3) → orders auto-refresh
7. Click "Refresh" (or ⌘R) to reload the current page

Sorting and filtering on Orders happen in Shopify, so they cover all orders, not just the loaded page:
click a header to sort (`sortKey` + `reverse`), use the header funnel or the search box to filter
(Shopify search syntax: `status:open`, `financial_status:paid`, `fulfillment_status:unfulfilled`, `name:`,
free text). The **Unfulfilled** toggle is a preset of the Fulfillment filter (unfulfilled, partial, on hold,
scheduled) plus `status:open`.

Order IDs use Shopify GIDs (e.g., `gid://shopify/Order/123456789`).

### Table controls (Orders, Catalog table view, Inventory · Shopify)
- **Sort**: click a column header (buttons; `aria-sort` is set). First click uses the column's natural
  direction (dates / amounts descending), the next click flips it.
- **Filter**: hover a header and click the funnel — text columns get a *contains* box, status columns a
  checklist. Active filters show as chips in the toolbar (× clears one, *Clear all* clears them).
- **Reorder**: drag a header onto another one (drop indicator shows before/after), or use ‹ › in the
  **Columns** menu.
- **Show / hide**: **Columns** menu; *Reset* restores the defaults.
- Column order, visibility, sort and (Orders) rows-per-page persist per table in `localStorage`
  (`fc.table.orders`, `fc.table.catalog`, `fc.table.inventory`). Filters are per session.
- Implementation: `src/lib/table.ts` (`useTable`, headless state + client-side apply) and
  `src/components/DataTable.tsx` (`TableHead`, `TableRow`, `ColumnsMenu`, `FilterChips`, `FilterButton`,
  `PageSizePicker`). Catalog / Inventory sort and filter client-side; Orders maps the same state to Shopify.

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
  - Page through every order (cursor pagination, 25 / 50 / 100 / 200 rows per page, real `ordersCount`)
  - Sort and filter in Shopify (sort keys + search syntax), search box, Unfulfilled preset
  - Click order → view detail with line items
  - Respects active store (auto-refreshes on store switch)
  - Loading & error states
- ✅ **Table controls** on Orders, Catalog (table view) and Inventory · Shopify: sort, per-column filters,
  drag-to-reorder, show / hide columns; preferences persist per table
- ✅ **Inventory · Shopify tab**: every variant with per-location on hand / committed / available (falls back to
  products-only counts when `read_inventory` / `read_locations` are missing)
- ✅ **Catalog page**: live products for the active store (title, type, status, variant count, from-price, featured
  image swatch), table + grid views, search and Status / Type filters, Sync now; needs `read_products`
- ✅ Settings page (Keychain management)
- ✅ Home page (connection test)
- ✅ Page stubs for FGINV inventory, Lab, Customers, Analytics

### Future (Phase 2+)

- [ ] Orders: Filters, search, actions (refund, fulfill, etc.)
- [ ] Catalog: cross-store presence ("Visible in" across Retail / B2B / Bulk), product detail, create/edit
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
- `list_orders(first?)` — most recent orders for the active store (default 50, up to 200; Home KPIs, badge, ⌘K)
- `list_orders_page(first?, after?, sort_key?, reverse?, query?)` — one page of orders for the Orders table:
  cursor pagination, page size ≤ 200 (a 200-row page costs ~803 of Shopify's 1,000-point single-query budget),
  `OrderSortKeys` subset, Shopify search-syntax `query`; returns `{ orders, hasNextPage, endCursor,
  totalCount, totalPrecision }` (`ordersCount(limit: 10000)` for the same query)
- `get_order(order_id)` — fetch single order detail with line items (uses Shopify GID)
- `list_inventory()` — every variant of the active store with per-location quantities (up to 1,500)
- `list_products()` — every product of the active store, title-sorted, with variant count, price range, status and
  featured image (50 per page, up to 1,000; `truncated: true` past that)

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

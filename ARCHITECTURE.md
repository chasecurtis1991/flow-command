# Flow Command Architecture

All-in-one internal Mac desktop app for Flow Gardens company operations.

## Product Vision

Flow Command is a **native Tauri desktop application** that provides Flow Gardens with a unified interface for managing operations across multiple stores (Retail, B2B, Bulk). It directly integrates with Shopify Admin API and other services via Rust backend commands.

**Not a wrapper** — Flow Command is a standalone app with its own React UI and Rust backend, not an iframe shell around the old dashboard.

## Process Model

```
Flow Command (single Tauri process)
  ├─ Tauri main process (Rust)
  │   ├─ Shopify Admin API integration
  │   ├─ macOS Keychain for secrets
  │   └─ Future: other service integrations
  └─ WebView (React + TypeScript + Vite)
      └─ Client-side routing (react-router-dom)
```

**All-in-one architecture:**
- **Frontend**: React 19 + TypeScript + Vite, dark-first UI (iOS Settings + Grok Bot aesthetic)
- **Backend**: Tauri commands in Rust call external APIs directly (Shopify, future integrations)
- **No Express sidecar**, no iframe, no external dashboard dependency
- **macOS Keychain** stores Shopify credentials securely

## Navigation Structure

**Sidebar Pages:**
- **Home**: System status, Shopify connection test, quick stats
- **Orders**: Order management across stores (coming soon)
- **Inventory**: 
  - Shopify tab: Product/variant inventory
  - FGINV tab: Internal inventory features (future in-app implementation)
- **Catalog**: Product catalog management
- **Lab / COAs**: Certificate of Analysis tracking
- **Customers**: Customer relationship management
- **Analytics**: Sales and operational metrics
- **Settings**: Shopify credentials (Keychain), store configuration

**Global Chrome:**
- Store switcher: Flow Gardens (Retail) | Flow Gardens B2B | Flow Gardens Bulk
- ⌘K: Search (stub)
- 🔔: Alerts (stub)

## Shopify Integration

### Authentication Flow

Flow Command uses **Shopify client credentials OAuth** (24-hour token lifetime):

1. User enters Shopify client ID & secret in Settings → saved to macOS Keychain
2. On API call, Rust command:
   - Reads credentials from Keychain
   - POST to `https://{shop}.myshopify.com/admin/oauth/access_token`
   - Params: `client_id`, `client_secret`, `grant_type=client_credentials`
   - Receives `access_token` (~24h validity)
3. Use token for GraphQL/REST Admin API calls
4. Handle token expiry: retry auth flow on 401

### Shopify Admin API

**GraphQL endpoint**: `https://{shop}.myshopify.com/admin/api/2024-01/graphql.json`

**Stores (hardcoded for Phase 1):**
- Retail: `flowgardensaz.myshopify.com`
- B2B: `flowgardensb2b.myshopify.com`
- Bulk: `flowgardensbulk.myshopify.com`

**Phase 2**: Store domains configurable in Settings, multi-store queries.

### Reference Implementation

The old **flow-gardens-dashboard** (Vite/React + Express) is a **behavior reference**, not code to copy wholesale. Flow Command reimplements features as Tauri commands + React pages:

- Dashboard: Express proxy → Shopify API
- Flow Command: Rust commands → Shopify API directly

**Feature parity over time**, not a port.

## Secrets Management

**macOS Keychain** via [`keyring` crate](https://crates.io/crates/keyring):

```rust
// Save credentials
keyring::Entry::new("Flow Command", "shopify_client_id")?
    .set_password(&client_id)?;

// Read credentials
let client_id = keyring::Entry::new("Flow Command", "shopify_client_id")?
    .get_password()?;
```

**Credential storage:**
- Service: `"Flow Command"`
- Accounts: `shopify_client_id`, `shopify_client_secret`

**Never bundle `.env` files** — all secrets go through Keychain.

**Linux/CI**: Keychain calls may fail on non-macOS. Feature-gate with `#[cfg(target_os = "macos")]` and return stub errors on other platforms. Phase 1 is Mac-only.

## Tauri Commands (Rust ↔ React)

**Current (Phase 1):**

- `ping()` → health check, returns `"Flow Command is running ✓"`
- `save_shopify_credentials(client_id, client_secret)` → save to Keychain
- `get_shopify_credentials()` → read from Keychain
- `fetch_shopify_token(shop_domain)` → client credentials OAuth
- `fetch_shop_info()` → demo GraphQL query (shop name)

**Future (Phase 2+):**

- Order queries (recent, search, filters)
- Product/inventory queries
- Customer lookups
- Analytics aggregations
- FGINV internal features (not iframe — native UI + backend)

## Development Workflow

**Single repo, single process:**

```bash
cd flow-command
npm install
npm run tauri dev
```

Tauri runs Vite dev server (localhost:1420) + Rust backend together.

**Hot reload**: Frontend changes reload via Vite; Rust changes require restart.

**No separate dashboard process** — Flow Command is self-contained.

## Configuration

**Shopify Credentials (Phase 1 setup):**

1. Launch Flow Command: `npm run tauri dev`
2. Navigate to Settings
3. Enter Shopify client ID & secret → Save to Keychain
4. Return to Home → click "Fetch Shop Info" to test

**Store domains** hardcoded for Phase 1 (`flowgardensaz.myshopify.com`). Phase 2: editable in Settings.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + react-router-dom
- **Backend**: Tauri 2 (Rust)
- **HTTP client**: `reqwest` (async)
- **Secrets**: `keyring` crate (macOS Keychain)
- **Styling**: Vanilla CSS (dark theme)

**No Express, no iframe, no sidecar.**

## Platform Support

### macOS (Phase 1)
- Primary target
- Native WKWebView
- Keychain for secrets
- Ad-hoc local builds (no signing needed — internal app)

### Windows (Future)
- Tauri supports WebView2
- Windows Credential Manager (via `keyring` crate)
- Adjust window chrome (`titleBarStyle` not supported)

### Linux
- Not planned (internal app, Mac-first)

## Distribution

**Internal proprietary app** for Flow Gardens only.

**No Apple Developer signing/notarization required** — ad-hoc local builds sufficient.

**Build process:**
```bash
npm run tauri build
```

Output: `.app` bundle in `src-tauri/target/release/bundle/macos/`

**Updates**: Manual (drag new `.app` to Applications). Phase 2: consider `tauri-plugin-updater` if frequent updates needed.

## Differences from Old Dashboard

| Aspect | Old Dashboard | Flow Command |
|--------|---------------|--------------|
| **Architecture** | Vite frontend + Express API proxy | Tauri all-in-one (React + Rust) |
| **Deployment** | Two processes (Vite dev + Express) | Single process (Tauri) |
| **API calls** | Express middleware → Shopify | Rust commands → Shopify |
| **Secrets** | `.env` files (dotenv) | macOS Keychain |
| **Distribution** | Web app (dev server) | Native desktop app (`.app`) |
| **FGINV** | Separate hosted Next.js app | Future in-app features (Phase 2) |

## FGINV Future (Phase 2)

**Not an iframe to hosted Netlify** — FGINV features will be built **directly into Flow Command** as:

- New Inventory sub-pages (beyond Shopify tab)
- Rust commands for internal inventory logic
- Potentially separate backend service if complex, but accessed via Tauri commands

No external Next.js app, no Supabase hosted dependency inside Flow Command.

## Open Items (Phase 2+)

1. **Store configuration**: Editable domains for Retail/B2B/Bulk
2. **Token caching**: Cache Shopify access tokens (~24h lifetime) to avoid repeated auth
3. **Error handling**: User-friendly error messages for Keychain/API failures
4. **Multi-store queries**: Aggregate data across stores
5. **Orders UI**: Full CRUD for Shopify orders
6. **Inventory sync**: Real-time or polling for stock levels
7. **FGINV integration**: Native in-app inventory management features
8. **Analytics**: Charts/graphs (consider charting library)
9. **Auto-updater**: `tauri-plugin-updater` if frequent releases

## Security

- **Keychain** for secrets (never commit `.env` with real credentials)
- **CSP**: Tauri security config (no `dangerousRemoteDomainIpcAccess` — removed)
- **API keys**: Shopify client credentials only; no public exposure

## References

- **Old dashboard repo** (behavior reference): https://github.com/chasecurtis1991/flow-gardens-dashboard
- **FGINV repo** (separate app, not embedded): https://github.com/chasecurtis1991/fginv
- **Shopify Admin API**: https://shopify.dev/docs/api/admin
- **Tauri docs**: https://v2.tauri.app/
- **keyring crate**: https://docs.rs/keyring/latest/keyring/

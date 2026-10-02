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

**Keychain prompts**: debug binaries are re-signed with the local "LocalFlow Signing" certificate before they run
(`src-tauri/scripts/sign-dev.sh`, wired as a cargo runner in `src-tauri/.cargo/config.toml`), and `tauri build`
signs the .app with the same identity (`bundle.macOS.signingIdentity`). The signature is therefore identical across
builds, so clicking **Always Allow** once per Keychain item (3 items) makes macOS stop asking on every rebuild. On a
Mac without that certificate the script runs the binary unsigned (prompts return); create one in Keychain Access →
Certificate Assistant → Create a Certificate, type *Code Signing*, named `LocalFlow Signing`.

## Browser preview (no Tauri)

`npm run dev` and open http://localhost:1420 in a browser: Tauri `invoke` is mocked with the design's sample orders,
inventory, catalog, customers, analytics and COAs (`src/lib/devMock.ts`) so every screen can be reviewed. Surfaces
without a backend yet (FGINV inventory, the inventory-drift chart) show a **Sample data** pill in both modes; live
screens show a **Live** pill. Use `npm run tauri dev` for live Shopify data.

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

### Orders: notes & tags
In the order detail pane, **Notes & tags → Edit** lets you change the note, remove tags (× strikes one out; click again
to keep it) and add tags (type, then Enter or comma). The footer summarises the change; **Save to Shopify** (or ⌘↩ in
the note) sends only what changed. Tags go through `tagsAdd` / `tagsRemove`, so tags you didn't touch — or that
another app added meanwhile — are kept. The note is re-read first: if someone changed it since the order loaded, the
save is refused and **Reload order** shows the current one. Retrying after a network error is safe. The store is
pinned when you click Edit. Needs `write_orders`.

### Table controls (Orders, Catalog table view, Inventory · Shopify)
- **Sort**: click a column header (buttons; `aria-sort` is set). First click uses the column's natural
  direction (dates / amounts descending), the next click flips it.
- **Filter**: hover a header and click the funnel — text columns get a *contains* box, status columns a
  checklist. Active filters show as chips in the toolbar (× clears one, *Clear all* clears them).
- **Reorder**: drag a header onto another one (drop indicator shows before/after), or use ‹ › in the
  **Columns** menu.
- **Show / hide**: **Columns** menu; *Reset* restores the defaults.
- **Inventory tree**: on Inventory · Shopify, products are the rows and variants are branches — click a product
  (or its ›) to expand it, or use **Expand all** / **Collapse all** in the toolbar; search and *Low stock only*
  auto-expand their matches. Route's "Shipping Protection by Route" app product is hidden from Inventory (it
  stays in Shopify).
- Column order, visibility, sort and (Orders) rows-per-page persist per table in `localStorage`
  (`fc.table.orders`, `fc.table.catalog`, `fc.table.inventory`). Filters are per session.
- Implementation: `src/lib/table.ts` (`useTable`, headless state + client-side apply) and
  `src/components/DataTable.tsx` (`TableHead`, `TableRow`, `ColumnsMenu`, `FilterChips`, `FilterButton`,
  `PageSizePicker`). Catalog / Inventory sort and filter client-side; Orders maps the same state to Shopify.

### Inventory: Adjust stock
On Inventory · Shopify, **±** on a variant row (or a single-variant product row) opens **Adjust stock**. Pick the location
and a reason (correction, cycle count, damaged, shrinkage, received, restock, promotion / sample, other), then enter
either **Change by ±** (`-2` removes two) or **Counted available** (the app works out the difference). The review shows
available and on-hand before → after; **Apply** writes it with `inventoryAdjustQuantities` on the `available` state.

Safety: the store is pinned when the dialog opens, the count you saw is sent as `changeFromQuantity` (if it moved in
Shopify meanwhile the write is refused — **Sync & close** and review again), and each reviewed change carries an
idempotency key, so **Retry** after a network error can't apply it twice. After the write the level is re-read from
Shopify and the table refreshes. Untracked items have no ±. Needs `write_inventory`. Only the first 3 locations per
item are loaded. Shopify is treated as the owner of these counts until FGINV has a backend.

### Inventory: Receive and Transfer
**Receive** and **Transfer** in the Inventory · Shopify toolbar (also the FGINV tab's cards; Receive also from Home's
*Receive inventory*, ⌘⇧R and the ⌘K palette) open a multi-line form: pick the location(s), search items by product,
variant or SKU, enter quantities, and review each line's available count before → after.
- **Receive** adds units at one location with reason *Received*. An optional lot / PO / supplier reference is stored
  as Shopify's `referenceDocumentUri` (`flowcommand://receive/<ref>`) so it shows in the item's inventory history.
- **Transfer** moves units from one location to another: each item becomes −N at the source and +N at the
  destination (reason *Correction*, reference `flowcommand://transfer/T-YYYYMMDD-HHMM`). You can't move more than is
  available at the source. Stores with a single location (Retail: Flow NC) say there's nowhere to transfer to.

Every line of a request goes in **one** `inventoryAdjustQuantities` call, so Shopify applies all of it or none, with
the same compare-and-swap counts and idempotency key as Adjust. Items must already be stocked at the chosen location(s).
The old FGINV "Receive lot" sheet (sample data only) is gone.

### Customers
The top 100 customers of the active store, most recently updated first, with orders, lifetime spend, company,
location and last order. The search box runs in Shopify (relevance-ranked, so it covers every customer, not just
the 100 shown); the toolbar count says `Showing 100 of 4,213 · search to narrow` when there are more. Column
filters, sort and **Columns** work like the other tables; **Sync now** refetches. Needs `read_customers`.

### Analytics
Orders per day and per-store Orders / Revenue / Avg order for the last **7 / 14 / 30** days, derived from each
store's orders (`list_orders_since`, all three stores fetched in parallel; cancelled and test orders excluded). No
ShopifyQL, so no `read_reports` scope is needed. Days are bucketed in the Mac's local time. A store that can't be
reached shows **Unreachable** with its own Retry. The inventory-drift chart is still sample data (FGINV has no backend).

### Catalog: Visible in, Open in Shopify
**Visible in** shows a chip for every store where the product is active. The active store answers from the product
itself; the other two come from a lightweight id / handle / title / status list per store, matched by handle, then
by title (a heuristic until the stores share a SKU or metafield key). Hover a cell for the full picture
(`Active in Retail · Draft in B2B · Not listed in Bulk`); the header funnel filters on store names. The **↗** at
the end of Catalog and Customers rows (and on grid cards) opens the product or customer in Shopify admin; the
Orders detail panel has the same button.

### Catalog: Split variants into draft products
In Catalog's table or grid, choose **Split variants** on a product, review the names, prices, SKUs and destination
store, then click **Create N drafts**. Each variant becomes one separate product named `Product — Variant` with a
single variant. The original product and its inventory are untouched.

Copies retain store-currency prices and compare-at prices, SKUs, barcodes, options, tax and inventory policies,
cost, shipping requirement, weight, customs codes, description, vendor, type, tags, category, SEO, theme template,
manual collection membership, and the entire media gallery (variant photo first). Product and variant metafields
are paged and copied to their respective owners, preserving namespace, key, type and value. Fields Shopify refuses
to write are identified in each result's copy notes. New IDs and stable `flow-split-<variant-id>` handles are assigned.
Every new product is **DRAFT**, with inventory tracking enabled and on-hand stock explicitly set to **0 at every
active location**, including fulfillment-service locations. All returned inventory locations are checked for zero
available, on-hand and committed stock before the copy is reported as finished. Inactive locations cannot receive
stock and are not activated.

The preview pins the store even if the app's active store changes. Progress is shown per variant; **Stop after
current** pauses the loop without interrupting a create request. **Retry / continue** skips completed copies.
Receipts under the app data directory's `variant-splits/` folder and the `flow_command.variant_split` product
metafield protect retries across restarts. An uncertain create timeout is looked up by its reserved handle; if
Shopify cannot confirm the outcome, the tool refuses another create. A partial Shopify create error requires
review of the existing draft rather than silently considering it complete. Do not delete receipts or change
reserved handles while recovering an interrupted run.

Requires `write_products`, `read_inventory` (included by `write_inventory`), `write_inventory`, `read_locations`,
and `write_files`. Gift cards and bundle variants are blocked. Market/B2B price lists, translations, subscription
memberships, custom shipping profiles, option-to-metafield links, hidden app data, history and channel publishing
are not copied; automatic collections follow their rules. Subscription-only flags are retained and the result
asks you to reconnect selling plans before publishing. The browser preview simulates splits using sample data;
it never creates real Shopify products.

**SKU handling:** the source variant's SKU is copied verbatim, including any legacy format; a missing SKU stays
blank. Splitting does not generate, normalize, or replace SKUs. The preview's **41 Kings**, **Alien Grapevine**,
and **The White CBG** fixtures use the exact strain codes from the
[Flow Gardens SKU Structure guide](https://docs.google.com/spreadsheets/d/1jfND_4YKWKH5IgWBefIRPnRBy-QLO3Bl5t1okblIne0/edit)
(for example, `RF07-14KX`, `RF07-1ZCW`, and `RF07-4TWC`). Their prices and inventory are samples. Older design
fixtures retain their stored sample SKUs and are labeled as legacy data; the preview never invents a SKU from a
product title or handle.

Commands: `prepare_variant_split(store_id, product_id)`, `split_product_variant(plan_id, variant_id)`, and
`release_variant_split(plan_id)`. Implementation: `src-tauri/src/variant_split.rs` and
`src/pages/VariantSplitDialog.tsx`.

### Lab / COAs
Every COA PDF in the **retail** store's Files library (COAs live in one store), cross-checked three ways: the
`coa_record` metaobjects, the linked product's `coa` metafield / publish state, and a scrape of
`flowgardens.com/pages/coa` (the status line says `cross-checked … · found N CDN URLs`). Four views, kept in `?view=`:
- **Table** — sort / filter / columns like the other tables; State and Posted segs are presets of the header
  filters, **Owner** filters on the parsed brand. Click a row for the detail pane: inline PDF, editable cannabinoids
  and metadata (commit on blur / Enter), posted reason with a *view live* link, terpenes, notes, **Re-link**
  (retail product title search) and **Clear edits**. **↗** opens the PDF.
- **Calendar** — expirations on a month grid (chips: red < 7 d, amber < 30 d, green, grey expired), lab filter;
  click a chip to open it in the table.
- **Labs** — per-lab COAs, % parsed, average THCa, issued range and a 12-month sparkline; click a row to filter the
  table to that lab.
- **Link** — unlinked, non-expired COAs on the left, a product search on the right, **Link COA** in the footer.

**Parsing (OpenRouter).** Lab, owner, batch, cannabinoids, terpenes and dates come from an LLM read of the PDF.
Put an OpenRouter key in **Settings → OpenRouter · COA parsing** (Keychain; optional model id, blank = server
default), then on the Lab page **Parse 5** / **Parse all (N)** send the unparsed and *stale* rows (parsed with an
older prompt — amber `AI` flag and `· N stale` in the toolbar) through `parse_coas`, 4 PDFs at a time at roughly
10–40 s each; the toast says `Parsed N · M failed · S s` plus the first error, and the list re-pulls. The detail
pane shows the provenance (`Parsed by <model> · <date>`) and **Re-parse** forces one file. The parse cache was seeded
from the old dashboard, so already-parsed COAs are not re-sent. Without a key the buttons are disabled and the
toolbar says `no OpenRouter key`.

**Import wizard (Upload → Extract → Map → Import).** **Import COA** opens it on local PDFs; **Bulk import (N)** opens
it on the unposted COAs in the current table (25 at a time — run it again for the rest); the detail pane's **Import…**
opens it on that one COA. Library rows skip the upload leg.
1. **Upload** — drop or pick PDFs; **Upload N** stages them one at a time into the retail Files library
   (`upload_coa_pdf`, ~20 s each while the CDN URL propagates). Esc / Cancel asks before closing once files are
   uploaded but not imported (they stay in Files).
2. **Extract** — with an OpenRouter key the new uploads are parsed on entry (`parse_coas`, then the list is re-pulled
   so the parsed fields and the filename auto-match land in the rows); without one the fields are filled by hand.
   Batch, issued, expires (blank = issued + 1 year), lab, owner, THCa / CBDa / CBG / total, notes, QR present and a
   terpene editor (library names or free text + %). Hand edits are never overwritten by a parse. Next needs at least
   a batch, a lab or a cannabinoid per row.
3. **Map** — a retail product search per row (auto-match prefilled, **Clear** to unlink) and the **Page name**: the
   block title on flowgardens.com/pages/coa and the coa_record's display title (defaults to the product title).
   Linking is optional; only linked COAs get the product's `custom.coa_records` entry.
4. **Import** — **Post to flowgardens.com/pages/coa** (default on) then **Import N COAs** runs `import_coa` per row and
   shows a ✓/✗ chip per step: `terpenes` (names mapped to the terpene library; unknown ones are listed in amber),
   `coa_record` (metaobject, `ACTIVE` when posting, `DRAFT` when not), `product link` (`custom.coa_records` on the
   linked product), `/pages/coa` (the theme template block — a backup of the template is saved under the app data
   dir before every write; skipped when posting is off) and `cache` (the parsed-fields cache). The Done panel says
   `Imported N · M failed`; **Close** re-pulls the list and toasts.

**Repost to /pages/coa** (detail pane) re-writes just that COA's block on the public page via `repost_coas` (toast
`Reposted · updated|added`) — for COAs whose block went missing or whose name changed. The block name is the explicit
name, else the Sheet's name for that batch, else the manual link's product title, else the cleaned filename.

**Google Drive + Sheet mirror** (step 4's second toggle, **Mirror to Google Drive + Sheet**, default on once Google is
set up; otherwise disabled with *Set up Google in Settings*). **Settings → Google · COA mirror** takes the
service-account key file path, the Sheet id, the tab (blank = first tab) and the Drive folder id — saved as you type
(`google.*` prefs); **Import from old dashboard** fills them from the old dashboard's `.env`
(`seed_google_config_from_old_env`). Share the Sheet and the Drive folder with the service-account email as Editor
(the old `docs/google-setup.md` walks through the Cloud console), then **Test connection** (`google_status`) shows
that email, the Sheet's title + tabs and the folder name, or the error. With the toggle on, each successful
`import_coa` is followed by `google_mirror_coa`, which adds two chips to the row: `drive` uploads the PDF as
`<page name>.pdf` into the folder (a file with the same name is updated in place, so re-imports never duplicate) and
`sheet` upserts one row on the tab, header-driven: the tab's header row is matched against the old dashboard's column
aliases, the row is keyed on the batch column (product name when there is none), mapped cells are written (blank
values and unmapped columns keep what is there — the sheet row carries the linked product's canonical flower type and
category from the `product link` step), the Drive link lands as a smart chip and an empty tab gets the default header
first. A leg the Rust side skips (no file URL, no folder / sheet id) shows as a grey `–` chip; a Google failure shows a
red chip but never fails the import. The Done panel says `Imported N · M failed · mirrored K` and links the Drive
file. The detail pane's **Mirror to Google** (shown once Google is set up) runs the same two legs for a library COA
as it stands and toasts `Drive: updated (deduped) · Sheet: row 335 updated` (or each leg's skip reason / error).

**Export CSV** writes `coas-<all|filtered>-<date>.csv` to `~/Downloads` and reveals it in Finder. Edits and manual
links made outside the wizard are saved locally (the app's override file) and shown with a ✎ flag. In the browser
preview the page runs on sample COAs (`src/lib/devMock.ts`, one real public PDF for the preview pane, a mocked parser
that fails on `scan_*`, mocked upload / import / repost that flip the sample rows); in the app it is live and needs
`read_files`, `read_metaobjects` and `read_products` on Retail to list, plus `write_files`, `write_metaobjects`,
`write_products` and `write_themes` to import.

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
│   │   ├── CoaWizard.tsx         # COA import wizard (Lab)
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
- ✅ **Customers page**: live top-100 list with Shopify-side search, sort / filter / columns, Open in Shopify
- ✅ **Analytics page**: orders per day and per-store totals for 7 / 14 / 30 days, derived from orders across all three stores
- ✅ **Catalog · Visible in**: cross-store presence chips (Retail / B2B / Bulk) and Open in Shopify links
- ✅ Settings page (Keychain management)
- ✅ Home page (connection test)
- ✅ **Lab / COAs page**: live COA list with posted / expiry cross-checks, table · calendar · labs · link views,
  local edits and manual links, CSV export, OpenRouter parsing, and the import wizard (upload → parse → link →
  coa_record + product metafield + /pages/coa block) with Bulk import and Repost
- ✅ Page stub for FGINV inventory

### Future (Phase 2+)

- [ ] Orders: Filters, search, actions (refund, fulfill, etc.)
- [ ] Catalog: product detail, create/edit; a shared SKU / metafield key for cross-store matching
- [ ] Customers: paging past the top 100, customer detail
- [ ] Analytics: shop-timezone buckets, ShopifyQL once `read_reports` is granted
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
- `list_customers(query?, first?)` — top customers of the active store (≤ 100; relevance-ranked when `query` is set,
  else most recently updated first) plus `customersCount` for the same query
- `list_product_presence(store_id)` — id / handle / title / status of every product in *any* store (250 per page,
  up to 2,000) for the Catalog "Visible in" column
- `list_orders_since(store_id, since)` — created-at / total / cancelled stubs of every non-test order since a
  `YYYY-MM-DD` date in *any* store (200 per page, up to 2,000) for Analytics
- `list_coas()` — every COA PDF in the retail Files library joined with `coa_record` metaobjects, linked products and
  a `/pages/coa` scrape: `{ coas, count, truncated, postedPage }`
- `save_coa_link(file_id, product_id?, product_title?)` — manual COA → product link (nulls clear it), kept locally
- `save_coa_fields(file_id, fields?, clear?)` — local field overrides for one COA (`clear: true` drops them);
  returns the overrides
- `search_products(q)` — retail product title search, at most 10 `{ id, title, handle, status }`
- `export_coas_csv(filename, csv)` — writes the CSV to `~/Downloads/<filename>`, returns the absolute path
- `get_openrouter_status()` — `{ hasKey, keyHint, defaultModel }` (`keyHint` is the key's last 4 chars)
- `save_openrouter_key(key)` — stores the OpenRouter key in the Keychain (empty key removes it), returns a message
- `parse_coas(files, model?, force?)` — LLM-parses `[{ fileId, fileUrl }]` through OpenRouter (4 in parallel;
  `force` re-parses already-parsed rows): `{ parsed, failed, skipped, elapsedMs, errors, results }`; rejects without a key
- `upload_coa_pdf(filename, data_base64)` — staged upload into the retail Files library; waits for the CDN URL (up to
  ~20 s): `{ ok, fileId, url, fileStatus, filename }` (`url` null if the file is still processing)
- `import_coa(req)` — one COA: `{ fileId, fileUrl, fileName, fields: { batchId, issueDate, expiryDate, lab, producer,
  thcaPercent, cbdPercent, cbgPercent, totalCannabinoidsPercent, terpenes: [{ name, percent }], notes, qrPresent },
  productId, productTitle, pageName, post }` → writes the `coa_record` metaobject (`ACTIVE` when `post`, else
  `DRAFT`), the product's `custom.coa_records`, the `/pages/coa` template block (theme backup first; only when `post`)
  and the fields cache: `{ ok, steps: [{ step, ok, critical, error, detail }], metaobject, unknownTerpenes, posted }`
  (the `productLink` step's `detail` carries the linked product's canonical `flowerType` and `category`)
- `repost_coas(targets)` — re-writes the `/pages/coa` block for `[{ fileId, fileUrl, name }]`:
  `{ posted, failed, results: [{ fileId, ok, name, action: "updated" | "added", error }] }`
- `seed_google_config_from_old_env()` — the old dashboard's `.env` as `{ keyFile, sheetId, sheetTab, folderId }`, or
  null when there is nothing to import
- `google_status(cfg)` — probes the Sheet + folder as the service account: `{ configured, serviceAccountEmail,
  sheetReachable, sheetTitle, tabs, driveReachable, driveFolderName, error }` (probe failures land in `error`)
- `google_mirror_coa(cfg, req)` — `req = { fileUrl, pdfName, row }` (`row` = batch, productName, flowerType, category,
  lab, issued, expires, thca, cbd, cbg, totalCannabinoids, shopifyUrl, posted, importedAt, notes — all strings or
  null): Drive upload with same-name dedupe + header-driven Sheet upsert by batch →
  `{ drive: { ok, skipped, webViewLink, fileId, deduped, error }, sheet: { ok, skipped, action, rowNumber, tab,
  matchedFields, chip, error } }`

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

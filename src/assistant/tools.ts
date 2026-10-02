// Client tools for the ElevenLabs agent (names/parameters must match tool_defs() in src-tauri/src/voice.rs).
// Lookups return short plain text for the agent to speak. The two propose_* tools never write anything: they resolve
// the exact target and put a review card in the assistant panel; only the user's Apply click executes it.
import { invoke } from "@tauri-apps/api/core";
import {
  ADJUST_REASONS, HIDDEN_INVENTORY, STORES, type InventoryResult, type InventoryVariant, type OrderDetail, type OrdersPage, type SalesReport, type StoreId,
  type CatalogProduct, type Customer, type CustomersResult, type CatalogResult, type FulfillmentInfo, adminUrl, fulStatus, getOrder, getProductDetail, money, payStatus, storeById,
} from "../lib/shopify";

export type Proposal = { id: string; storeId: StoreId; createdAt: number; status: "pending" | "applying" | "applied" | "failed" | "dismissed"; result?: string; error?: string } & (
  | { kind: "inventory"; label: string; sku: string | null; location: string; locationId: string; inventoryItemId: string; delta: number; reason: string; available: number; onHand: number }
  | { kind: "order"; orderId: string; orderName: string; currentNote: string | null; newNote: string | null; currentTags: string[]; addTags: string[]; removeTags: string[] }
);
export type NewProposal = Proposal extends infer P ? (P extends Proposal ? Omit<P, "id" | "createdAt" | "status"> : never) : never;

export interface ToolContext {
  store: StoreId; go: (path: string) => void; propose: (p: NewProposal) => Proposal;
  setStore: (s: StoreId) => Promise<void>;
  /** Opens an external URL (Shopify admin, storefront, tracking, mailto) in the default browser / app. */
  open: (url: string) => void;
  /** App chrome: back/forward, panels, sidebar, palette, refresh; returns what happened. */
  ui: (action: string) => string;
}
type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const storeOf = (ctx: ToolContext, v: unknown): StoreId => (STORES.some((s) => s.id === v) ? (v as StoreId) : ctx.store);
const label = (v: InventoryVariant) => `${v.productTitle}${v.variantTitle ? ` · ${v.variantTitle}` : ""}`;
const fail = (e: unknown) => `Error: ${String(e).replace(/^Error:\s*/, "").slice(0, 240)}`;

// ---- inventory ----
// Loading a store's inventory is up to 15 Shopify pages, so keep it for a minute; the panel clears it after an Apply
// and preloads the open store when a session starts.
const INV_TTL = 60_000;
const invCache = new Map<StoreId, { at: number; p: Promise<InventoryVariant[]> }>();
function inventory(store: StoreId): Promise<InventoryVariant[]> {
  const hit = invCache.get(store);
  if (hit && Date.now() - hit.at < INV_TTL) return hit.p;
  const p = invoke<InventoryResult>("list_inventory", { storeId: store }).then((r) => r.variants.filter((v) => !HIDDEN_INVENTORY.test(v.productTitle)));
  invCache.set(store, { at: Date.now(), p });
  p.catch(() => invCache.delete(store)); // don't cache failures
  return p;
}
export const preloadInventory = (store: StoreId) => { void inventory(store).catch(() => {}); };
export const clearToolCache = () => { invCache.clear(); catCache.clear(); };
/** Every word of the query must appear in "product variant sku" (so "lifter 7g" and "FG-LFT-7G" both work). */
function matchVariants(all: InventoryVariant[], query: string): InventoryVariant[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const exactSku = all.filter((v) => v.sku && v.sku.toLowerCase() === query.toLowerCase());
  if (exactSku.length) return exactSku;
  return all.filter((v) => { const hay = `${v.productTitle} ${v.variantTitle ?? ""} ${v.sku ?? ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

async function findInventory(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), q = str(a.query);
  if (!q) return "Error: say which product, variant or SKU.";
  const hits = matchVariants(await inventory(store), q);
  if (!hits.length) return `No item in ${storeById(store).label} matches "${q}".`;
  const lines = hits.slice(0, 8).map((v) => {
    if (!v.tracked) return `${label(v)}${v.sku ? ` (${v.sku})` : ""}: inventory not tracked.`;
    const at = v.levels.length ? v.levels.map((l) => `${l.available} available, ${l.onHand} on hand, ${l.committed} committed at ${l.location}`).join("; ") : `${v.available} available`;
    return `${label(v)}${v.sku ? ` (${v.sku})` : ""}: ${at}.`;
  });
  return `${storeById(store).label}:\n${lines.join("\n")}${hits.length > 8 ? `\n…and ${hits.length - 8} more; ask the user to narrow it down.` : ""}`;
}

// ---- orders ----
const norm = (name: string) => name.toLowerCase().replace(/[#\s-]/g, "");
async function searchOrders(store: StoreId, query: string, first = 8) {
  return invoke<OrdersPage>("list_orders_page", { first, sortKey: "CREATED_AT", reverse: true, query, storeId: store });
}
/** The one order whose name matches (ignoring "#", "-" and spaces), or an explanation. */
async function resolveOrder(store: StoreId, raw: string): Promise<{ id: string } | { error: string }> {
  const n = norm(raw);
  if (!n) return { error: "Error: say which order (its number)." };
  const page = await searchOrders(store, `name:${raw.replace(/[^A-Za-z0-9#-]/g, "")}`, 5);
  const exact = page.orders.find((o) => norm(o.name) === n) ?? (page.orders.length === 1 ? page.orders[0] : undefined);
  if (exact) return { id: exact.id };
  // Spoken numbers lose punctuation ("R10482" for "#R-10482"): search the digits, then compare without punctuation.
  const digits = raw.replace(/\D/g, "");
  const loose = digits ? (await searchOrders(store, digits, 10)).orders.filter((o) => norm(o.name) === n || o.name.replace(/\D/g, "") === digits) : [];
  if (loose.length === 1) return { id: loose[0].id };
  return { error: `No single order "${raw}" in ${storeById(store).label}${loose.length > 1 ? ` (matches: ${loose.map((o) => o.name).join(", ")})` : ""}. Ask the user to repeat the number or the store.` };
}

async function findOrders(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), q = str(a.query);
  const page = await searchOrders(store, q);
  if (!page.orders.length) return `No orders in ${storeById(store).label} match "${q}".`;
  const total = page.totalCount != null ? ` (${page.totalCount}${page.totalPrecision === "AT_LEAST" ? "+" : ""} in all)` : "";
  return `${storeById(store).label} orders${total}, newest first:\n` + page.orders.map((o) =>
    `${o.name} · ${new Date(o.createdAt).toLocaleDateString()} · ${o.customerName ?? "no customer"} · ${money(o.totalPrice)} · ${payStatus(o.displayFinancialStatus).label} · ${fulStatus(o.displayFulfillmentStatus).label}${o.cancelled ? " · cancelled" : ""}`).join("\n");
}

function describeOrder(o: OrderDetail, store: StoreId): string {
  return [
    `${o.name} (${storeById(store).label}), placed ${new Date(o.createdAt).toLocaleString()}, ${o.cancelled ? "cancelled" : o.closed ? "closed" : "open"}.`,
    `Customer: ${o.customerName ?? "none"}${o.customerEmail ? ` <${o.customerEmail}>` : ""}${o.customerOrdersCount != null ? `, ${o.customerOrdersCount} orders` : ""}.`,
    `Payment: ${payStatus(o.displayFinancialStatus).label}. Fulfillment: ${fulStatus(o.displayFulfillmentStatus).label}.`,
    `Items: ${o.lineItems.map((li) => `${li.quantity} × ${li.title}${li.sku ? ` (${li.sku})` : ""}`).join("; ")}.`,
    `Total ${money(o.totalPrice)} (subtotal ${money(o.subtotalPrice)}, shipping ${o.totalShipping ? money(o.totalShipping) : "none"}).`,
    `Note: ${o.note ?? "none"}. Tags: ${o.tags.length ? o.tags.join(", ") : "none"}.`,
    o.shippingAddress ? `Ships to: ${o.shippingAddress.replace(/\n/g, ", ")}.` : "",
  ].filter(Boolean).join("\n");
}

async function getOrderTool(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store);
  const r = await resolveOrder(store, str(a.order));
  if ("error" in r) return r.error;
  return describeOrder(await getOrder(r.id, store), store);
}

// ---- sales ----
async function salesSummary(ctx: ToolContext, a: Args): Promise<string> {
  const days = Math.min(90, Math.max(1, Math.round(Number(a.days) || 7)));
  const stores = a.store === "all" ? STORES.map((s) => s.id) : [storeOf(ctx, a.store)];
  // All stores at once (one ShopifyQL request each).
  const out = await Promise.all(stores.map(async (id) => {
    try {
      const r = await invoke<SalesReport>("sales_report", { storeId: id, days });
      const t = r.totals, m = (n: number) => money(`${n.toFixed(2)} ${r.currency}`);
      return `${storeById(id).label}, last ${days} day${days === 1 ? "" : "s"}: ${t.orders} orders, gross ${m(t.grossSales)}, discounts ${m(t.discounts)}, returns ${m(t.returns)}, net ${m(t.netSales)}, total ${m(t.totalSales)}, average order ${m(t.averageOrderValue)}.`
        + (r.topProducts.length ? ` Top: ${r.topProducts.slice(0, 3).map((p) => `${p.title} ${m(p.netSales)}`).join("; ")}.` : "");
    } catch (e) { return `${storeById(id).label}: ${fail(e)}`; }
  }));
  return out.join("\n");
}

// ---- navigation ----
const SCREENS = ["home", "orders", "inventory", "catalog", "lab", "customers", "analytics", "settings"];
const SEARCHABLE = ["orders", "inventory", "catalog", "lab", "customers"];
/** view → extra URL params per screen (each page reads these on load). */
const VIEWS: Record<string, Record<string, Record<string, string>>> = {
  orders: { all: { filter: "all" }, unfulfilled: { filter: "unfulfilled" } },
  inventory: { shopify: {}, fginv: { tab: "fginv" }, low_stock: { low: "1" }, receive: { action: "receive" }, transfer: { action: "transfer" } },
  catalog: { table: {}, grid: { view: "grid" }, drafts: { status: "draft" } },
  lab: { table: {}, calendar: { view: "calendar" }, labs: { view: "labs" }, link: { view: "link" }, unposted: { posted: "unposted" } },
  analytics: { "7": { days: "7" }, "14": { days: "14" }, "30": { days: "30" }, "90": { days: "90" } },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Switch the app's store when the target lives elsewhere (then let the pages settle before navigating). */
async function goStore(ctx: ToolContext, store: StoreId) {
  if (store === ctx.store) return "";
  await ctx.setStore(store);
  await sleep(80);
  return `Switched to ${storeById(store).label}. `;
}
const qs = (o: Record<string, string>) => { const p = new URLSearchParams(o).toString(); return p ? `?${p}` : ""; };

function openScreen(ctx: ToolContext, a: Args): string {
  const screen = str(a.screen), q = str(a.search), view = str(a.view);
  if (!SCREENS.includes(screen)) return `Error: unknown screen "${screen}".`;
  const views = VIEWS[screen] ?? {};
  if (view && !views[view]) return `Error: ${screen} has no "${view}" view${Object.keys(views).length ? ` (options: ${Object.keys(views).join(", ")})` : ""}.`;
  const params: Record<string, string> = { ...(views[view] ?? {}) };
  if (q && SEARCHABLE.includes(screen)) params.q = q;
  ctx.go(`/${screen}${qs(params)}`);
  return `Opened ${screen}${view ? ` (${view.replace("_", " ")})` : ""}${q && SEARCHABLE.includes(screen) ? `, searching "${q}"` : q ? ` (that screen has no search)` : ""}.`;
}

async function switchStore(ctx: ToolContext, a: Args): Promise<string> {
  const target = STORES.find((s) => s.id === a.store);
  if (!target) return "Error: store must be retail, b2b or bulk.";
  if (target.id === ctx.store) return `Already on ${target.label}.`;
  await ctx.setStore(target.id);
  return `Switched to ${target.label}.`;
}

async function openOrder(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), action = str(a.action) || "details";
  const r = await resolveOrder(store, str(a.order));
  if ("error" in r) return r.error;
  if (action === "shopify") { ctx.open(adminUrl(store, r.id)); return "Opened the order in Shopify admin."; }
  if (action === "tracking") {
    const info = await invoke<FulfillmentInfo>("get_fulfillment", { storeId: store, orderId: r.id });
    const t = [...info.shipments].reverse().flatMap((s) => s.tracking).find((x) => x.url);
    if (!t?.url) return info.shipments.length ? "The shipments on this order have no tracking link." : "This order hasn't shipped yet, so there's no tracking.";
    ctx.open(t.url);
    return `Opened ${t.company ?? "the carrier"} tracking${t.number ? ` for ${t.number}` : ""}.`;
  }
  const open = { refund: "refund", fulfill: "fulfill", notes: "notes" }[action];
  if (action !== "details" && !open) return "Error: action must be details, refund, fulfill, notes, shopify or tracking.";
  const sw = await goStore(ctx, store);
  ctx.go(`/orders${qs({ sel: r.id, ...(open ? { open } : {}) })}`);
  return `${sw}Opened the order${open ? ` with the ${open === "notes" ? "notes editor" : `${open} form`} open — the user confirms it there` : ""}.`;
}

async function resolveCustomer(store: StoreId, raw: string): Promise<Customer | string> {
  if (!raw) return "Error: say which customer.";
  const r = await invoke<CustomersResult>("list_customers", { query: raw, first: 10, storeId: store });
  const l = raw.toLowerCase();
  const exact = r.customers.filter((c) => c.displayName.toLowerCase() === l || c.email?.toLowerCase() === l || c.company?.toLowerCase() === l);
  const pick = exact.length === 1 ? exact[0] : r.customers.length === 1 ? r.customers[0] : null;
  if (pick) return pick;
  if (!r.customers.length) return `No customer in ${storeById(store).label} matches "${raw}".`;
  return `Several customers match "${raw}": ${r.customers.slice(0, 6).map((c) => `${c.displayName}${c.email ? ` (${c.email})` : ""}`).join("; ")}. Ask which one.`;
}

async function openCustomer(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), action = str(a.action) || "details";
  const c = await resolveCustomer(store, str(a.customer));
  if (typeof c === "string") return c;
  if (action === "shopify") { ctx.open(adminUrl(store, c.id)); return `Opened ${c.displayName} in Shopify admin.`; }
  if (action === "email") {
    if (!c.email) return `${c.displayName} has no email address.`;
    ctx.open(`mailto:${c.email}`);
    return `Started an email to ${c.displayName}.`;
  }
  if (action !== "details") return "Error: action must be details, shopify or email.";
  const sw = await goStore(ctx, store);
  ctx.go(`/customers${qs({ sel: c.id })}`);
  return `${sw}Opened ${c.displayName}.`;
}

// Catalog lists are a few Shopify pages; keep each store's for a minute like inventory.
const catCache = new Map<StoreId, { at: number; p: Promise<CatalogProduct[]> }>();
function catalog(store: StoreId): Promise<CatalogProduct[]> {
  const hit = catCache.get(store);
  if (hit && Date.now() - hit.at < INV_TTL) return hit.p;
  const p = invoke<CatalogResult>("list_products", { storeId: store }).then((r) => r.products);
  catCache.set(store, { at: Date.now(), p });
  p.catch(() => catCache.delete(store));
  return p;
}
async function resolveProduct(store: StoreId, raw: string): Promise<CatalogProduct | string> {
  if (!raw) return "Error: say which product.";
  const all = await catalog(store), l = raw.toLowerCase(), words = l.split(/\s+/).filter(Boolean);
  const exact = all.filter((p) => p.title.toLowerCase() === l);
  const hits = exact.length ? exact : all.filter((p) => words.every((w) => `${p.title} ${p.productType ?? ""} ${p.vendor ?? ""}`.toLowerCase().includes(w)));
  if (hits.length === 1) return hits[0];
  if (!hits.length) return `No product in ${storeById(store).label} matches "${raw}".`;
  return `Several products match "${raw}": ${hits.slice(0, 6).map((p) => p.title).join("; ")}${hits.length > 6 ? "; …" : ""}. Ask which one.`;
}

async function openProduct(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), action = str(a.action) || "details";
  const p = await resolveProduct(store, str(a.product));
  if (typeof p === "string") return p;
  if (action === "shopify") { ctx.open(adminUrl(store, p.id)); return `Opened ${p.title} in Shopify admin.`; }
  if (action === "online_store") {
    const d = await getProductDetail(store, p.id);
    if (!d.product.onlineStoreUrl) return `${p.title} isn't published on the online store.`;
    ctx.open(d.product.onlineStoreUrl);
    return `Opened ${p.title} on the website.`;
  }
  if (action === "split_variants" && p.variantCount < 2) return `${p.title} has only one variant, so there's nothing to split.`;
  if (action !== "details" && action !== "split_variants") return "Error: action must be details, shopify, online_store or split_variants.";
  const sw = await goStore(ctx, store);
  ctx.go(`/catalog${qs({ sel: p.id, ...(action === "split_variants" ? { split: "1" } : {}) })}`);
  return `${sw}Opened ${p.title}${action === "split_variants" ? " with Split variants open — the user reviews and creates the drafts" : ""}.`;
}

async function openInventoryItem(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), action = str(a.action) || "show", item = str(a.item);
  if (!item) return "Error: say which item.";
  const hits = matchVariants(await inventory(store), item);
  if (action === "adjust") {
    const tracked = hits.filter((v) => v.tracked && v.inventoryItemId);
    if (tracked.length !== 1) return tracked.length ? `Ambiguous: ${tracked.slice(0, 6).map((v) => `${label(v)}${v.sku ? ` (${v.sku})` : ""}`).join("; ")}. Ask which one.` : `No tracked item in ${storeById(store).label} matches "${item}".`;
    const sw = await goStore(ctx, store);
    ctx.go(`/inventory${qs({ adjust: tracked[0].id })}`);
    return `${sw}Opened Adjust stock for ${label(tracked[0])} — the user enters the change and applies it.`;
  }
  if (!hits.length) return `No item in ${storeById(store).label} matches "${item}".`;
  const sw = await goStore(ctx, store);
  ctx.go(`/inventory${qs({ q: hits.length === 1 && hits[0].sku ? hits[0].sku : item })}`);
  return `${sw}Showing ${hits.length === 1 ? label(hits[0]) : `${hits.length} matching items`} in Inventory.`;
}

function openCoa(ctx: ToolContext, a: Args): string {
  const q = str(a.query);
  if (!q) return "Error: say which COA (batch, product or lab).";
  ctx.go(`/lab${qs({ q, pick: "1" })}`);
  return `Searching COAs for "${q}"; a single match opens automatically.`;
}

function uiAction(ctx: ToolContext, a: Args): string {
  return ctx.ui(str(a.action));
}

// ---- proposals (review cards; nothing is written here) ----
async function proposeInventory(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store), item = str(a.item), delta = Math.round(Number(a.change));
  const reason = ADJUST_REASONS.some(([v]) => v === a.reason) ? String(a.reason) : null;
  if (!item) return "Error: say which item.";
  if (!delta || Math.abs(delta) > 100_000) return "Error: the change must be a non-zero whole number of units.";
  if (!reason) return `Error: reason must be one of ${ADJUST_REASONS.map(([v]) => v).join(", ")}.`;
  const hits = matchVariants(await inventory(store), item).filter((v) => v.tracked && v.inventoryItemId);
  if (!hits.length) return `No tracked item in ${storeById(store).label} matches "${item}".`;
  if (hits.length > 1) return `Ambiguous: ${hits.slice(0, 6).map((v) => `${label(v)}${v.sku ? ` (${v.sku})` : ""}`).join("; ")}${hits.length > 6 ? "; …" : ""}. Ask which one.`;
  const v = hits[0];
  const levels = v.levels.filter((l) => l.locationId);
  const loc = str(a.location).toLowerCase();
  const at = loc ? levels.filter((l) => l.location.toLowerCase().includes(loc)) : levels;
  if (!at.length) return `${label(v)} isn't stocked at ${loc ? `"${a.location}"` : "any location"} in ${storeById(store).label}${levels.length ? ` (stocked at: ${levels.map((l) => l.location).join(", ")})` : ""}.`;
  if (at.length > 1) return `${label(v)} is stocked at ${at.map((l) => l.location).join(" and ")}. Ask which location.`;
  const l = at[0];
  const p = ctx.propose({ kind: "inventory", storeId: store, label: label(v), sku: v.sku, location: l.location, locationId: l.locationId, inventoryItemId: v.inventoryItemId!, delta, reason, available: l.available, onHand: l.onHand });
  return `Review card ${p.id.slice(0, 4)} shown (not applied): ${delta > 0 ? "add" : "remove"} ${Math.abs(delta)} × ${label(v)} at ${l.location}, ${storeById(store).label}; available ${l.available} → ${l.available + delta}; reason ${reason}. Ask the user to check it and click Apply.`;
}

const tagList = (v: unknown) => str(v).split(",").map((t) => t.trim()).filter(Boolean);
async function proposeOrder(ctx: ToolContext, a: Args): Promise<string> {
  const store = storeOf(ctx, a.store);
  const append = str(a.append_note), add = tagList(a.add_tags), remove = tagList(a.remove_tags);
  if (!append && !add.length && !remove.length) return "Error: say what to add to the note or which tags to add or remove.";
  const r = await resolveOrder(store, str(a.order));
  if ("error" in r) return r.error;
  const o = await getOrder(r.id, store);
  const has = (t: string) => o.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const addTags = add.filter((t) => !has(t)), removeTags = remove.filter(has);
  const skipped = [...add.filter(has).map((t) => `"${t}" is already tagged`), ...remove.filter((t) => !has(t)).map((t) => `"${t}" isn't on the order`)];
  const newNote = append ? (o.note ? `${o.note.trimEnd()}\n${append}` : append) : null;
  if (!newNote && !addTags.length && !removeTags.length) return `Nothing to change on ${o.name}: ${skipped.join("; ")}.`;
  const p = ctx.propose({ kind: "order", storeId: store, orderId: o.id, orderName: o.name, currentNote: o.note ?? null, newNote, currentTags: o.tags, addTags, removeTags });
  return `Review card ${p.id.slice(0, 4)} shown for ${o.name} (not applied)${newNote ? `: note gets "${append}" added on a new line` : ""}${addTags.length ? `; add tags ${addTags.join(", ")}` : ""}${removeTags.length ? `; remove tags ${removeTags.join(", ")}` : ""}.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""} Ask the user to check it and click Apply.`;
}

/** The client tools passed to startSession; every handler returns a string and never throws. */
export function makeTools(ctx: () => ToolContext): Record<string, (a: Args) => Promise<string>> {
  const wrap = (fn: (c: ToolContext, a: Args) => Promise<string> | string) => async (a: Args) => {
    try { return await fn(ctx(), a ?? {}); } catch (e) { return fail(e); }
  };
  return {
    find_inventory: wrap(findInventory),
    find_orders: wrap(findOrders),
    get_order: wrap(getOrderTool),
    sales_summary: wrap(salesSummary),
    open_screen: wrap(openScreen),
    switch_store: wrap(switchStore),
    open_order: wrap(openOrder),
    open_customer: wrap(openCustomer),
    open_product: wrap(openProduct),
    open_inventory_item: wrap(openInventoryItem),
    open_coa: wrap(openCoa),
    ui_action: wrap(uiAction),
    propose_inventory_adjustment: wrap(proposeInventory),
    propose_order_update: wrap(proposeOrder),
  };
}

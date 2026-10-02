// Client tools for the ElevenLabs agent (names/parameters must match tool_defs() in src-tauri/src/voice.rs).
// Lookups return short plain text for the agent to speak. The two propose_* tools never write anything: they resolve
// the exact target and put a review card in the assistant panel; only the user's Apply click executes it.
import { invoke } from "@tauri-apps/api/core";
import {
  ADJUST_REASONS, HIDDEN_INVENTORY, STORES, type InventoryResult, type InventoryVariant, type OrderDetail, type OrdersPage, type SalesReport, type StoreId,
  fulStatus, getOrder, money, payStatus, storeById,
} from "../lib/shopify";

export type Proposal = { id: string; storeId: StoreId; createdAt: number; status: "pending" | "applying" | "applied" | "failed" | "dismissed"; result?: string; error?: string } & (
  | { kind: "inventory"; label: string; sku: string | null; location: string; locationId: string; inventoryItemId: string; delta: number; reason: string; available: number; onHand: number }
  | { kind: "order"; orderId: string; orderName: string; currentNote: string | null; newNote: string | null; currentTags: string[]; addTags: string[]; removeTags: string[] }
);
export type NewProposal = Proposal extends infer P ? (P extends Proposal ? Omit<P, "id" | "createdAt" | "status"> : never) : never;

export interface ToolContext { store: StoreId; go: (path: string) => void; propose: (p: NewProposal) => Proposal }
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
export const clearToolCache = () => invCache.clear();
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
function openScreen(ctx: ToolContext, a: Args): string {
  const screen = str(a.screen), q = str(a.search);
  if (!SCREENS.includes(screen)) return `Error: unknown screen "${screen}".`;
  ctx.go(`/${screen}${q && screen === "catalog" ? `?q=${encodeURIComponent(q)}` : ""}`);
  return `Opened ${screen}${q && screen === "catalog" ? `, searching "${q}"` : ""}.`;
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
    propose_inventory_adjustment: wrap(proposeInventory),
    propose_order_update: wrap(proposeOrder),
  };
}

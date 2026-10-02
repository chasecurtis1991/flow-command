// Shopify data layer: Tauri invoke wrappers, a tiny orders cache, and display formatting.
// All live data comes from the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { prefs } from "./app";

export type StoreId = "retail" | "b2b" | "bulk";
export type Kind = "green" | "amber" | "red" | "neutral";

export interface StoreDef {
  id: StoreId;
  label: string;
  short: string;
  dot: string;
  domain: string;
  plan: string;
}

// Real Plus store myshopify domains — mirrors known_stores() in lib.rs.
export const STORES: StoreDef[] = [
  { id: "retail", label: "Retail", short: "Retail", dot: "#4c8dff", domain: "3wvfyr-1i.myshopify.com", plan: "Shopify Plus · DTC" },
  { id: "b2b", label: "B2B / Wholesale", short: "B2B", dot: "#b58cf5", domain: "b8h8vg-ij.myshopify.com", plan: "Shopify Plus · B2B, net terms" },
  { id: "bulk", label: "Bulk / Craft Flower", short: "Bulk", dot: "#3fb97a", domain: "fg-craft-flower.myshopify.com", plan: "Shopify Plus · bulk lb pricing" },
];
export const storeById = (id: StoreId) => STORES.find((s) => s.id === id) ?? STORES[0];

export interface Order {
  id: string; // gid://shopify/Order/123
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPrice: string; // "128.00 USD"
  customerName: string | null;
  customerEmail: string | null;
  closed?: boolean;
  cancelled?: boolean;
}
export interface LineItem { title: string; sku: string | null; quantity: number; price: string }
export interface OrderDetail extends Order {
  subtotalPrice: string;
  totalTax: string;
  totalShipping?: string | null;
  lineItems: LineItem[];
  note?: string | null;
  tags: string[];
  shippingAddress?: string | null;
  customerOrdersCount?: number | null;
  channel?: string | null;
}
export interface ShopInfo { shopName: string | null; status: string; shopDomain: string }
export interface Credentials { clientId: string; clientSecret: string }

// ---- invoke wrappers ----
export const getActiveStore = () => invoke<StoreDef>("get_active_store");
export const setActiveStore = (storeId: StoreId) => invoke<StoreDef>("set_active_store", { storeId });
export const getOrder = (orderId: string) => invoke<OrderDetail>("get_order", { orderId });
// ---- fulfillment (mirrors order_fulfill.rs) ----
export interface FoLine { id: string; title: string; sku: string | null; remaining: number; total: number }
export interface FulfillmentOrder { id: string; status: string; location: string | null; canFulfill: boolean; lines: FoLine[] }
export interface Tracking { company: string | null; number: string | null; url: string | null }
export interface Shipment { id: string; status: string; createdAt: string; tracking: Tracking[]; items: string[] }
export interface FulfillmentInfo { fulfillmentOrders: FulfillmentOrder[]; shipments: Shipment[] }
export interface FulfillRequest {
  storeId: StoreId; orderId: string; fulfillmentOrderId: string; lines: { id: string; quantity: number }[];
  trackingCompany?: string; trackingNumber?: string; trackingUrl?: string; notifyCustomer: boolean;
}
export const getFulfillment = (storeId: StoreId, orderId: string) => invoke<FulfillmentInfo>("get_fulfillment", { storeId, orderId });
/** Re-checks remaining quantities in Shopify first, so nothing ShipStation already shipped is fulfilled twice. */
export const fulfillOrder = (request: FulfillRequest) => invoke<FulfillmentInfo>("fulfill_order", { request });
/** Fulfillment orders with something left to ship that Shopify lets us fulfill. */
export const fulfillable = (info: FulfillmentInfo | null) => (info?.fulfillmentOrders ?? []).filter((f) => f.canFulfill && f.lines.some((l) => l.remaining > 0));

/** Mirrors order_notes.rs: note = null leaves it alone; tags are added/removed individually (others are kept). */
export interface NoteTagsRequest { storeId: StoreId; orderId: string; note: string | null; expectedNote: string | null; addTags: string[]; removeTags: string[] }
export const updateOrderNoteTags = (request: NoteTagsRequest) => invoke<{ note: string | null; tags: string[] }>("update_order_note_tags", { request });
export const fetchShopInfo = (storeId?: StoreId) => invoke<ShopInfo>("fetch_shop_info", { storeId });
export const getCredentials = () => invoke<Credentials>("get_shopify_credentials");
export const saveCredentials = (clientId: string, clientSecret: string) =>
  invoke<string>("save_shopify_credentials", { clientId, clientSecret });

// ---- orders cache (module-level; one list per active store) ----
export type OrdersStatus = "idle" | "loading" | "data" | "error";
export interface OrdersState { store: StoreId | null; status: OrdersStatus; orders: Order[]; error: string | null; loadedAt: number }
let ordersState: OrdersState = { store: null, status: "idle", orders: [], error: null, loadedAt: 0 };
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());

/** Load orders for `store`. Must be called after set_active_store resolved (list_orders reads the Keychain-active store).
 *  Resolves with the resulting cache state (never rejects). */
export function loadOrders(store: StoreId, force = false): Promise<OrdersState> {
  if (!force && ordersState.store === store && ordersState.status !== "idle" && ordersState.status !== "error") return Promise.resolve(ordersState);
  ordersState = { ...ordersState, store, status: "loading", error: null };
  emit();
  return invoke<Order[]>("list_orders", { first: 50 })
    .then((orders) => {
      if (ordersState.store !== store) return ordersState; // store switched mid-flight
      ordersState = { store, status: "data", orders, error: null, loadedAt: Date.now() };
      emit();
      return ordersState;
    })
    .catch((e) => {
      if (ordersState.store !== store) return ordersState;
      ordersState = { ...ordersState, status: "error", error: String(e) };
      emit();
      return ordersState;
    });
}
export const useOrders = () =>
  useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => ordersState);

// ---- paged orders (the Orders table; mirrors list_orders_page in lib.rs) ----
// Shopify sort keys the table exposes (must stay in step with ORDER_SORT_KEYS in lib.rs).
export type OrderSortKey = "CREATED_AT" | "UPDATED_AT" | "PROCESSED_AT" | "ORDER_NUMBER" | "CUSTOMER_NAME" | "TOTAL_PRICE" | "FINANCIAL_STATUS" | "FULFILLMENT_STATUS";
/** 200 keeps a page at ~803 query-cost points (< Shopify's 1,000 single-query cap); 250 would exceed it. */
export const ORDER_PAGE_SIZES = [25, 50, 100, 200] as const;
export const ORDER_DEFAULT_PAGE_SIZE = 50;
export interface OrdersRequest { pageSize: number; sortKey: OrderSortKey; reverse: boolean; query: string }
export const sameRequest = (a: OrdersRequest, b: OrdersRequest) =>
  a.pageSize === b.pageSize && a.sortKey === b.sortKey && a.reverse === b.reverse && a.query === b.query;

export type CountPrecision = "EXACT" | "AT_LEAST";
export interface OrdersPage {
  orders: Order[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
  totalCount: number | null;
  totalPrecision: CountPrecision | null;
}
export interface OrdersTableState {
  store: StoreId | null;
  status: OrdersStatus;
  error: string | null;
  loadedAt: number;
  request: OrdersRequest | null;
  /** 1-based page currently shown (or loading). */
  page: number;
  /** cursors[i] is the `after` cursor that fetches page i+1; cursors[0] is null (first page). */
  cursors: (string | null)[];
  orders: Order[];
  hasNextPage: boolean;
  /** Shopify's ordersCount for the same query; AT_LEAST once it hits the 10,000 cap. Null if not returned. */
  total: { count: number; precision: CountPrecision } | null;
}
const EMPTY_TABLE: OrdersTableState = { store: null, status: "idle", error: null, loadedAt: 0, request: null, page: 1, cursors: [null], orders: [], hasNextPage: false, total: null };
let tblState: OrdersTableState = EMPTY_TABLE;
let tblSeq = 0;
const tblSubs = new Set<() => void>();
const tblEmit = () => tblSubs.forEach((fn) => fn());

/** Fetch one page for `store` + `request`. A different store/request always starts at page 1; otherwise `page` must
 *  already have a known cursor (prev/next navigation). Never rejects; resolves with the resulting state. */
export function loadOrdersPage(store: StoreId, request: OrdersRequest, page = 1): Promise<OrdersTableState> {
  const fresh = !(tblState.store === store && tblState.request && sameRequest(tblState.request, request));
  const cursors = fresh ? [null] : tblState.cursors;
  const target = fresh ? 1 : Math.max(1, Math.min(page, cursors.length));
  const after = cursors[target - 1] ?? null;
  const seq = ++tblSeq;
  tblState = {
    ...tblState, store, request, status: "loading", error: null, page: target, cursors,
    orders: fresh ? [] : tblState.orders, hasNextPage: fresh ? false : tblState.hasNextPage, total: fresh ? null : tblState.total,
  };
  tblEmit();
  return invoke<OrdersPage>("list_orders_page", { first: request.pageSize, after, sortKey: request.sortKey, reverse: request.reverse, query: request.query || null })
    .then((p) => {
      if (seq !== tblSeq) return tblState; // superseded by a newer request
      const next = tblState.cursors.slice(0, target);
      if (p.hasNextPage && p.endCursor) next[target] = p.endCursor;
      tblState = {
        ...tblState, status: "data", orders: p.orders, hasNextPage: p.hasNextPage && !!p.endCursor, cursors: next, loadedAt: Date.now(),
        total: p.totalCount != null ? { count: p.totalCount, precision: p.totalPrecision === "AT_LEAST" ? "AT_LEAST" : "EXACT" } : null,
      };
      tblEmit();
      return tblState;
    })
    .catch((e) => {
      if (seq !== tblSeq) return tblState;
      tblState = { ...tblState, status: "error", error: String(e) };
      tblEmit();
      return tblState;
    });
}
/** Load page 1 when the store/request changed or the cache was invalidated; no-op while loading, loaded, or errored (Retry is explicit). */
export function ensureOrdersPage(store: StoreId, request: OrdersRequest): void {
  const same = tblState.store === store && tblState.request != null && sameRequest(tblState.request, request);
  if (same && tblState.status !== "idle") return;
  void loadOrdersPage(store, request, same ? tblState.page : 1);
}
export function goToOrdersPage(page: number): void {
  if (tblState.store && tblState.request) void loadOrdersPage(tblState.store, tblState.request, page);
}
export const useOrdersTable = () =>
  useSyncExternalStore((fn) => { tblSubs.add(fn); return () => { tblSubs.delete(fn); }; }, () => tblState);
/** Mark the table stale: a mounted Orders page refetches its current page, an unmounted one refetches on next visit. */
export function invalidateOrdersTable(): void {
  if (tblState.status !== "data" && tblState.status !== "error") return;
  tblState = { ...tblState, status: "idle" };
  tblEmit();
}

// Shopify search-syntax values for the display enums (only statuses Shopify can filter on are listed).
const FINANCIAL_QUERY: Record<string, string> = {
  PAID: "paid", PENDING: "pending", AUTHORIZED: "authorized", PARTIALLY_PAID: "partially_paid",
  PARTIALLY_REFUNDED: "partially_refunded", REFUNDED: "refunded", VOIDED: "voided", EXPIRED: "expired",
};
const FULFILLMENT_QUERY: Record<string, string> = {
  UNFULFILLED: "unfulfilled", PARTIALLY_FULFILLED: "partial", FULFILLED: "fulfilled", SCHEDULED: "scheduled", ON_HOLD: "on_hold", REQUEST_DECLINED: "request_declined",
};
export const FINANCIAL_FILTER_VALUES = Object.keys(FINANCIAL_QUERY);
export const FULFILLMENT_FILTER_VALUES = Object.keys(FULFILLMENT_QUERY);
/** The "Unfulfilled" quick filter: open orders that still need fulfillment work. */
export const OPEN_WORK_STATUSES: readonly string[] = ["UNFULFILLED", "PARTIALLY_FULFILLED", "ON_HOLD", "SCHEDULED"];

// Search-syntax special characters are `: \ ( )`; a term may not start with `-`, `'` or `"`.
const escapeTerm = (s: string) => s.replace(/[\\:()]/g, (c) => `\\${c}`);
const words = (s: string | undefined) =>
  (s ?? "").trim().split(/\s+/).map((w) => w.replace(/^[#'"\-]+/, "")).filter(Boolean).map(escapeTerm);
const anyOf = (field: string, values: string[]) =>
  values.length === 1 ? `${field}:${values[0]}` : `(${values.map((v) => `${field}:${v}`).join(" OR ")})`;

export interface OrdersFilter {
  /** Free text: Shopify's default multi-field search (order name, customer, email, …). */
  text?: string;
  /** Order-number column filter → `name:` terms. */
  name?: string;
  /** Customer column filter → free text (there is no customer_name field; default search covers name and email). */
  customer?: string;
  financial?: string[];
  fulfillment?: string[];
  /** Adds `status:open` (not closed/archived, not cancelled). */
  openOnly?: boolean;
}
/** Build the Shopify `query` string for the orders connection and ordersCount. */
export function buildOrdersQuery(f: OrdersFilter): string {
  const out: string[] = [];
  if (f.openOnly) out.push("status:open");
  out.push(...words(f.text));
  out.push(...words(f.name).map((w) => `name:${w}`));
  out.push(...words(f.customer));
  const fin = (f.financial ?? []).map((v) => FINANCIAL_QUERY[v]).filter(Boolean);
  if (fin.length) out.push(anyOf("financial_status", fin));
  const ful = (f.fulfillment ?? []).map((v) => FULFILLMENT_QUERY[v]).filter(Boolean);
  if (ful.length) out.push(anyOf("fulfillment_status", ful));
  return out.join(" ");
}

// ---- inventory (mirrors list_inventory in lib.rs) ----
export interface InventoryLevel { location: string; locationId: string; available: number; onHand: number; committed: number }
export interface InventoryVariant {
  id: string;
  productId: string; // gid://shopify/Product/123
  productTitle: string;
  variantTitle: string | null; // null when Shopify title is "Default Title"
  sku: string | null;
  productStatus: string; // ACTIVE | DRAFT | ARCHIVED
  tracked: boolean;
  inventoryItemId: string | null; // null when the products-only fallback ran
  available: number; // inventoryQuantity, all locations
  levels: InventoryLevel[]; // empty when the products-only fallback ran
}
export interface InventoryResult {
  variants: InventoryVariant[];
  locations: string[];
  levelsError: string | null; // set when the full query was denied and the fallback was used
  truncated: boolean; // hit the 15-page cap
}
export const lowStock = (v: InventoryVariant) => v.tracked && v.available <= 10; // ponytail: fixed threshold; make it a setting when someone asks
/** Products that exist in Shopify only as an app's accounting device (Route's "Shipping Protection by Route": 76 price-point
 *  variants at 10,000,000 units each) — hidden from Inventory, never deleted from Shopify. */
// ponytail: one title regex; turn into a settings list if a second app product shows up.
export const HIDDEN_INVENTORY = /shipping protection/i;
/** One Inventory tree row: a product and its variants, with the per-product roll-ups the table sorts and filters on. */
export interface InventoryProduct {
  id: string; title: string; status: string; variants: InventoryVariant[];
  tracked: boolean; // any variant tracked
  available: number; // sum
  onHand: number | null; committed: number | null; // sums across variants+locations; null when no variant has levels (products-only fallback)
  low: boolean; // any tracked variant at/below the lowStock threshold
  leaf: boolean; // a single variant: render as one row (its size inline), no children
}
/** Group variants by productId in first-seen order (list_inventory sorts by product title then variant title, so products come out title-sorted). */
export function groupInventory(variants: InventoryVariant[]): InventoryProduct[] {
  const by = new Map<string, InventoryProduct>();
  for (const v of variants) {
    let p = by.get(v.productId);
    if (!p) { p = { id: v.productId, title: v.productTitle, status: v.productStatus, variants: [], tracked: false, available: 0, onHand: null, committed: null, low: false, leaf: false }; by.set(p.id, p); }
    p.variants.push(v);
    p.tracked ||= v.tracked;
    p.available += v.available;
    p.low ||= lowStock(v);
    for (const l of v.levels) { p.onHand = (p.onHand ?? 0) + l.onHand; p.committed = (p.committed ?? 0) + l.committed; }
  }
  for (const p of by.values()) p.leaf = p.variants.length === 1;
  return [...by.values()];
}

// ---- inventory adjust (mirrors inventory_adjust.rs) ----
export const ADJUST_REASONS: [string, string][] = [
  ["correction", "Correction"], ["cycle_count_available", "Cycle count"], ["damaged", "Damaged"], ["shrinkage", "Shrinkage / loss"],
  ["received", "Received"], ["restock", "Restock (return)"], ["promotion", "Promotion / sample"], ["other", "Other"],
];
export interface StockChange { inventoryItemId: string; locationId: string; delta: number; changeFrom: number }
export interface AdjustRequest {
  storeId: StoreId; reason: string; changes: StockChange[]; idempotencyKey: string;
  kind?: "adjust" | "receive" | "transfer"; reference?: string; // becomes flowcommand://<kind>/<reference> in Shopify's history
}
export interface LevelAfter { inventoryItemId: string; locationId: string; available: number; onHand: number }
/** All changes go in one Shopify mutation: all apply or none do. Returns Shopify's re-read counts, one per change. */
export const adjustInventory = (request: AdjustRequest) => invoke<LevelAfter[]>("adjust_inventory", { request });
/** Location name → id, from the levels list_inventory returned (locations with nothing stocked don't appear). */
export function inventoryLocations(variants: InventoryVariant[]): { id: string; name: string }[] {
  const by = new Map<string, string>();
  for (const v of variants) for (const l of v.levels) if (l.locationId && !by.has(l.locationId)) by.set(l.locationId, l.location);
  return [...by].map(([id, name]) => ({ id, name }));
}

// ---- inventory cache (same shape and semantics as the orders cache) ----
export interface InventoryState { store: StoreId | null; status: OrdersStatus; data: InventoryResult | null; error: string | null; loadedAt: number }
let invState: InventoryState = { store: null, status: "idle", data: null, error: null, loadedAt: 0 };
const invSubs = new Set<() => void>();
const invEmit = () => invSubs.forEach((fn) => fn());

/** Load inventory for `store`. Same contract as loadOrders: call after set_active_store resolved; never rejects. */
export function loadInventory(store: StoreId, force = false): Promise<InventoryState> {
  if (!force && invState.store === store && invState.status !== "idle" && invState.status !== "error") return Promise.resolve(invState);
  invState = { ...invState, store, status: "loading", error: null };
  invEmit();
  return invoke<InventoryResult>("list_inventory")
    .then((raw) => {
      if (invState.store !== store) return invState; // store switched mid-flight
      const data = { ...raw, variants: raw.variants.filter((v) => !HIDDEN_INVENTORY.test(v.productTitle)) };
      invState = { store, status: "data", data, error: null, loadedAt: Date.now() };
      invEmit();
      return invState;
    })
    .catch((e) => {
      if (invState.store !== store) return invState;
      invState = { ...invState, status: "error", error: String(e) };
      invEmit();
      return invState;
    });
}
export const useInventory = () =>
  useSyncExternalStore((fn) => { invSubs.add(fn); return () => { invSubs.delete(fn); }; }, () => invState);
/** Mark the cache stale: a mounted Inventory page reloads now, an unmounted one reloads on next visit. */
export function invalidateInventory(): void {
  if (invState.status !== "data" && invState.status !== "error") return;
  invState = { ...invState, status: "idle" };
  invEmit();
}

// ---- catalog (mirrors list_products in lib.rs) ----
export interface ProductOption { name: string; values: string[] }
export interface CatalogProduct {
  id: string; // gid://shopify/Product/123
  title: string;
  handle: string;
  status: string; // ACTIVE | DRAFT | ARCHIVED
  productType: string | null; // null when blank in Shopify
  vendor: string | null;
  tags: string[];
  variantCount: number;
  minPrice: string; // "24.00 USD" (priceRangeV2.minVariantPrice); "" if missing
  maxPrice: string;
  totalInventory: number;
  tracksInventory: boolean;
  imageUrl: string | null; // featured media preview, ≤480px
  options: ProductOption[]; // empty for default-variant-only products
  updatedAt: string;
}
export interface CatalogResult {
  products: CatalogProduct[];
  truncated: boolean; // hit the 20-page cap (1,000 products)
}

// ---- catalog cache (same shape and semantics as the orders cache) ----
export interface CatalogState { store: StoreId | null; status: OrdersStatus; data: CatalogResult | null; error: string | null; loadedAt: number }
let catState: CatalogState = { store: null, status: "idle", data: null, error: null, loadedAt: 0 };
const catSubs = new Set<() => void>();
const catEmit = () => catSubs.forEach((fn) => fn());

/** Load the catalog for `store`. Same contract as loadOrders: call after set_active_store resolved; never rejects. */
export function loadCatalog(store: StoreId, force = false): Promise<CatalogState> {
  if (!force && catState.store === store && catState.status !== "idle" && catState.status !== "error") return Promise.resolve(catState);
  catState = { ...catState, store, status: "loading", error: null };
  catEmit();
  return invoke<CatalogResult>("list_products")
    .then((data) => {
      if (catState.store !== store) return catState; // store switched mid-flight
      catState = { store, status: "data", data, error: null, loadedAt: Date.now() };
      catEmit();
      return catState;
    })
    .catch((e) => {
      if (catState.store !== store) return catState;
      catState = { ...catState, status: "error", error: String(e) };
      catEmit();
      return catState;
    });
}
export const useCatalog = () =>
  useSyncExternalStore((fn) => { catSubs.add(fn); return () => { catSubs.delete(fn); }; }, () => catState);
/** Mark the cache stale: a mounted Catalog page reloads now, an unmounted one reloads on next visit. */
export function invalidateCatalog(): void {
  if (catState.status !== "data" && catState.status !== "error") return;
  catState = { ...catState, status: "idle" };
  catEmit();
}

// ---- customers (mirrors list_customers in lib.rs) ----
export interface Customer {
  id: string; // gid://shopify/Customer/123
  displayName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  location: string | null; // "City, ST" from the default address
  ordersCount: number;
  amountSpent: string; // "612.00 USD"; "" if missing
  lastOrderName: string | null;
  lastOrderAt: string | null;
  createdAt: string;
  tags: string[];
}
export interface CustomersResult { customers: Customer[]; hasNextPage: boolean; totalCount: number | null; totalPrecision: CountPrecision | null }
/** Free-text customer search: escaped words, no field prefixes (Shopify's default search covers name, email, phone, company). */
export const buildCustomersQuery = (text: string) => words(text).join(" ");

// ---- customers cache (same shape as the catalog cache, plus the query it was fetched with) ----
export interface CustomersState { store: StoreId | null; status: OrdersStatus; query: string; data: CustomersResult | null; error: string | null; loadedAt: number }
let custState: CustomersState = { store: null, status: "idle", query: "", data: null, error: null, loadedAt: 0 };
const custSubs = new Set<() => void>();
const custEmit = () => custSubs.forEach((fn) => fn());

/** Load the first 100 customers of `store` matching `query`. A different store or query always refetches; never rejects. */
export function loadCustomers(store: StoreId, query: string, force = false): Promise<CustomersState> {
  const same = custState.store === store && custState.query === query;
  if (!force && same && custState.status !== "idle" && custState.status !== "error") return Promise.resolve(custState);
  custState = { ...custState, store, query, status: "loading", error: null, data: same ? custState.data : null }; // a new store/query drops the old rows (page shows LoadingState)
  custEmit();
  return invoke<CustomersResult>("list_customers", { query: query || null, first: 100 })
    .then((data) => {
      if (custState.store !== store || custState.query !== query) return custState; // store or query switched mid-flight
      custState = { store, status: "data", query, data, error: null, loadedAt: Date.now() };
      custEmit();
      return custState;
    })
    .catch((e) => {
      if (custState.store !== store || custState.query !== query) return custState;
      custState = { ...custState, status: "error", error: String(e) };
      custEmit();
      return custState;
    });
}
export const useCustomers = () =>
  useSyncExternalStore((fn) => { custSubs.add(fn); return () => { custSubs.delete(fn); }; }, () => custState);
/** Mark the cache stale: a mounted Customers page reloads now, an unmounted one reloads on next visit. */
export function invalidateCustomers(): void {
  if (custState.status !== "data" && custState.status !== "error") return;
  custState = { ...custState, status: "idle" };
  custEmit();
}

// ---- cross-store presence (mirrors list_product_presence in lib.rs) ----
export interface ProductPresence { id: string; handle: string; title: string; status: string }
export interface PresenceResult { products: ProductPresence[]; truncated: boolean } // truncated: hit the 8-page cap (2,000 products)
export type PresenceEntry = { status: OrdersStatus; data: PresenceResult | null; error: string | null };
export type PresenceState = Record<StoreId, PresenceEntry>;
const IDLE = { status: "idle" as const, data: null, error: null };
const LOADING = { status: "loading" as const, data: null, error: null };
let presState: PresenceState = { retail: IDLE, b2b: IDLE, bulk: IDLE };
const presSubs = new Set<() => void>();
const presEmit = () => presSubs.forEach((fn) => fn());

/** Load the id/handle/title/status list for any store (not just the active one). Entries settle independently; never rejects. */
export function loadPresence(store: StoreId, force = false): Promise<PresenceEntry> {
  const cur = presState[store];
  if (!force && cur.status !== "idle" && cur.status !== "error") return Promise.resolve(cur);
  presState = { ...presState, [store]: { ...cur, status: "loading", error: null } };
  presEmit();
  const settle = (entry: PresenceEntry) => { presState = { ...presState, [store]: entry }; presEmit(); return entry; };
  return invoke<PresenceResult>("list_product_presence", { storeId: store })
    .then((data) => settle({ status: "data", data, error: null }))
    .catch((e) => settle({ status: "error", data: null, error: String(e) })); // no stale list behind an "unavailable" tooltip
}
export const usePresence = () =>
  useSyncExternalStore((fn) => { presSubs.add(fn); return () => { presSubs.delete(fn); }; }, () => presState);
/** Mark every loaded/errored store stale; a mounted Catalog page reloads the ones it needs. */
export function invalidatePresence(): void {
  const stale = (e: PresenceEntry): PresenceEntry => (e.status === "data" || e.status === "error" ? { ...e, status: "idle" } : e);
  const next: PresenceState = { retail: stale(presState.retail), b2b: stale(presState.b2b), bulk: stale(presState.bulk) };
  if (STORES.some((s) => next[s.id] !== presState[s.id])) { presState = next; presEmit(); }
}
/** Status of `p` in another store's presence list, matched by handle first, then by lowercased trimmed title; null when not listed or unknown. */
// ponytail: handle/title match is a heuristic; swap for a shared SKU/metafield key once the stores share one.
// ponytail: linear scan per cell; index the list by handle once catalogs pass ~1k products.
export function presenceIn(p: CatalogProduct, list: ProductPresence[] | undefined): string | null {
  if (!list) return null;
  const t = p.title.trim().toLowerCase();
  const hit = list.find((x) => x.handle === p.handle) ?? list.find((x) => x.title.trim().toLowerCase() === t);
  return hit?.status ?? null;
}

// ---- analytics (derived from orders — no ShopifyQL, which would need read_reports; mirrors list_orders_since in lib.rs) ----
export interface OrderStub { createdAt: string; total: string; cancelled: boolean } // total "128.00 USD" (currentTotalPriceSet)
export interface OrdersSinceResult { orders: OrderStub[]; truncated: boolean } // truncated: hit the 10-page cap (2,000 orders)
export const ANALYTICS_RANGES = [7, 14, 30] as const;
export type AnalyticsEntry = { status: OrdersStatus; data: OrdersSinceResult | null; error: string | null };
export interface AnalyticsState { days: number; loadedAt: number; stores: Record<StoreId, AnalyticsEntry> }
let anState: AnalyticsState = { days: 0, loadedAt: 0, stores: { retail: IDLE, b2b: IDLE, bulk: IDLE } };
let anSeq = 0;
const anSubs = new Set<() => void>();
const anEmit = () => anSubs.forEach((fn) => fn());

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Local YYYY-MM-DD of today minus (days − 1): the first day of a `days`-day window that ends today. */
export function sinceFor(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return localDay(d);
}
/** One bucket per local calendar day from today−(days−1) to today; cancelled orders and anything outside the window are skipped. */
// ponytail: local-time buckets, not the shop IANA zone; fine while the Mac and the shops share Eastern.
export function bucketByDay(orders: OrderStub[], days: number): { key: string; label: string; orders: number; revenue: number }[] {
  const out = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return { key: localDay(d), label: dayFmt.format(d), orders: 0, revenue: 0 };
  });
  const at = new Map(out.map((b, i) => [b.key, i]));
  for (const o of orders) {
    const i = o.cancelled ? undefined : at.get(localDay(new Date(o.createdAt)));
    if (i == null) continue;
    out[i].orders += 1;
    out[i].revenue += moneyNum(o.total);
  }
  return out;
}

/** Fetch order stubs for all three stores concurrently (each settles on its own; a newer `days` supersedes in-flight results). Never rejects. */
export function loadAnalytics(days: number, force = false): Promise<AnalyticsState> {
  if (!force && anState.days === days && STORES.every((s) => anState.stores[s.id].status !== "idle")) return Promise.resolve(anState);
  const seq = ++anSeq;
  const since = sinceFor(days);
  anState = { ...anState, days, stores: { retail: LOADING, b2b: LOADING, bulk: LOADING } };
  anEmit();
  const settle = (id: StoreId, entry: AnalyticsEntry) => {
    if (seq !== anSeq) return; // superseded by a newer range
    anState = { ...anState, loadedAt: Date.now(), stores: { ...anState.stores, [id]: entry } };
    anEmit();
  };
  return Promise.all(STORES.map((s) =>
    invoke<OrdersSinceResult>("list_orders_since", { storeId: s.id, since })
      .then((data) => settle(s.id, { status: "data", data, error: null }))
      .catch((e) => settle(s.id, { status: "error", data: null, error: String(e) })),
  )).then(() => anState);
}
export const useAnalytics = () =>
  useSyncExternalStore((fn) => { anSubs.add(fn); return () => { anSubs.delete(fn); }; }, () => anState);
/** Mark every loaded/errored store stale; a mounted Analytics page reloads now, an unmounted one on next visit. */
export function invalidateAnalytics(): void {
  const stale = (e: AnalyticsEntry): AnalyticsEntry => (e.status === "data" || e.status === "error" ? { ...e, status: "idle" } : e);
  const stores = { retail: stale(anState.stores.retail), b2b: stale(anState.stores.b2b), bulk: stale(anState.stores.bulk) };
  if (STORES.some((s) => stores[s.id] !== anState.stores[s.id])) { anState = { ...anState, stores }; anEmit(); }
}

// ---- COAs (mirrors list_coas in lib.rs) ----
// Always the retail store: that is where the Files library, the coa_record metaobjects and /pages/coa live.
export interface CoaTerpene { name: string; pct: number | null }
export interface Coa {
  id: string; fileId: string; fileName: string; fileUrl: string; fileCreatedAt: string;
  batch: string | null; lab: string | null; producer: string | null; displayTitle: string | null;
  matchVia: string | null; parsed: boolean; qrPresent: boolean | null;
  productId: string | null; productName: string; productHandle: string | null; productStatus: string | null;
  productPublished: boolean; productOnlineStoreUrl: string | null;
  hasCoaRecord: boolean; coaRecordId: string | null; coaRecordStatus: string | null;
  postedStatus: "posted" | "unposted"; postedReason: string; postedSource: "page" | "product" | "metaobject" | null; onCoaPage: boolean;
  strain: string | null; type: string | null;
  issued: string; expires: string; daysToExpire: number; state: "valid" | "expiring" | "expired";
  thca: number | null; cbd: number | null; cbg: number | null; totalCannabinoids: number | null;
  terpenes: CoaTerpene[]; notes: string | null; edited: boolean;
  parsedAt: string | null; parsedModel: string | null; parseStale: boolean; // stale = parsed with an older prompt, needs a re-parse
}
export interface CoaList { coas: Coa[]; count: number; truncated: boolean; postedPage: { url: string; urlsFound: number; checkedAt: string; error: string | null } }
export interface ProductHit { id: string; title: string; handle: string; status: string }
/** Retail-store title search, at most 10 hits (the Re-link dialog and the Link view). */
export const searchProducts = (q: string) => invoke<ProductHit[]>("search_products", { q });
export const saveCoaLink = (fileId: string, productId: string | null, productTitle: string | null) => invoke<void>("save_coa_link", { fileId, productId, productTitle });
export const saveCoaFields = (fileId: string, fields?: Partial<Coa>, clear?: boolean) => invoke<Record<string, unknown> | null>("save_coa_fields", { fileId, fields, clear });
/** Writes `csv` to ~/Downloads/<filename>; resolves with the absolute path. */
export const exportCoasCsv = (filename: string, csv: string) => invoke<string>("export_coas_csv", { filename, csv });

// ---- OpenRouter · COA parsing (key in the Keychain, model id in localStorage) ----
export interface OpenRouterStatus { hasKey: boolean; keyHint: string | null; defaultModel: string }
export interface ParseResult { parsed: number; failed: number; skipped: number; elapsedMs: number; errors: string[]; results: { fileId: string; ok: boolean; error: string | null }[] }
/** prefs key for the model id; empty = the server default (`OpenRouterStatus.defaultModel`). */
export const OPENROUTER_MODEL_PREF = "openrouter.model";
export const getOpenRouterStatus = () => invoke<OpenRouterStatus>("get_openrouter_status");
/** Empty key removes it. Resolves with a message to toast. */
export const saveOpenRouterKey = (key: string) => invoke<string>("save_openrouter_key", { key });
/** LLM-parse PDFs (~10–40 s each, 4 in parallel); `force` re-parses already-parsed rows. Rejects without a key. */
export const parseCoas = (files: { fileId: string; fileUrl: string }[], model?: string, force?: boolean) =>
  invoke<ParseResult>("parse_coas", { files, model: model || undefined, force });

// ---- COA import wizard (mirrors upload_coa_pdf / import_coa / repost_coas in lib.rs; keys are camelCase) ----
export interface UploadResult { ok: boolean; fileId: string; url: string | null; fileStatus: string; filename: string }
export interface ImportTerpene { name: string; percent: number | null }
export interface ImportFields {
  batchId?: string | null; issueDate?: string | null; expiryDate?: string | null; lab?: string | null; producer?: string | null;
  thcaPercent?: number | null; cbdPercent?: number | null; cbgPercent?: number | null; totalCannabinoidsPercent?: number | null;
  terpenes: ImportTerpene[]; notes?: string | null; qrPresent?: boolean | null;
}
export interface ImportRequest {
  fileId: string; fileUrl: string | null; fileName: string | null; fields: ImportFields;
  productId: string | null; productTitle: string | null; pageName: string | null;
  /** true → coa_record ACTIVE + /pages/coa block; false → DRAFT record, no theme write. */
  post: boolean;
}
export type ImportStepName = "terpenes" | "metaobject" | "productLink" | "coaPage" | "cacheFields";
export interface ImportStep { step: ImportStepName; ok: boolean; critical: boolean; error: string | null; detail: unknown }
export interface ImportResult { ok: boolean; steps: ImportStep[]; metaobject: { id: string; handle: string } | null; unknownTerpenes: string[]; posted: boolean }
export interface RepostResult {
  posted: number; failed: number;
  results: { fileId: string; ok: boolean; name: string | null; action: "updated" | "added" | null; error: string | null }[];
}
/** Staged upload into the retail Files library; resolves once the CDN URL is known (up to ~20 s while it propagates). */
export const uploadCoaPdf = (filename: string, dataBase64: string) => invoke<UploadResult>("upload_coa_pdf", { filename, dataBase64 });
export const importCoa = (req: ImportRequest) => invoke<ImportResult>("import_coa", { req });
/** Re-write the /pages/coa block for files already in Shopify (`name` = the block's display name). */
export const repostCoas = (targets: { fileId: string; fileUrl: string; name: string | null }[]) => invoke<RepostResult>("repost_coas", { targets });
/** "Suver_Haze_FG-24-0918_<uuid>.pdf" → "Suver Haze FG-24-0918" (mirrors pdf_stem in lib.rs): default page / Drive name. */
export const pdfStem = (f: string) => f.replace(/\.pdf$/i, "").replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "").replace(/_/g, " ");

// ---- Google Drive + Sheet mirror (mirrors seed_google_config_from_old_env / google_status / google_mirror_coa in lib.rs; config in prefs) ----
export interface GoogleConfig { keyFile: string; sheetId: string | null; sheetTab: string | null; folderId: string | null }
export interface GoogleStatus {
  configured: boolean; serviceAccountEmail: string | null; sheetReachable: boolean; sheetTitle: string | null; tabs: string[];
  driveReachable: boolean; driveFolderName: string | null; error: string | null; // probe failures land here, never a rejection
}
/** One Sheet row, every cell a string or null (numbers pre-formatted, posted "Yes" / "No", importedAt ISO); the Rust side maps keys onto the tab's headers. */
export interface MirrorRow {
  batch: string | null; productName: string | null; flowerType: string | null; category: string | null; lab: string | null; issued: string | null; expires: string | null;
  thca: string | null; cbd: string | null; cbg: string | null; totalCannabinoids: string | null; shopifyUrl: string | null; posted: string | null; importedAt: string | null; notes: string | null;
}
export interface MirrorLeg { ok: boolean; skipped: string | null; error: string | null }
export interface MirrorResult {
  drive: MirrorLeg & { webViewLink: string | null; fileId: string | null; deduped: boolean };
  sheet: MirrorLeg & { action: "updated" | "appended" | null; rowNumber: number | null; tab: string | null; matchedFields: string[]; chip: string | null };
}
export const GOOGLE_PREFS = { keyFile: "google.keyFile", sheetId: "google.sheetId", sheetTab: "google.sheetTab", folderId: "google.folderId" } as const;
const blankNull = (s: string) => s.trim() || null;
/** The saved config (prefs); blank ids → null. */
export const googleConfig = (): GoogleConfig => ({
  keyFile: prefs.get(GOOGLE_PREFS.keyFile, "").trim(), sheetId: blankNull(prefs.get(GOOGLE_PREFS.sheetId, "")),
  sheetTab: blankNull(prefs.get(GOOGLE_PREFS.sheetTab, "")), folderId: blankNull(prefs.get(GOOGLE_PREFS.folderId, "")),
});
/** A key file plus somewhere to write. */
export const googleConfigured = (cfg: GoogleConfig) => !!cfg.keyFile && !!(cfg.sheetId || cfg.folderId);
/** The old dashboard's .env → a config; null when there is nothing to import. */
export const seedGoogleConfig = () => invoke<GoogleConfig | null>("seed_google_config_from_old_env");
/** Probes the Sheet and the folder as the service account. */
export const googleStatus = (cfg: GoogleConfig) => invoke<GoogleStatus>("google_status", { cfg });
/** Uploads the PDF as `pdfName` into the folder (same-name dedupe) and upserts the Sheet row by batch; each leg reports ok / skipped / error. */
export const googleMirrorCoa = (cfg: GoogleConfig, req: { fileUrl: string | null; pdfName: string; row: MirrorRow }) => invoke<MirrorResult>("google_mirror_coa", { cfg, req });
/** 27.0891 → "27.089", 18.1 → "18.1", null stays null. */
export const dec3 = (n: number | null | undefined) => (n == null ? null : String(Math.round(n * 1000) / 1000));
/** Sheet row for a library COA; `extra` carries the linked product's canonical flowerType / category from an import result. */
// ponytail: without `extra` flowerType is the raw product metafield (Coa.type), not the canonical "Type 1 (THCa)" the import writes.
export const mirrorRowFromCoa = (c: Coa, extra: { flowerType?: string | null; category?: string | null; posted?: boolean } = {}): MirrorRow => ({
  batch: c.batch, productName: c.productName || null, flowerType: extra.flowerType ?? c.type, category: extra.category ?? null, lab: c.lab, issued: c.issued || null, expires: c.expires || null,
  thca: dec3(c.thca), cbd: dec3(c.cbd), cbg: dec3(c.cbg), totalCannabinoids: dec3(c.totalCannabinoids), shopifyUrl: c.fileUrl,
  posted: (extra.posted ?? c.postedStatus === "posted") ? "Yes" : "No", importedAt: new Date().toISOString(), notes: c.notes,
});
/** Drive file name: the product name, else the cleaned file stem, + .pdf. */
export const pdfNameFor = (c: Coa) => `${c.productName || pdfStem(c.fileName)}.pdf`;
/** Canonical terpene names (the metaobject library); anything else comes back in `ImportResult.unknownTerpenes`. */
export const TERPENE_LIST = [
  "Myrcene", "Limonene", "Caryophyllene", "Linalool", "Pinene", "Alpha-Pinene", "Beta-Pinene",
  "Humulene", "Terpinolene", "Ocimene", "Bisabolol", "Alpha-Bisabolol", "Nerolidol",
  "Eucalyptol", "Geraniol", "Guaiol", "Valencene", "Camphene", "Fenchol", "Phytol",
  "Farnesene", "Terpineol", "Carene",
];
/** File → base64 body without the `data:…,` prefix (what upload_coa_pdf takes). */
export const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// ---- COA cache (same shape and semantics as the catalog cache, minus the store: COAs are always retail) ----
export interface CoasState { status: OrdersStatus; data: CoaList | null; error: string | null; loadedAt: number }
let coaState: CoasState = { status: "idle", data: null, error: null, loadedAt: 0 };
const coaSubs = new Set<() => void>();
const coaEmit = () => coaSubs.forEach((fn) => fn());

/** Load every COA (files + metaobjects + products + a /pages/coa scrape, so a few seconds). Never rejects. */
export function loadCoas(force = false): Promise<CoasState> {
  if (!force && coaState.status !== "idle" && coaState.status !== "error") return Promise.resolve(coaState);
  coaState = { ...coaState, status: "loading", error: null };
  coaEmit();
  return invoke<CoaList>("list_coas")
    .then((data) => { coaState = { status: "data", data, error: null, loadedAt: Date.now() }; coaEmit(); return coaState; })
    .catch((e) => { coaState = { ...coaState, status: "error", error: String(e) }; coaEmit(); return coaState; });
}
export const useCoas = () =>
  useSyncExternalStore((fn) => { coaSubs.add(fn); return () => { coaSubs.delete(fn); }; }, () => coaState);
/** Mark the cache stale: a mounted Lab page reloads now, an unmounted one reloads on next visit. */
export function invalidateCoas(): void {
  if (coaState.status !== "data" && coaState.status !== "error") return;
  coaState = { ...coaState, status: "idle" };
  coaEmit();
}
function mapCoa(fileId: string, fn: (c: Coa) => Coa): void {
  if (!coaState.data) return;
  coaState = { ...coaState, data: { ...coaState.data, coas: coaState.data.coas.map((c) => (c.fileId === fileId ? fn(c) : c)) } };
  coaEmit();
}
/** Apply a field edit to the cached row (call after save_coa_fields resolved); flags the row as edited. */
export const patchCoaLocal = (fileId: string, patch: Partial<Coa>) => mapCoa(fileId, (c) => ({ ...c, ...patch, edited: true }));
/** Apply a manual (un)link to the cached row (call after save_coa_link resolved). */
// ponytail: posted status / storefront URL stay as they were until the next pull — they depend on the new product.
export const relinkCoaLocal = (fileId: string, productId: string | null, productName: string | null) =>
  mapCoa(fileId, (c) => ({ ...c, productId, productName: productName ?? c.displayTitle ?? "", matchVia: productId ? "manual" : null }));
/** Pill text + colour for a COA's expiry: "212d" green · "12d" amber · "41d late" red (the Pill draws the ● dot). */
export const coaStateLabel = (c: Coa): { label: string; kind: Kind } =>
  c.state === "expired" ? { label: `${Math.abs(c.daysToExpire)}d late`, kind: "red" } : { label: `${c.daysToExpire}d`, kind: c.state === "expiring" ? "amber" : "green" };

// ---- formatting ----
export function money(s: string | null | undefined): string {
  if (!s) return "—";
  const [amount, currency = "USD"] = s.trim().split(/\s+/);
  const n = Number(amount);
  if (Number.isNaN(n)) return s;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n); } catch { return `$${n.toFixed(2)}`; }
}
export const moneyNum = (s: string | null | undefined) => Number((s ?? "").trim().split(/\s+/)[0]) || 0;

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** "Today 9:41" · "Yesterday 17:20" · "Sep 9 · 19:04" — matches the design's Created column. */
export function fmtCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const t = timeFmt.format(d);
  if (diffDays === 0) return `Today ${t}`;
  if (diffDays === 1) return `Yesterday ${t}`;
  return `${dayFmt.format(d)} · ${t}`;
}
export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);
};

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const PAY: Record<string, [string, Kind]> = {
  PAID: ["Paid", "green"], PENDING: ["Pending", "amber"], AUTHORIZED: ["Authorized", "amber"], PARTIALLY_PAID: ["Partially paid", "amber"],
  PARTIALLY_REFUNDED: ["Partially refunded", "neutral"], REFUNDED: ["Refunded", "neutral"], VOIDED: ["Voided", "red"], EXPIRED: ["Expired", "red"],
};
const FUL: Record<string, [string, Kind]> = {
  FULFILLED: ["Fulfilled", "green"], UNFULFILLED: ["Unfulfilled", "neutral"], PARTIALLY_FULFILLED: ["Partial", "amber"], ON_HOLD: ["On hold", "red"],
  IN_PROGRESS: ["In progress", "amber"], SCHEDULED: ["Scheduled", "amber"], PENDING_FULFILLMENT: ["Pending", "amber"], RESTOCKED: ["Restocked", "neutral"],
  REQUEST_DECLINED: ["Declined", "red"], OPEN: ["Open", "neutral"],
};
export const payStatus = (s: string | null): { label: string; kind: Kind } => {
  if (!s) return { label: "—", kind: "neutral" };
  const [label, kind] = PAY[s] ?? [titleCase(s), "neutral"];
  return { label, kind };
};
export const fulStatus = (s: string | null): { label: string; kind: Kind } => {
  if (!s) return { label: "—", kind: "neutral" };
  const [label, kind] = FUL[s] ?? [titleCase(s), "neutral"];
  return { label, kind };
};
/** Open fulfillment work: not fulfilled, and not closed/cancelled/refunded. */
export const isOpenFulfillment = (o: Order) =>
  o.displayFulfillmentStatus !== "FULFILLED" && !o.closed && !o.cancelled && !["REFUNDED", "VOIDED"].includes(o.displayFinancialStatus ?? "");

const PRODUCT_STATUS: Record<string, [string, Kind]> = { ACTIVE: ["Active", "green"], DRAFT: ["Draft", "amber"], ARCHIVED: ["Archived", "neutral"] };
export const productStatus = (s: string): { label: string; kind: Kind } => {
  const [label, kind] = PRODUCT_STATUS[s] ?? [titleCase(s), "neutral"];
  return { label, kind };
};
/** Second line under a product title: option values (sizes), else tags, else the handle. */
export function productProfile(p: CatalogProduct): string {
  const opts = p.options.filter((o) => o.values.length).map((o) => o.values.join(", "));
  if (opts.length) return opts.join(" · ");
  if (p.tags.length) return p.tags.slice(0, 4).join(" · ");
  return p.handle;
}
/** Stable swatch for products without media: a title-hashed hue in the design's green band (oklch 120–170). */
export function swatchColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `oklch(0.32 0.04 ${120 + (h % 50)})`;
}
/** Shopify refused the query: the app is missing `scope` (read_products by default) on that store. */
export const isScopeError = (e: string | null | undefined, scope = "read_products") => new RegExp(`${scope}|access denied`, "i").test(e ?? "");

/** Deep link into Shopify admin for an Order / Product / Customer GID (gid://shopify/<Type>/<id>); other types land on the admin root. */
const ADMIN_SEGMENT: Record<string, string> = { Order: "orders", Product: "products", Customer: "customers" };
export const adminUrl = (store: StoreId, gid: string) => {
  const root = `https://admin.shopify.com/store/${storeById(store).domain.replace(".myshopify.com", "")}`;
  const [, type = "", id] = /^gid:\/\/shopify\/(\w+)\/(\d+)/.exec(gid) ?? [];
  return ADMIN_SEGMENT[type] ? `${root}/${ADMIN_SEGMENT[type]}/${id}` : root;
};

const CHANNEL: Record<string, string> = { web: "Online Store", pos: "POS", shopify_draft_order: "Draft order", b2b: "B2B Portal", iphone: "Shop app", android: "Shop app" };
export const channelLabel = (s: string | null | undefined) => (s ? CHANNEL[s] ?? titleCase(s) : "—");

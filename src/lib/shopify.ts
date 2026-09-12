// Shopify data layer: Tauri invoke wrappers, a tiny orders cache, and display formatting.
// All live data comes from the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

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
export interface InventoryLevel { location: string; available: number; onHand: number; committed: number }
export interface InventoryVariant {
  id: string;
  productTitle: string;
  variantTitle: string | null; // null when Shopify title is "Default Title"
  sku: string | null;
  productStatus: string; // ACTIVE | DRAFT | ARCHIVED
  tracked: boolean;
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
    .then((data) => {
      if (invState.store !== store) return invState; // store switched mid-flight
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
/** Shopify refused the products query: the app is missing the read_products scope on that store. */
export const isScopeError = (e: string | null | undefined) => /read_products|access denied/i.test(e ?? "");

/** Deep link into Shopify admin for an order GID. */
export const orderAdminUrl = (store: StoreId, gid: string) =>
  `https://admin.shopify.com/store/${storeById(store).domain.replace(".myshopify.com", "")}/orders/${gid.split("/").pop()}`;

const CHANNEL: Record<string, string> = { web: "Online Store", pos: "POS", shopify_draft_order: "Draft order", b2b: "B2B Portal", iphone: "Shop app", android: "Shop app" };
export const channelLabel = (s: string | null | undefined) => (s ? CHANNEL[s] ?? titleCase(s) : "—");

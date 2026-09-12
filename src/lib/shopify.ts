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

/** Deep link into Shopify admin for an order GID. */
export const orderAdminUrl = (store: StoreId, gid: string) =>
  `https://admin.shopify.com/store/${storeById(store).domain.replace(".myshopify.com", "")}/orders/${gid.split("/").pop()}`;

const CHANNEL: Record<string, string> = { web: "Online Store", pos: "POS", shopify_draft_order: "Draft order", b2b: "B2B Portal", iphone: "Shop app", android: "Shop app" };
export const channelLabel = (s: string | null | undefined) => (s ? CHANNEL[s] ?? titleCase(s) : "—");

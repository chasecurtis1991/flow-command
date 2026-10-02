// Browser-preview shim: when `npm run dev` is opened in a plain browser (no Tauri runtime),
// answer Tauri `invoke` calls with the design's sample orders so the UI can be reviewed.
// Never loaded inside the real app — main.tsx only imports this when __TAURI_INTERNALS__ is absent.
import {
  TERPENE_LIST, type CatalogProduct, type CatalogResult, type Coa, type CoaList, type Customer, type CustomersResult, type GoogleConfig, type GoogleStatus, type ImportRequest, type ImportStep,
  type FulfillmentInfo, type InventoryResult, type InventoryVariant, type MirrorResult, type Order, type OrderDetail, type OrdersPage, type OrdersSinceResult, type PresenceResult, type ProductHit,
} from "./shopify";
import type { SplitPreview, SplitResult, SplitVariant } from "./variantSplit";

const STORES = [
  { id: "retail", label: "Retail", domain: "3wvfyr-1i.myshopify.com" },
  { id: "b2b", label: "B2B / Wholesale", domain: "b8h8vg-ij.myshopify.com" },
  { id: "bulk", label: "Bulk / Craft Flower", domain: "fg-craft-flower.myshopify.com" },
];
let active = "retail";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
type Raw = [string, number, string, number, string, string, string, string, number, string, [string, string, number, number][], string | null];
const RAW: Raw[] = [
  ["#R-10482", 1, "Marisol Ortega", 128, "PAID", "UNFULFILLED", "web", "marisol.o@gmail.com", 6, "Marisol Ortega\n2214 Alder St\nPortland, OR 97214", [["Sour Space Candy · 7g", "FG-SSC-7G", 1, 42], ["Lifter · 14g", "FG-LFT-14G", 1, 72], ["Pre-rolls · 2pk Hawaiian Haze", "FG-HH-PR2", 1, 14]], "Customer asked for discreet packaging."],
  ["#W-3391", 2, "Cascade Botanicals LLC", 4860, "PENDING", "PARTIALLY_FULFILLED", "web", "orders@cascadebotanicals.com", 31, "Cascade Botanicals\n188 Industrial Way, Unit C\nEugene, OR 97402", [["Hawaiian Haze · 1 lb", "FG-HH-1LB", 6, 520], ["Suver Haze · 1 lb", "FG-SVH-1LB", 3, 540], ["Cherry Wine · ¼ lb", "FG-CHW-4OZ", 2, 150]], "Ship Hawaiian Haze first; Suver Haze on backorder until lot FG-24-0918 clears COA."],
  ["#R-10481", 3, "Devin Marsh", 64, "PAID", "FULFILLED", "web", "devin.marsh@me.com", 2, "Devin Marsh\n90 Pine Ave\nBend, OR 97701", [["Elektra · 7g", "FG-ELK-7G", 1, 40], ["Special Sauce · 3.5g", "FG-SPS-3.5G", 1, 24]], null],
  ["#B-0776", 20, "Northwind Extracts", 12400, "PENDING", "UNFULFILLED", "shopify_draft_order", "purchasing@northwind-extracts.com", 9, "Northwind Extracts\n4400 SE 17th Ave\nPortland, OR 97202", [["Bubba Kush · biomass, 10 lb", "FG-BBK-10LB", 4, 3100]], "Awaiting wire. Do not fulfill until payment captured."],
  ["#R-10480", 22, "Priya Natarajan", 96, "PAID", "FULFILLED", "web", "priya.n@outlook.com", 11, "Priya Natarajan\n7 Willow Ct\nSeattle, WA 98103", [["Sour Lifter · 14g", "FG-SLF-14G", 1, 70], ["Cherry Blossom · 3.5g", "FG-CHB-3.5G", 1, 26]], null],
  ["#W-3390", 24, "Green River Apothecary", 1980, "PAID", "FULFILLED", "web", "buyer@greenriverapothecary.com", 18, "Green River Apothecary\n312 Main St\nBoise, ID 83702", [["Lifter · 1 lb", "FG-LFT-1LB", 3, 500], ["Sour Space Candy · ¼ lb", "FG-SSC-4OZ", 3, 160]], null],
  ["#R-10479", 27, "Tomas Reyes", 42, "REFUNDED", "UNFULFILLED", "web", "tomas.reyes@gmail.com", 1, "Tomas Reyes\n55 Harbor Rd\nAstoria, OR 97103", [["Sour Space Candy · 7g", "FG-SSC-7G", 1, 42]], "Refunded at customer request before shipment."],
  ["#R-10478", 44, "Hannah Kessler", 156, "PAID", "FULFILLED", "web", "hkessler@proton.me", 4, "Hannah Kessler\n1400 NW 23rd\nPortland, OR 97210", [["Hawaiian Haze · 28g", "FG-HH-28G", 1, 120], ["Pre-rolls · 5pk Lifter", "FG-LFT-PR5", 1, 36]], null],
  ["#B-0775", 48, "Pacific Hemp Co-op", 6200, "PAID", "FULFILLED", "shopify_draft_order", "ops@pacifichempcoop.org", 5, "Pacific Hemp Co-op\n2020 Grange Rd\nSalem, OR 97301", [["Suver Haze · smalls, 5 lb", "FG-SVH-SM5", 2, 3100]], null],
  ["#W-3389", 53, "Highline Wellness", 2740, "PENDING", "FULFILLED", "web", "po@highlinewellness.co", 22, "Highline Wellness\n88 Broadway\nDenver, CO 80203", [["Elektra · 1 lb", "FG-ELK-1LB", 4, 520], ["Special Sauce · ¼ lb", "FG-SPS-4OZ", 4, 165]], null],
  ["#R-10477", 66, "Leo Brandt", 58, "PAID", "ON_HOLD", "web", "leo.brandt@gmail.com", 3, "Leo Brandt\n610 Elm St\nBoise, ID 83702", [["Cherry Wine · 7g", "FG-CHW-7G", 1, 44], ["Pre-rolls · 2pk Elektra", "FG-ELK-PR2", 1, 14]], "Address failed validation — awaiting customer reply."],
  ["#R-10476", 70, "Aisha Bello", 210, "PAID", "FULFILLED", "web", "aisha.bello@yahoo.com", 7, "Aisha Bello\n33 Cedar Ln\nTacoma, WA 98402", [["Lifter · 28g", "FG-LFT-28G", 1, 130], ["Suver Haze · 14g", "FG-SVH-14G", 1, 80]], null],
  ["#W-3388", 79, "Cascade Botanicals LLC", 3120, "PAID", "FULFILLED", "web", "orders@cascadebotanicals.com", 31, "Cascade Botanicals\n188 Industrial Way, Unit C\nEugene, OR 97402", [["Lifter · 1 lb", "FG-LFT-1LB", 6, 520]], null],
  ["#R-10475", 98, "Grace Whitfield", 88, "PAID", "FULFILLED", "web", "gwhitfield@gmail.com", 2, "Grace Whitfield\n120 Ocean Dr\nNewport, OR 97365", [["Hawaiian Haze · 14g", "FG-HH-14G", 1, 68], ["Cherry Blossom · pre-roll", "FG-CHB-PR1", 2, 10]], null],
];
const usd = (n: number) => `${n.toFixed(2)} USD`;
// The design's 13 sample orders plus ~130 older ones spun from the same templates, so the Orders table has
// several pages to page through in the browser preview. Older orders are mostly fulfilled and paid.
const EXTRA = 130;
const OLD_FIN = ["PAID", "PAID", "PAID", "PAID", "PENDING", "PAID", "PARTIALLY_REFUNDED", "PAID", "REFUNDED", "PAID", "AUTHORIZED"];
const OLD_FUL = ["FULFILLED", "FULFILLED", "FULFILLED", "UNFULFILLED", "FULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "FULFILLED", "ON_HOLD", "FULFILLED", "SCHEDULED", "FULFILLED"];
const EXTRA_NAMES: [string, string][] = [
  ["Jonah Feld", "jonah.feld@gmail.com"], ["Rosa Delgado", "rosa.d@icloud.com"], ["Alder & Ash Apothecary", "orders@alderash.co"], ["Kenji Watanabe", "kenji.w@me.com"],
  ["Blue Heron Farms", "buying@blueheronfarms.com"], ["Talia Brooks", "talia.brooks@outlook.com"], ["Summit Hemp Supply", "po@summithemp.com"], ["Ines Moreau", "ines.moreau@proton.me"],
];
const ORDER_SEED = RAW.length;
const template = (i: number) => RAW[i % RAW.length];
const orders: Order[] = [
  ...RAW.map((o, i): Order => ({
    id: `gid://shopify/Order/${10000 + i}`, name: o[0], createdAt: hoursAgo(o[1]), displayFinancialStatus: o[4], displayFulfillmentStatus: o[5],
    totalPrice: usd(o[3]), customerName: o[2], customerEmail: o[7], closed: o[5] === "FULFILLED", cancelled: false,
  })),
  ...Array.from({ length: EXTRA }, (_, k): Order => {
    const i = ORDER_SEED + k, t = template(i);
    const [prefix, num] = t[0].slice(1).split("-");
    const fin = OLD_FIN[k % OLD_FIN.length], ful = OLD_FUL[k % OLD_FUL.length];
    const [customerName, customerEmail] = k % 3 === 0 ? EXTRA_NAMES[k % EXTRA_NAMES.length] : [t[2], t[7]];
    return {
      id: `gid://shopify/Order/${10000 + i}`, name: `#${prefix}-${String(Number(num) - 20 - k).padStart(num.length, "0")}`,
      createdAt: hoursAgo(120 + k * 9.7 + (k % 5) * 1.3), displayFinancialStatus: fin, displayFulfillmentStatus: ful,
      totalPrice: usd(Math.round(t[3] * (0.6 + ((k * 7) % 9) / 10))), customerName, customerEmail,
      closed: ful === "FULFILLED" || fin === "REFUNDED", cancelled: fin === "REFUNDED" && k % 2 === 0,
    };
  }),
];
// Browser-preview fulfillment: one fulfillment order per order at Warehouse; fulfilled orders start with a USPS shipment.
const fulfillState = new Map<string, FulfillmentInfo>();
function fulfillmentInfo(orderId: string): FulfillmentInfo {
  let st = fulfillState.get(orderId);
  if (!st) {
    const d = detail(orderId), done = d.displayFulfillmentStatus === "FULFILLED";
    st = {
      fulfillmentOrders: [{ id: orderId.replace("Order", "FulfillmentOrder"), status: done ? "CLOSED" : "OPEN", location: "Warehouse", canFulfill: !done,
        lines: d.lineItems.map((li, k) => ({ id: `${orderId.replace("Order", "FulfillmentOrderLineItem")}-${k}`, title: li.title, sku: li.sku, remaining: done ? 0 : li.quantity, total: li.quantity })) }],
      shipments: done ? [{ id: orderId.replace("Order", "Fulfillment"), status: "DELIVERED", createdAt: d.createdAt,
        tracking: [{ company: "USPS", number: "9400111899223197428490", url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490" }],
        items: d.lineItems.map((li) => `${li.quantity} × ${li.title}`) }] : [],
    };
    fulfillState.set(orderId, st);
  }
  return st;
}
function fulfill(a: Record<string, unknown>) {
  const r = a.request as { orderId: string; fulfillmentOrderId: string; lines: { id: string; quantity: number }[]; trackingCompany?: string; trackingNumber?: string };
  const st = fulfillmentInfo(r.orderId);
  const fo = st.fulfillmentOrders.find((f) => f.id === r.fulfillmentOrderId);
  if (!fo?.canFulfill) throw new Error("These items can't be fulfilled from here (status CLOSED). They may already be fulfilled — probably by ShipStation — or on hold. Reload the order.");
  for (const l of r.lines) {
    const line = fo.lines.find((x) => x.id === l.id)!;
    if (l.quantity > line.remaining) throw new Error(`Only ${line.remaining} of "${line.title}" left to fulfill — it may have just been fulfilled (e.g. by ShipStation). Reload the order.`);
  }
  for (const l of r.lines) fo.lines.find((x) => x.id === l.id)!.remaining -= l.quantity;
  if (fo.lines.every((l) => l.remaining === 0)) { fo.status = "CLOSED"; fo.canFulfill = false; } else fo.status = "IN_PROGRESS";
  st.shipments.push({ id: `gid://shopify/Fulfillment/${Date.now()}`, status: "SUCCESS", createdAt: new Date().toISOString(),
    tracking: r.trackingNumber ? [{ company: r.trackingCompany ?? null, number: r.trackingNumber, url: null }] : [],
    items: r.lines.map((l) => `${l.quantity} × ${fo.lines.find((x) => x.id === l.id)!.title}`) });
  const o = orders.find((x) => x.id === r.orderId);
  if (o) o.displayFulfillmentStatus = fo.status === "CLOSED" ? "FULFILLED" : "PARTIALLY_FULFILLED";
  return st;
}

// Browser-preview note/tag edits, kept in memory (same checks as order_notes.rs).
const noteEdits = new Map<string, { note?: string | null; tags?: string[] }>();
function updateNoteTags(a: Record<string, unknown>) {
  const r = a.request as { orderId: string; note: string | null; expectedNote: string | null; addTags: string[]; removeTags: string[] };
  const cur = detail(r.orderId);
  if (r.note !== null && (cur.note ?? null) !== (r.expectedNote ?? null)) throw new Error("The note changed in Shopify since this order was loaded — reload the order and review again.");
  const lower = r.removeTags.map((t) => t.toLowerCase());
  const tags = [...cur.tags.filter((t) => !lower.includes(t.toLowerCase())), ...r.addTags.filter((t) => !cur.tags.some((c) => c.toLowerCase() === t.toLowerCase()))];
  const note = r.note === null ? cur.note ?? null : r.note.trim() ? r.note.trimEnd() : null;
  noteEdits.set(r.orderId, { note, tags });
  return { note, tags };
}
const detail = (id: string): OrderDetail => {
  const i = orders.findIndex((o) => o.id === id);
  if (i < 0) throw new Error("Order not found");
  const o = template(i);
  const subtotal = o[10].reduce((a, li) => a + li[2] * li[3], 0);
  return {
    ...orders[i], subtotalPrice: usd(subtotal), totalTax: usd(0), totalShipping: usd(Math.max(0, o[3] - subtotal)),
    note: noteEdits.get(id)?.note !== undefined ? noteEdits.get(id)!.note : o[11], tags: noteEdits.get(id)?.tags ?? (i % 3 === 0 ? ["vip"] : []),
    shippingAddress: i < ORDER_SEED ? o[9] : `${orders[i].customerName}\n${o[9].split("\n").slice(1).join("\n")}`, customerOrdersCount: o[8], channel: o[6],
    lineItems: o[10].map((li) => ({ title: li[0], sku: li[1], quantity: li[2], price: usd(li[3]) })),
  };
};
const storeOrders = (id = active) => (id === "retail" ? orders : orders.filter((o) => (id === "b2b" ? o.name.startsWith("#W") : o.name.startsWith("#B"))));

// Enough of Shopify's search syntax for what buildOrdersQuery() emits: `status:open`, `name:x`, free words,
// and `field:v` / `(field:a OR field:b)` groups for financial_status / fulfillment_status.
const FIN_ENUM: Record<string, string> = { paid: "PAID", pending: "PENDING", authorized: "AUTHORIZED", partially_paid: "PARTIALLY_PAID", partially_refunded: "PARTIALLY_REFUNDED", refunded: "REFUNDED", voided: "VOIDED", expired: "EXPIRED" };
const FUL_ENUM: Record<string, string> = { unfulfilled: "UNFULFILLED", partial: "PARTIALLY_FULFILLED", fulfilled: "FULFILLED", scheduled: "SCHEDULED", on_hold: "ON_HOLD", request_declined: "REQUEST_DECLINED" };
function matchesQuery(o: Order, query: string): boolean {
  const unescape = (s: string) => s.replace(/\\(.)/g, "$1").toLowerCase();
  const term = (t: string): boolean => {
    const m = /^([a-z_]+):(.+)$/.exec(t);
    if (!m) return `${o.name} ${o.customerName ?? ""} ${o.customerEmail ?? ""}`.toLowerCase().includes(unescape(t));
    const [, field, raw] = m, v = unescape(raw);
    switch (field) {
      case "status": return v === "open" ? !o.closed && !o.cancelled : v === "closed" ? !!o.closed : v === "cancelled" ? !!o.cancelled : true;
      case "name": return o.name.toLowerCase().replace(/^#/, "").includes(v.replace(/^#/, ""));
      case "financial_status": return o.displayFinancialStatus === FIN_ENUM[v];
      case "fulfillment_status": return o.displayFulfillmentStatus === FUL_ENUM[v];
      default: return true;
    }
  };
  const groups: string[][] = [];
  const rest = query.replace(/\(([^)]*)\)/g, (_, g: string) => { groups.push(g.split(/\s+OR\s+/)); return " "; });
  return groups.every((g) => g.some(term)) && rest.split(/\s+/).filter(Boolean).every(term);
}
const SORT_GET: Record<string, (o: Order) => string | number> = {
  CREATED_AT: (o) => o.createdAt, UPDATED_AT: (o) => o.createdAt, PROCESSED_AT: (o) => o.createdAt,
  ORDER_NUMBER: (o) => Number(o.name.replace(/\D/g, "")), CUSTOMER_NAME: (o) => (o.customerName ?? "").toLowerCase(),
  TOTAL_PRICE: (o) => Number(o.totalPrice.split(" ")[0]), FINANCIAL_STATUS: (o) => o.displayFinancialStatus ?? "", FULFILLMENT_STATUS: (o) => o.displayFulfillmentStatus ?? "",
};
function ordersPage(args: Record<string, unknown>): OrdersPage {
  const first = Math.min(200, Math.max(1, Number(args.first ?? 50)));
  const get = SORT_GET[String(args.sortKey ?? "CREATED_AT")] ?? SORT_GET.CREATED_AT;
  const dir = args.reverse === false ? 1 : -1;
  const q = typeof args.query === "string" ? args.query.trim() : "";
  const rows = storeOrders().filter((o) => !q || matchesQuery(o, q))
    .sort((a, b) => { const x = get(a), y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const start = typeof args.after === "string" && args.after ? Number(atob(args.after)) || 0 : 0; // cursor = base64 row offset
  const page = rows.slice(start, start + first);
  return {
    orders: page, hasNextPage: start + page.length < rows.length, hasPreviousPage: start > 0,
    endCursor: page.length ? btoa(String(start + page.length)) : null, totalCount: rows.length, totalPrecision: "EXACT",
  };
}

// Customers are the active store's orders folded by email, so the sample agrees with the Orders page.
const BIZ = /LLC|Co-op|Extracts|Apothecary|Wellness|Botanicals|Farms|Supply/;
const cityState = (addr: string) => { const m = /^(.+), ([A-Z]{2}) \d+$/.exec(addr.split("\n").pop() ?? ""); return m ? `${m[1]}, ${m[2]}` : null; };
function customers(args: Record<string, unknown>): CustomersResult {
  const mine = new Set(storeOrders());
  const by = new Map<string, Customer & { spent: number }>();
  orders.forEach((o, i) => {
    if (!mine.has(o)) return;
    const email = o.customerEmail ?? "", name = o.customerName ?? email, total = Number(o.totalPrice.split(" ")[0]);
    const c = by.get(email);
    if (!c) {
      by.set(email, {
        id: `gid://shopify/Customer/${50000 + by.size}`, displayName: name, email, phone: null, company: BIZ.test(name) ? name : null, location: cityState(template(i)[9]),
        ordersCount: 1, amountSpent: "", spent: total, lastOrderName: o.name, lastOrderAt: o.createdAt, createdAt: o.createdAt, tags: [],
      });
      return;
    }
    c.ordersCount += 1; c.spent += total;
    if (o.createdAt > c.lastOrderAt!) { c.lastOrderAt = o.createdAt; c.lastOrderName = o.name; }
    if (o.createdAt < c.createdAt) c.createdAt = o.createdAt;
  });
  const q = typeof args.query === "string" ? args.query.replace(/\\(.)/g, "$1").trim().toLowerCase() : "";
  const rows = [...by.values()]
    .filter((c) => !q || `${c.displayName} ${c.email} ${c.company ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => (a.lastOrderAt! < b.lastOrderAt! ? 1 : -1))
    .map((c) => ({ ...c, amountSpent: usd(c.spent) }));
  const first = Math.min(100, Math.max(1, Number(args.first ?? 100)));
  return { customers: rows.slice(0, first), hasNextPage: rows.length > first, totalCount: rows.length, totalPrecision: "EXACT" };
}
const ordersSince = (storeId: string, since: string): OrdersSinceResult => ({
  orders: storeOrders(storeId).filter((o) => o.createdAt.slice(0, 10) >= since).map((o) => ({ createdAt: o.createdAt, total: o.totalPrice, cancelled: !!o.cancelled })),
  truncated: false,
});

// Inventory sample: [product, variant, sku, status, tracked, warehouse, retail floor, committed]
const INV_LOCS = ["Warehouse", "Retail floor"];
type RawInv = [string, string | null, string | null, string, boolean, number, number, number];
const INV_RAW: RawInv[] = [
  ["Sour Space Candy", "7g", "FG-SSC-7G", "ACTIVE", true, 84, 12, 3],
  ["Sour Space Candy", "14g", "FG-SSC-14G", "ACTIVE", true, 30, 6, 1],
  ["Sour Space Candy", "28g", "FG-SSC-28G", "ACTIVE", true, 9, 0, 0],
  ["Lifter", "1 lb", "FG-LFT-1LB", "ACTIVE", true, 14, 0, 6],
  ["Lifter", "7g", "FG-LFT-7G", "ACTIVE", true, 120, 14, 4],
  ["Suver Haze", "1 lb", "FG-SVH-1LB", "ACTIVE", true, 0, 0, 0],
  ["Special Sauce", "3.5g", "FG-SPS-3.5G", "ACTIVE", true, 6, 2, 0],
  ["Bubba Kush biomass", "10 lb", "FG-BBK-10LB", "ACTIVE", false, 0, 0, 0],
  ["Hawaiian Haze", "14g", "FG-HH-14G", "DRAFT", true, 30, 4, 0],
  ["Hawaiian Haze", "1 lb", "FG-HH-1LB", "DRAFT", true, 12, 0, 0],
  ["Elektra", null, null, "ACTIVE", true, 22, 5, 1],
  ["Cherry Wine", "7g", "FG-CHW-7G", "ACTIVE", true, 48, 9, 2],
  ["Shipping Protection by Route", "0.98", "ROUTEINS", "ACTIVE", true, 10000000, 0, 0], // Route's app product: must be hidden by HIDDEN_INVENTORY
];
const locId = (j: number) => `gid://shopify/Location/${80000 + j}`;
const invVariants: InventoryVariant[] = INV_RAW.map((v, i) => {
  const [productTitle, variantTitle, sku, productStatus, tracked, wh, rf, committed] = v;
  const available = wh + rf - committed;
  return {
    id: `gid://shopify/ProductVariant/${40000 + i}`, productId: `gid://shopify/Product/${60000 + INV_RAW.findIndex((r) => r[0] === v[0])}`, // first row with this product title
    productTitle, variantTitle, sku, productStatus, tracked, available, inventoryItemId: tracked ? `gid://shopify/InventoryItem/${70000 + i}` : null,
    levels: tracked ? [
      { location: INV_LOCS[0], locationId: locId(0), available: wh - committed, onHand: wh, committed },
      { location: INV_LOCS[1], locationId: locId(1), available: rf, onHand: rf, committed: 0 },
    ] : [],
  };
});
/** Browser-preview adjust/receive/transfer: same checks as inventory_adjust.rs (stale counts, zero lines), all-or-nothing, in memory. */
function adjust(a: Record<string, unknown>) {
  const r = a.request as { changes: { inventoryItemId: string; locationId: string; delta: number; changeFrom: number }[] };
  const targets = r.changes.map((c) => {
    const v = invVariants.find((x) => x.inventoryItemId === c.inventoryItemId);
    const l = v?.levels.find((x) => x.locationId === c.locationId);
    if (!v || !l) throw new Error("An item isn't stocked at that location in Shopify — stock it there first.");
    if (c.delta === 0) throw new Error("A line has a quantity of 0 — remove it or enter a number.");
    if (l.available !== c.changeFrom) throw new Error("The count changed in Shopify since it was loaded — sync and review again.");
    return { v, l, c };
  });
  for (const { v, l, c } of targets) { l.available += c.delta; l.onHand += c.delta; v.available += c.delta; }
  return targets.map(({ l, c }) => ({ inventoryItemId: c.inventoryItemId, locationId: c.locationId, available: l.available, onHand: l.onHand }));
}
const inventory = (): InventoryResult => ({
  variants: invVariants.filter((v) => active === "retail" || (active === "b2b" ? v.variantTitle?.includes("lb") : v.productTitle.includes("biomass"))),
  locations: INV_LOCS, levelsError: null, truncated: false,
});

// Catalog sample (the design's products): [title, type, status, stores r/b/u, sizes, min price, max price, tags]
type RawProduct = [string, string, string, string, string[], number, number, string[]];
const CAT_RAW: RawProduct[] = [
  ["Sour Space Candy", "Flower", "ACTIVE", "rb", ["3.5g", "7g", "14g", "28g", "¼ lb", "1 lb"], 24, 520, ["sativa-leaning", "17.2% CBD"]],
  ["Lifter", "Flower", "ACTIVE", "rbu", ["3.5g", "7g", "14g", "28g", "¼ lb", "1 lb", "5 lb"], 22, 2400, ["hybrid", "18.5% CBD"]],
  ["Hawaiian Haze", "Flower", "ACTIVE", "rbu", ["3.5g", "7g", "14g", "28g", "¼ lb", "1 lb", "5 lb"], 26, 2600, ["sativa", "16.8% CBD"]],
  ["Suver Haze", "Flower", "ACTIVE", "bu", ["¼ lb", "1 lb", "5 lb"], 80, 3100, ["sativa", "19.1% CBD"]],
  ["Elektra", "Flower", "ACTIVE", "rb", ["3.5g", "7g", "14g", "28g", "1 lb"], 24, 520, ["indica-leaning", "15.9% CBD"]],
  ["Cherry Wine", "Flower", "ACTIVE", "rb", ["3.5g", "7g", "14g", "¼ lb"], 26, 150, ["hybrid", "14.7% CBD"]],
  ["Special Sauce", "Flower", "ACTIVE", "rb", ["3.5g", "7g", "14g", "¼ lb"], 24, 165, ["indica", "17.4% CBD"]],
  ["Bubba Kush biomass", "Biomass", "ACTIVE", "u", ["10 lb", "50 lb"], 3100, 14000, ["indica", "biomass"]],
  ["Pre-rolls · Hawaiian Haze", "Pre-rolls", "ACTIVE", "r", ["2pk", "5pk"], 14, 36, ["sativa"]],
  ["Cherry Blossom", "Flower", "DRAFT", "r", ["3.5g", "7g", "pre-roll"], 10, 44, ["hybrid", "13.2% CBD"]],
  ["Sour Lifter", "Flower", "ARCHIVED", "r", ["14g", "28g"], 70, 130, ["hybrid", "18.0% CBD"]],
];
// Real featured-image renders from the retail store's public CDN (titles differ; only so the grid preview shows how photos sit).
const MOCK_IMAGES: Record<string, string> = {
  "Sour Space Candy": "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/41kings_480x480.png?v=1762979371",
  "Lifter": "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/aliengrapevine_480x480.png?v=1763049830",
  "Hawaiian Haze": "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/Aloha_Sugar_480x480.png?v=1777292681",
  "Elektra": "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/angryapple_480x480.png?v=1755174230",
  "Cherry Wine": "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/2oz-Shot_480x480.png?v=1780413879",
};
const catProducts: (CatalogProduct & { stores: string })[] = CAT_RAW.map((p, i) => ({
  id: `gid://shopify/Product/${70000 + i}`, title: p[0], handle: p[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""), status: p[2],
  productType: p[1], vendor: "Flow Gardens", tags: p[7], variantCount: p[4].length, minPrice: usd(p[5]), maxPrice: usd(p[6]),
  totalInventory: p[2] === "ACTIVE" ? 40 * (i + 1) : 0, tracksInventory: p[1] !== "Biomass", imageUrl: MOCK_IMAGES[p[0]] ?? null,
  options: p[4].length > 1 ? [{ name: "Size", values: p[4] }] : [], updatedAt: hoursAgo(6 * (i + 1)), stores: p[3],
}));
// Source variants are stored independently of the split preview, just as they are in Shopify.
// Legacy design rows keep their existing inventory SKUs; missing values stay missing.
const sourceVariants = new Map<string, SplitVariant[]>(catProducts.map((p) => {
  const sizes = p.options[0]?.values ?? ["Default Title"];
  const min = Number.parseFloat(p.minPrice), max = Number.parseFloat(p.maxPrice);
  return [p.id, sizes.map((size, i) => ({
    id: `gid://shopify/ProductVariant/${p.id.split("/").pop()}${i}`,
    title: size === "Default Title" ? p.title : `${p.title} — ${size}`, variantTitle: size,
    sku: INV_RAW.find(([title, variant]) => title === p.title && variant === size)?.[2] ?? null,
    price: (min + (max - min) * i / Math.max(1, sizes.length - 1)).toFixed(2),
    compareAtPrice: null, currency: "USD", imageUrl: p.imageUrl,
  }))];
}));
// Representative retail fixtures using the supplied SKU guide's exact strain codes.
// https://docs.google.com/spreadsheets/d/1jfND_4YKWKH5IgWBefIRPnRBy-QLO3Bl5t1okblIne0/edit
// Prices/stock here are sample data, not a copy of the live catalog. Do not derive strain
// codes from initials: Alien Grapevine is 1ZCW in the guide, not 1AGX (Alien Grapes).
const SKU_GUIDE_SAMPLES: { title: string; imageUrl: string | null; variants: [size: string, sku: string, price: string][] }[] = [
  { title: "41 Kings", imageUrl: MOCK_IMAGES["Sour Space Candy"], variants: [
    ["3.5g", "RF03-14KX", "24.00"], ["7g", "RF07-14KX", "42.00"], ["14g", "RF14-14KX", "78.00"],
    ["28g", "RF28-14KX", "140.00"], ["1 lb", "RFLB-14KX", "520.00"],
  ] },
  { title: "Alien Grapevine", imageUrl: MOCK_IMAGES["Lifter"], variants: [
    ["3.5g", "RF03-1ZCW", "24.00"], ["7g", "RF07-1ZCW", "42.00"], ["14g", "RF14-1ZCW", "78.00"],
  ] },
  { title: "The White CBG", imageUrl: null, variants: [
    ["3.5g", "RF03-4TWC", "20.00"], ["7g", "RF07-4TWC", "36.00"], ["14g", "RF14-4TWC", "64.00"],
  ] },
];
SKU_GUIDE_SAMPLES.forEach((sample, i) => {
  const id = `gid://shopify/Product/${71000 + i}`;
  const variants: SplitVariant[] = sample.variants.map(([size, sku, price], j) => ({
    id: `gid://shopify/ProductVariant/${81000 + i * 10 + j}`, title: `${sample.title} — ${size}`, variantTitle: size,
    sku, price, compareAtPrice: null, currency: "USD", imageUrl: sample.imageUrl,
  }));
  sourceVariants.set(id, variants);
  catProducts.push({
    id, title: sample.title, handle: sample.title.toLowerCase().replace(/\s+/g, "-"), status: "ACTIVE", productType: "Flower",
    vendor: "Flow Gardens", tags: ["SKU guide sample"], variantCount: variants.length,
    minPrice: usd(Math.min(...variants.map((v) => Number(v.price)))), maxPrice: usd(Math.max(...variants.map((v) => Number(v.price)))),
    totalInventory: variants.length * 20, tracksInventory: true, imageUrl: sample.imageUrl,
    options: [{ name: "Size", values: variants.map((v) => v.variantTitle) }], updatedAt: hoursAgo(0), stores: "r",
  });
  variants.forEach((v) => invVariants.push({
    id: v.id, productId: id, productTitle: sample.title, variantTitle: v.variantTitle, sku: v.sku,
    productStatus: "ACTIVE", tracked: true, available: 20, inventoryItemId: v.id.replace("ProductVariant", "InventoryItem"),
    levels: INV_LOCS.map((location, j) => ({ location, locationId: locId(j), available: j === 0 ? 20 : 0, onHand: j === 0 ? 20 : 0, committed: 0 })),
  }));
});
const LETTER: Record<string, string> = { retail: "r", b2b: "b", bulk: "u" }; // CAT_RAW stores letters
const splitPlans = new Map<string, { preview: SplitPreview; source: CatalogProduct }>();
const splitResults = new Map<string, SplitResult>();
let splitSequence = 1;
function splitPreview(args: Record<string, unknown>): SplitPreview {
  const storeId = String(args.storeId) as SplitPreview["storeId"];
  const source = catProducts.find((p) => p.id === args.productId && p.stores.includes(LETTER[storeId]));
  if (!source) throw new Error("Product not found in this store");
  const variants = sourceVariants.get(source.id);
  if (!variants) throw new Error("No source variants are available for this sample product");
  const preview: SplitPreview = {
    planId: `mock-split-${splitSequence++}`, storeId, productTitle: source.title,
    variants: variants.map((v) => ({ ...v })),
    locations: ["Warehouse", "Retail floor"], warnings: [
      "Browser preview: sample products only. Nothing is sent to Shopify.",
      ...(source.tags.includes("SKU guide sample") ? [] : ["Legacy design sample: existing SKUs are kept as-is; missing SKUs stay blank. For guide-format examples, open 41 Kings, Alien Grapevine, or The White CBG."]),
    ],
  };
  splitPlans.set(preview.planId, { preview, source });
  return preview;
}
function splitVariant(args: Record<string, unknown>): SplitResult {
  const plan = splitPlans.get(String(args.planId));
  if (!plan) throw new Error("Preview expired. Reopen Split variants to continue.");
  const v = plan.preview.variants.find((v) => v.id === args.variantId);
  if (!v) throw new Error("Variant is not part of this preview");
  const key = `${plan.preview.storeId}:${v.id}`;
  const previous = splitResults.get(key);
  if (previous) return { ...previous, existing: true };
  const productId = `gid://shopify/Product/${900000 + splitSequence++}`;
  catProducts.push({ ...plan.source, id: productId, title: v.title, handle: `flow-split-${v.id.split("/").pop()}`, status: "DRAFT",
    variantCount: 1, minPrice: usd(Number(v.price)), maxPrice: usd(Number(v.price)), totalInventory: 0, tracksInventory: true,
    options: [{ name: "Size", values: [v.variantTitle] }], updatedAt: new Date().toISOString(), stores: LETTER[plan.preview.storeId] });
  const variantId = `gid://shopify/ProductVariant/${900000 + splitSequence++}`;
  sourceVariants.set(productId, [{ ...v, id: variantId, title: `${v.title} — ${v.variantTitle}` }]);
  invVariants.push({ id: variantId, productId, productTitle: v.title, variantTitle: v.variantTitle,
    sku: v.sku, productStatus: "DRAFT", tracked: true, available: 0, inventoryItemId: variantId.replace("ProductVariant", "InventoryItem"),
    levels: plan.preview.locations.map((location, j) => ({ location, locationId: locId(j), available: 0, onHand: 0, committed: 0 })) });
  const result: SplitResult = { productId, title: v.title, existing: false, warnings: [], status: "DRAFT" };
  splitResults.set(key, result);
  return result;
}
const catalog = (): CatalogResult => ({
  products: catProducts.filter((p) => p.stores.includes(LETTER[active])).map(({ stores: _stores, ...p }) => p),
  truncated: false,
});

// Same ids as catalog(): index i → gid 70000+i, so cross-store matching by handle/title lines up with the active catalog.
const presence = (storeId: string): PresenceResult => ({
  products: catProducts.filter((p) => p.stores.includes(LETTER[storeId])).map(({ id, handle, title, status }) => ({ id, handle, title, status })),
  truncated: false,
});

// COA sample (the design's Lab rows): [file stem, batch, lab, producer, strain, type, thca, cbd, cbg, total, issued days ago, product title, posted via, terpenes]
// Expiry is issued + 365 days, so days-ago picks the state: < 335 valid · 335–365 expiring · > 365 expired.
type RawCoa = [string, string, string | null, string | null, string | null, string | null, number | null, number | null, number | null, number | null, number, string | null, "page" | "product" | "metaobject" | null, [string, number][]];
const COA_RAW: RawCoa[] = [
  ["Suver_Haze_FG-24-0918", "FG-24-0918", "Columbia Labs", "Flow Gardens", "Suver Haze", "Sativa", 20.4, 0.28, 0.61, 22.1, 3, "Suver Haze", null, []],
  ["Hawaiian_Haze_FG-24-0902", "FG-24-0902", "Columbia Labs", "Flow Gardens", "Hawaiian Haze", "Sativa", 18.1, 0.21, 0.48, 19.6, 9, "Hawaiian Haze", "page", [["Myrcene", 0.62], ["Caryophyllene", 0.31], ["Pinene", 0.18]]],
  ["Lifter_FG-24-0827", "FG-24-0827", "SC Labs", "Flow Gardens", "Lifter", "Hybrid", 19.6, 0.24, 0.55, 21.2, 15, "Lifter", "product", [["Myrcene", 0.71], ["Limonene", 0.22]]],
  ["Special_Sauce_FG-24-0821", "FG-24-0821", "SC Labs", "Flow Gardens", "Special Sauce", "Indica", 18.8, 0.26, 0.42, 20.3, 21, "Special Sauce", "metaobject", []],
  ["Sour_Space_Candy_FG-24-0815", "FG-24-0815", "Columbia Labs", "Flow Gardens", "Sour Space Candy", "Sativa", 18.4, 0.19, 0.5, 19.9, 27, "Sour Space Candy", "page", [["Terpinolene", 0.44], ["Ocimene", 0.29], ["Caryophyllene", 0.2]]],
  ["scan_0801", "FG-24-0801", null, null, null, null, null, null, null, null, 40, null, null, []],
  ["Red_Hotz_FG-24-0601", "FG-24-0601", "Columbia Labs", "RJR Services", "Red Hotz", "Hybrid", 21.3, 0.3, 0.7, 23.4, 100, "Pre-rolls · Hawaiian Haze", null, [["Limonene", 0.55], ["Linalool", 0.12]]],
  ["Cherry_Blossom_FG-24-0708", "FG-24-0708", "Badger Labs", "Flow Gardens", "Cherry Blossom", "Hybrid", 14.6, 0.17, 0.33, 15.8, 60, null, null, []],
  ["Elektra_FG-24-0722", "FG-24-0722", "Columbia Labs", "RJR Services", "Elektra", "Indica", 17.0, 0.22, 0.4, 18.3, 340, "Elektra", "page", []],
  ["Cherry_Wine_FG-24-0715", "FG-24-0715", "SC Labs", "RJR Services", "Cherry Wine", "Hybrid", 15.9, 0.29, 0.38, 17.4, 345, "Cherry Wine", null, []],
  ["Sour_Lifter_FG-23-1102", "FG-23-1102", "Badger Labs", "RJR Services", "Sour Lifter", "Hybrid", 18.0, 0.23, 0.46, 19.5, 400, "Sour Lifter", "product", []],
  ["Bubba_Kush_FG-23-0915", "FG-23-0915", "SC Labs", "Flow Gardens", "Bubba Kush", "Indica", 16.2, 0.2, 0.35, 17.6, 410, "Bubba Kush biomass", null, []],
];
// One real public COA render from the retail CDN so the detail pane's iframe has a PDF to show.
const COA_PDF = "https://cdn.shopify.com/s/files/1/0931/4012/4017/files/Red_Hotz_ab1f742c-7837-45ca-90dd-16e39bf5a8e4.pdf?v=1787958269";
const daysAgo = (d: number) => hoursAgo(d * 24).slice(0, 10);
const MOCK_MODEL = "anthropic/claude-haiku-4.5";
const POSTED_REASON: Record<string, string> = { page: "PDF URL found on /pages/coa", product: "linked product is published with a coa metafield", metaobject: "coa_record metaobject is active" };
const coaRow = (r: RawCoa, i: number): Coa => {
  const [stem, batch, lab, producer, strain, type, thca, cbd, cbg, total, ago, title, via, terps] = r;
  const product = title ? catProducts.find((p) => p.title === title) ?? null : null;
  const days = 365 - ago;
  const parsed = lab != null && i !== 7;
  const fileName = i === 5 ? `${stem}.pdf` : `${stem}_${String(i).padStart(8, "0")}-7837-45ca-90dd-16e39bf5a8e4.pdf`;
  return {
    id: `coa-${i}`, fileId: `gid://shopify/GenericFile/${80000 + i}`, fileName, fileUrl: COA_PDF, fileCreatedAt: hoursAgo(ago * 24),
    batch, lab, producer, displayTitle: strain, matchVia: product ? "filename" : null, parsed, qrPresent: i % 3 === 0 ? true : null,
    parsedAt: parsed ? hoursAgo(ago * 24 - 6) : null, parsedModel: parsed ? (i === 9 ? "anthropic/claude-3.5-haiku" : MOCK_MODEL) : null, parseStale: i === 9,
    productId: product?.id ?? null, productName: product?.title ?? strain ?? stem.replace(/_/g, " "), productHandle: product?.handle ?? null, productStatus: product?.status ?? null,
    productPublished: !!product && product.status === "ACTIVE", productOnlineStoreUrl: product ? `https://flowgardens.com/products/${product.handle}` : null,
    hasCoaRecord: via === "metaobject", coaRecordId: via === "metaobject" ? `gid://shopify/Metaobject/${90000 + i}` : null, coaRecordStatus: via === "metaobject" ? "ACTIVE" : null,
    postedStatus: via ? "posted" : "unposted", postedReason: via ? POSTED_REASON[via] : product ? "not on /pages/coa and the product has no coa metafield" : "no product linked",
    postedSource: via, onCoaPage: via === "page", strain, type, issued: daysAgo(ago), expires: daysAgo(ago - 365), daysToExpire: days,
    state: days < 0 ? "expired" : days < 30 ? "expiring" : "valid", thca, cbd, cbg, totalCannabinoids: total,
    terpenes: terps.map(([name, pct]) => ({ name, pct })), notes: i === 2 ? "THCa re-checked against the lab portal 2026-09-01." : null, edited: i === 2,
  };
};
// Mutable so save_coa_link / save_coa_fields persist across reloads in the preview; `orig` backs "Clear edits".
const coaOrig = new Map(COA_RAW.map((r, i) => [`gid://shopify/GenericFile/${80000 + i}`, coaRow(r, i)]));
const coaRows = new Map([...coaOrig].map(([k, c]) => [k, { ...c }]));
const coaList = (): CoaList => ({
  coas: [...coaRows.values()], count: coaRows.size, truncated: false,
  postedPage: { url: "https://flowgardens.com/pages/coa", urlsFound: 27, checkedAt: hoursAgo(0), error: null },
});
function saveCoaLink(a: Record<string, unknown>) {
  const c = coaRows.get(String(a.fileId));
  if (!c) throw new Error("COA not found");
  const productId = typeof a.productId === "string" ? a.productId : null;
  const product = catProducts.find((p) => p.id === productId) ?? null;
  Object.assign(c, { productId, productName: product?.title ?? String(a.productTitle ?? c.displayTitle ?? ""), productHandle: product?.handle ?? null, matchVia: productId ? "manual" : null });
  return null;
}
function saveCoaFields(a: Record<string, unknown>) {
  const id = String(a.fileId), c = coaRows.get(id), orig = coaOrig.get(id);
  if (!c || !orig) throw new Error("COA not found");
  if (a.clear) { Object.assign(c, orig, { productId: c.productId, productName: c.productName, productHandle: c.productHandle, matchVia: c.matchVia }); return null; }
  const fields = (a.fields ?? {}) as Partial<Coa>;
  Object.assign(c, fields, { edited: true });
  return fields;
}
// parse_coas: marks the rows parsed with plausible values; a "scan_" file fails so the toast's error path is exercised.
function parseCoas(a: Record<string, unknown>) {
  const model = String(a.model || MOCK_MODEL);
  const results = ((a.files ?? []) as { fileId: string }[]).map(({ fileId }) => {
    const c = coaRows.get(fileId);
    if (!c) return { fileId, ok: false, error: "COA not found" };
    if (c.fileName.includes("scan_")) return { fileId, ok: false, error: "OpenRouter 400: could not read PDF" };
    const patch: Partial<Coa> = {
      parsed: true, parsedAt: hoursAgo(0), parsedModel: model, parseStale: false, lab: c.lab ?? "Columbia Labs", producer: c.producer ?? "Flow Gardens",
      thca: c.thca ?? 17.8, cbd: c.cbd ?? 0.21, cbg: c.cbg ?? 0.44, totalCannabinoids: c.totalCannabinoids ?? 19.2,
    };
    Object.assign(c, patch); Object.assign(coaOrig.get(fileId)!, patch); // orig too, so "Clear edits" keeps the parse
    return { fileId, ok: true, error: null };
  });
  const failed = results.filter((r) => !r.ok);
  return { parsed: results.length - failed.length, failed: failed.length, skipped: 0, elapsedMs: 1200, errors: failed.map((r) => `${coaRows.get(r.fileId)?.fileName ?? r.fileId}: ${r.error}`), results };
}
const searchProducts = (q: string): ProductHit[] =>
  catProducts.filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 10).map(({ id, title, handle, status }) => ({ id, title, handle, status }));

// ---- Import wizard: upload registers a fresh unparsed, unlinked row (so parse_coas / list_coas find it); import / repost flip the posted flags.
const mockGid = (type: string) => `gid://shopify/${type}/9${Math.floor(Math.random() * 1e7)}`;
function uploadCoaPdf(a: Record<string, unknown>) {
  const filename = String(a.filename ?? "upload.pdf"), fileId = mockGid("GenericFile");
  const row = coaRow([filename.replace(/\.pdf$/i, ""), "", null, null, null, null, null, null, null, null, 0, null, null, []], coaRows.size);
  Object.assign(row, { id: `coa-${fileId}`, fileId, fileName: filename, batch: null, qrPresent: null, edited: false, notes: null, parseStale: false });
  coaRows.set(fileId, row); coaOrig.set(fileId, { ...row });
  return { ok: true, fileId, url: COA_PDF, fileStatus: "READY", filename };
}
function importCoa(a: Record<string, unknown>) {
  const req = a.req as ImportRequest, c = coaRows.get(req.fileId), f = req.fields;
  if (!c) throw new Error("COA not found in the Files library");
  const step = (step: ImportStep["step"], error: string | null = null, critical = false, detail: unknown = null): ImportStep => ({ step, ok: !error, critical, error, detail });
  const product = catProducts.find((p) => p.id === req.productId) ?? null;
  const steps = [step("terpenes"), step("metaobject", null, true)];
  if (req.productId) steps.push(step("productLink", null, false, { linked: req.productId, totalRecords: 1, flowerType: "Type 1 (THCa)", category: product?.productType ?? null }));
  if (req.post) steps.push(step("coaPage", req.fileUrl ? null : "no fileUrl yet — file may still be propagating"));
  steps.push(step("cacheFields"));
  const posted = req.post && !!req.fileUrl;
  Object.assign(c, {
    batch: f.batchId ?? c.batch, lab: f.lab ?? c.lab, producer: f.producer ?? c.producer, issued: f.issueDate ?? c.issued, expires: f.expiryDate ?? c.expires,
    thca: f.thcaPercent ?? c.thca, cbd: f.cbdPercent ?? c.cbd, cbg: f.cbgPercent ?? c.cbg, totalCannabinoids: f.totalCannabinoidsPercent ?? c.totalCannabinoids,
    terpenes: f.terpenes.map((t) => ({ name: t.name, pct: t.percent })), notes: f.notes ?? c.notes, qrPresent: f.qrPresent ?? c.qrPresent, displayTitle: req.pageName ?? c.displayTitle,
    productId: req.productId, productName: product?.title ?? req.productTitle ?? c.productName, productHandle: product?.handle ?? null, matchVia: req.productId ? "manual" : null,
    hasCoaRecord: true, coaRecordId: c.coaRecordId ?? mockGid("Metaobject"), coaRecordStatus: req.post ? "ACTIVE" : "DRAFT",
    postedStatus: req.post ? "posted" : "unposted", postedSource: posted ? "page" : req.post ? "metaobject" : null, onCoaPage: posted,
    postedReason: posted ? POSTED_REASON.page : req.post ? POSTED_REASON.metaobject : "coa_record is DRAFT — not visible to customers",
  });
  const handle = (f.batchId ?? "coa").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { ok: steps.every((s) => s.ok || !s.critical), steps, metaobject: { id: c.coaRecordId, handle }, unknownTerpenes: f.terpenes.map((t) => t.name).filter((n) => !TERPENE_LIST.includes(n)), posted };
}
function repostCoas(a: Record<string, unknown>) {
  const results = ((a.targets ?? []) as { fileId: string; name: string | null }[]).map(({ fileId, name }) => {
    const c = coaRows.get(fileId);
    if (c) Object.assign(c, { postedStatus: "posted", postedSource: "page", onCoaPage: true, postedReason: POSTED_REASON.page });
    return { fileId, ok: !!c, name, action: c ? "updated" : null, error: c ? null : "COA not found" };
  });
  return { posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// ---- Google mirror: configured whenever a key file is set; the mirror always "finds" the same Drive file and Sheet row.
const googleStatus = (cfg: GoogleConfig): GoogleStatus => cfg.keyFile
  ? { configured: true, serviceAccountEmail: "coa-importer@mock.iam.gserviceaccount.com", sheetReachable: true, sheetTitle: "Master COA Sheet", tabs: ["COAs", "Archive"], driveReachable: true, driveFolderName: "COAs", error: null }
  : { configured: false, serviceAccountEmail: null, sheetReachable: false, sheetTitle: null, tabs: [], driveReachable: false, driveFolderName: null, error: "no service-account key file" };
const googleMirror = (req: { fileUrl: string | null }): MirrorResult => ({
  drive: req.fileUrl ? { ok: true, skipped: null, webViewLink: "https://drive.google.com/file/d/mock/view", fileId: "mock", deduped: true, error: null }
    : { ok: false, skipped: "no fileUrl", webViewLink: null, fileId: null, deduped: false, error: null },
  sheet: { ok: true, skipped: null, action: "updated", rowNumber: 335, tab: "COAs", matchedFields: ["batch", "productName", "lab", "issued", "expires", "thca", "cbd", "cbg", "totalCannabinoids", "shopifyUrl", "posted", "importedAt"], chip: "chip", error: null },
});

const DELAY: Record<string, number> = { list_orders: 500, list_orders_page: 500, list_inventory: 400, get_fulfillment: 300, fulfill_order: 600, update_order_note_tags: 500, adjust_inventory: 500, list_products: 400, list_customers: 400, list_orders_since: 350, list_product_presence: 300, list_coas: 500, parse_coas: 1200, upload_coa_pdf: 800, import_coa: 600, repost_coas: 400, google_status: 500, google_mirror_coa: 700 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await wait(DELAY[cmd] ?? 180);
  if (cmd === "plugin:opener|open_url") { window.open(String(args.url), "_blank"); return null; }
  if (cmd === "plugin:opener|reveal_item_in_dir") return null;
  switch (cmd) {
    case "ping": return "Flow Command is running ✓ (browser mock)";
    case "list_stores": return STORES;
    case "get_active_store": return STORES.find((s) => s.id === active);
    case "set_active_store": active = String(args.storeId); return STORES.find((s) => s.id === active);
    case "get_shopify_credentials": return { clientId: "a1f3mockclientc9e2", clientSecret: "mock" };
    case "save_shopify_credentials": return "Credentials saved (browser mock — nothing stored)";
    case "fetch_shop_info": { const s = STORES.find((x) => x.id === (args.storeId ?? active))!; return { shopName: `Flow Gardens ${s.label}`, status: "Connected ✓", shopDomain: s.domain }; }
    case "list_orders": return ordersPage({ first: args.first ?? 50 }).orders;
    case "list_orders_page": return ordersPage(args);
    case "get_order": return detail(String(args.orderId));
    case "update_order_note_tags": return updateNoteTags(args);
    case "get_fulfillment": return fulfillmentInfo(String(args.orderId));
    case "fulfill_order": return fulfill(args);
    case "list_inventory": return inventory();
    case "adjust_inventory": return adjust(args);
    case "list_products": return catalog();
    case "prepare_variant_split": return splitPreview(args);
    case "split_product_variant": return splitVariant(args);
    case "release_variant_split": splitPlans.delete(String(args.planId)); return null;
    case "list_customers": return customers(args);
    case "list_product_presence": return presence(String(args.storeId));
    case "list_orders_since": return ordersSince(String(args.storeId), String(args.since));
    case "list_coas": return coaList();
    case "save_coa_link": return saveCoaLink(args);
    case "save_coa_fields": return saveCoaFields(args);
    case "search_products": return searchProducts(String(args.q ?? ""));
    case "export_coas_csv": return `/Users/chase/Downloads/${String(args.filename)}`; // nothing written in the preview
    case "get_openrouter_status": return { hasKey: true, keyHint: "…mock", defaultModel: MOCK_MODEL };
    case "save_openrouter_key": return args.key ? "OpenRouter key saved (browser mock — nothing stored)" : "OpenRouter key removed (browser mock)";
    case "seed_google_config_from_old_env": return { keyFile: "/Users/chase/Documents/Dev/Credentials/mock-service-account.json", sheetId: "1MOCKSHEET", sheetTab: null, folderId: "1MOCKFOLDER" };
    case "google_status": return googleStatus(args.cfg as GoogleConfig);
    case "google_mirror_coa": return googleMirror(args.req as { fileUrl: string | null });
    case "parse_coas": return parseCoas(args);
    case "upload_coa_pdf": return uploadCoaPdf(args);
    case "import_coa": return importCoa(args);
    case "repost_coas": return repostCoas(args);
    default: throw new Error(`devMock: unknown command ${cmd}`);
  }
}

// Catalog must not label this shim's sample catalog as live Shopify data.
(window as unknown as { __FLOW_COMMAND_BROWSER_PREVIEW__: boolean }).__FLOW_COMMAND_BROWSER_PREVIEW__ = true;
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (cb?: (r: unknown) => void) => { const id = Math.floor(Math.random() * 1e9); (window as unknown as Record<string, unknown>)[`_${id}`] = cb; return id; },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  plugins: { path: { sep: "/", delimiter: ":" } },
};
console.warn("[Flow Command] Browser preview: Tauri invoke is mocked with sample orders, inventory, catalog, customers, analytics and COAs. Run `npm run tauri dev` for live Shopify data.");

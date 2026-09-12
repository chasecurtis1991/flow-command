// Browser-preview shim: when `npm run dev` is opened in a plain browser (no Tauri runtime),
// answer Tauri `invoke` calls with the design's sample orders so the UI can be reviewed.
// Never loaded inside the real app — main.tsx only imports this when __TAURI_INTERNALS__ is absent.
import type { Order, OrderDetail } from "./shopify";

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
const orders: Order[] = RAW.map((o, i) => ({
  id: `gid://shopify/Order/${10000 + i}`, name: o[0], createdAt: hoursAgo(o[1]), displayFinancialStatus: o[4], displayFulfillmentStatus: o[5],
  totalPrice: usd(o[3]), customerName: o[2], customerEmail: o[7], closed: o[5] === "FULFILLED", cancelled: false,
}));
const detail = (id: string): OrderDetail => {
  const i = orders.findIndex((o) => o.id === id);
  const o = RAW[i];
  const subtotal = o[10].reduce((a, li) => a + li[2] * li[3], 0);
  return {
    ...orders[i], subtotalPrice: usd(subtotal), totalTax: usd(0), totalShipping: usd(Math.max(0, o[3] - subtotal)), note: o[11],
    shippingAddress: o[9], customerOrdersCount: o[8], channel: o[6],
    lineItems: o[10].map((li) => ({ title: li[0], sku: li[1], quantity: li[2], price: usd(li[3]) })),
  };
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await wait(cmd === "list_orders" ? 500 : 180);
  if (cmd === "plugin:opener|open_url") { window.open(String(args.url), "_blank"); return null; }
  switch (cmd) {
    case "ping": return "Flow Command is running ✓ (browser mock)";
    case "list_stores": return STORES;
    case "get_active_store": return STORES.find((s) => s.id === active);
    case "set_active_store": active = String(args.storeId); return STORES.find((s) => s.id === active);
    case "get_shopify_credentials": return { clientId: "a1f3mockclientc9e2", clientSecret: "mock" };
    case "save_shopify_credentials": return "Credentials saved (browser mock — nothing stored)";
    case "fetch_shop_info": { const s = STORES.find((x) => x.id === (args.storeId ?? active))!; return { shopName: `Flow Gardens ${s.label}`, status: "Connected ✓", shopDomain: s.domain }; }
    case "list_orders": return active === "retail" ? orders : orders.filter((o) => (active === "b2b" ? o.name.startsWith("#W") : o.name.startsWith("#B")));
    case "get_order": return detail(String(args.orderId));
    default: throw new Error(`devMock: unknown command ${cmd}`);
  }
}

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (cb?: (r: unknown) => void) => { const id = Math.floor(Math.random() * 1e9); (window as unknown as Record<string, unknown>)[`_${id}`] = cb; return id; },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  plugins: { path: { sep: "/", delimiter: ":" } },
};
console.warn("[Flow Command] Browser preview: Tauri invoke is mocked with sample orders. Run `npm run tauri dev` for live Shopify data.");

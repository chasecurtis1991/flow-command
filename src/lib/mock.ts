// Sample data ported verbatim from the Claude Design export for surfaces that have no backend yet
// (FGINV inventory, the drift chart, activity feed, the ⌘K customer stubs). Pages that render this
// show a "Sample data" pill. Replace each export with a Tauri command as backends land.
import { useSyncExternalStore } from "react";
import type { Kind } from "./shopify";

const T = { text: "#e6e8eb", sub: "#9aa0a8", mute: "#6b7280", green: "#3fb97a", amber: "#d9a441", red: "#e5615c" };

// ---- Home ----
export const activity = [
  { time: "9:41", dot: "green", text: "Order #R-10482 paid · Marisol Ortega · $128.00", store: "Retail" },
  { time: "9:12", dot: "amber", text: "Order #W-3391 partially fulfilled · Suver Haze backordered", store: "B2B" },
  { time: "8:55", dot: "green", text: "Order #R-10481 fulfilled · tracking sent", store: "Retail" },
  { time: "8:30", dot: "amber", text: "Drift detected: FG-SPS-3.5G · FGINV 138 vs Shopify 102", store: "FGINV" },
  { time: "8:02", dot: "mute", text: "COA FG-24-0918 imported · needs review before posting", store: "Lab" },
  { time: "7:45", dot: "green", text: "Token rotated for fg-craft-flower.myshopify.com", store: "Bulk" },
] as const;

// ---- Inventory · Shopify tab ----
const invRaw: [string, string, string, number, number, number, string][] = [
  ["Sour Space Candy", "7g", "FG-SSC-7G", 212, 18, 214, "Synced"], ["Sour Space Candy", "14g", "FG-SSC-14G", 96, 6, 102, "Synced"],
  ["Lifter", "7g", "FG-LFT-7G", 340, 24, 364, "Synced"], ["Lifter", "1 lb", "FG-LFT-1LB", 41, 0, 38, "Drift −3"],
  ["Hawaiian Haze", "14g", "FG-HH-14G", 58, 9, 67, "Synced"], ["Hawaiian Haze", "1 lb", "FG-HH-1LB", 12, 0, 12, "Synced"],
  ["Suver Haze", "14g", "FG-SVH-14G", 7, 3, 10, "Synced"], ["Suver Haze", "1 lb", "FG-SVH-1LB", 0, 0, 3, "Drift +3"],
  ["Elektra", "7g", "FG-ELK-7G", 154, 11, 165, "Synced"], ["Cherry Wine", "7g", "FG-CHW-7G", 5, 2, 7, "Synced"],
  ["Special Sauce", "3.5g", "FG-SPS-3.5G", 88, 14, 138, "Drift +36"], ["Bubba Kush", "biomass 10 lb", "FG-BBK-10LB", 22, 0, 22, "Pending push"],
  ["Cherry Blossom", "3.5g", "FG-CHB-3.5G", 63, 7, 70, "Synced"],
];
export const shopInv = invRaw.map((v) => {
  const avail = v[3] + v[4];
  const syncKind: Kind = v[6] === "Synced" ? "green" : v[6].startsWith("Drift") ? "amber" : "neutral";
  return { title: v[0], size: v[1], sku: v[2], wh: v[3], retail: v[4], avail, fginv: v[5], lowStock: avail <= 10, sync: v[6], syncKind };
});

// ---- Inventory · FGINV tab (lots are mutable in-memory so the Receive sheet can add one) ----
export interface Lot { lot: string; strain: string; received: string; onhand: string; drift: string; coa: "Posted" | "Pending" | "Failed parse" }
let lots: Lot[] = [
  { lot: "FG-24-0918", strain: "Suver Haze", received: "Sep 8, 2026", onhand: "48.0 lb", drift: "+3", coa: "Pending" },
  { lot: "FG-24-0902", strain: "Hawaiian Haze", received: "Sep 2, 2026", onhand: "36.4 lb", drift: "0", coa: "Posted" },
  { lot: "FG-24-0827", strain: "Lifter", received: "Aug 27, 2026", onhand: "52.1 lb", drift: "−3", coa: "Posted" },
  { lot: "FG-24-0821", strain: "Special Sauce", received: "Aug 21, 2026", onhand: "19.7 lb", drift: "+36", coa: "Posted" },
  { lot: "FG-24-0815", strain: "Sour Space Candy", received: "Aug 15, 2026", onhand: "21.0 lb", drift: "0", coa: "Posted" },
  { lot: "FG-24-0801", strain: "Bubba Kush biomass", received: "Aug 1, 2026", onhand: "7.0 lb", drift: "0", coa: "Failed parse" },
];
const lotSubs = new Set<() => void>();
export const useLots = () => useSyncExternalStore((fn) => { lotSubs.add(fn); return () => { lotSubs.delete(fn); }; }, () => lots);
// ponytail: in-memory only; becomes a Tauri command when FGINV has a backend.
export function addLot(l: Lot) { lots = [l, ...lots]; lotSubs.forEach((fn) => fn()); }
export const lotsSummary = () => `${lots.length} lots · ${lots.reduce((a, l) => a + parseFloat(l.onhand), 0).toFixed(1)} lb on hand`;
export const driftColor = (d: string) => (d === "0" ? T.mute : T.amber);
export const coaColor = (c: Lot["coa"]) => (c === "Posted" ? T.green : c === "Pending" ? T.amber : T.red);

// ---- Customers ----
const customerRaw: [string, string, string, string, number, number, string][] = [
  ["Cascade Botanicals LLC", "orders@cascadebotanicals.com", "Cascade Botanicals", "B2B / Wholesale", 31, 96420, "Today"],
  ["Marisol Ortega", "marisol.o@gmail.com", "—", "Retail", 6, 612, "Today"],
  ["Northwind Extracts", "purchasing@northwind-extracts.com", "Northwind Extracts", "Bulk / Craft", 9, 88900, "Yesterday"],
  ["Highline Wellness", "po@highlinewellness.co", "Highline Wellness", "B2B / Wholesale", 22, 54200, "Sep 9"],
  ["Green River Apothecary", "buyer@greenriverapothecary.com", "Green River Apothecary", "B2B / Wholesale", 18, 38760, "Yesterday"],
  ["Priya Natarajan", "priya.n@outlook.com", "—", "Retail", 11, 1044, "Yesterday"],
  ["Pacific Hemp Co-op", "ops@pacifichempcoop.org", "Pacific Hemp Co-op", "Bulk / Craft", 5, 31000, "Sep 9"],
  ["Aisha Bello", "aisha.bello@yahoo.com", "—", "Retail", 7, 1290, "Sep 8"],
];
export const customers = customerRaw.map((c) => ({
  name: c[0], email: c[1], company: c[2], store: c[3], orders: c[4], ltv: c[5], last: c[6],
  initials: c[0].split(" ").slice(0, 2).map((w) => w[0]).join(""),
}));

// ---- Analytics (only the FGINV drift chart is still sample data; orders come from Shopify) ----
export const driftVals = [4, 6, 3, 8, 12, 9, 5, 7, 14, 18, 22, 30, 39, 42];

// ---- Design system page ----
export const tokens = [
  ["bg/app", "linear-gradient(180deg,#0c0e12,#090a0e)"], ["surface/glass", "rgba(255,255,255,0.045)"], ["surface/control", "rgba(255,255,255,0.035)"],
  ["surface/raised", "rgba(255,255,255,0.07)"], ["surface/selected", "rgba(255,255,255,0.12)"], ["border/hairline", "rgba(255,255,255,0.07)"],
  ["text/primary", "#e6e8eb"], ["text/secondary", "#9aa0a8"], ["text/tertiary", "#6b7280"], ["accent/blue", "#4c8dff"], ["accent/green", "#3fb97a"],
  ["status/ok", "#3fb97a"], ["status/pending", "#d9a441"], ["status/risk", "#e5615c"], ["store/retail", "#4c8dff"], ["store/b2b", "#b58cf5"],
].map((t) => ({ name: t[0], value: t[1] }));
export const typeScale = [
  ["display · 28/600", "28px", 600, "-0.02em", "KPI numerals 1,284"], ["title · 22/600", "22px", 600, "-0.01em", "Good morning, Chase"],
  ["heading · 17/600", "17px", 600, "0", "Order #R-10482"], ["body-strong · 14/600", "14px", 600, "0", "Section title"],
  ["body · 13/400", "13px", 400, "0", "Table cells, controls, prose"], ["caption · 12/400", "12px", 400, "0", "Metadata, timestamps"],
  ["label · 11/600", "11px", 600, "0.05em", "GROUP HEADERS"], ["mono · 12/400", "12px", 400, "0", "FG-SSC-7G · 3wvfyr-1i.myshopify.com"],
].map((t) => ({ token: t[0] as string, size: t[1] as string, weight: t[2] as number, ls: t[3] as string, sample: t[4] as string }));
export const spacing = [["s-1", 4, "pill inset"], ["s-2", 8, "control gap"], ["s-3", 12, "card gap"], ["s-4", 16, "card padding"], ["s-5", 20, "section gap"], ["s-6", 24, "page padding"], ["s-7", 32, "row height"]]
  .map((x) => ({ token: `${x[0]} · ${x[1]}`, px: `${(x[1] as number) * 4}px`, use: x[2] as string }));
export const handoff = [
  { title: "Window (Tauri 2)", body: "titleBarStyle: Overlay, hiddenTitle: true, transparent titlebar. Default 1400×900, min 1024×768. Traffic lights sit inside the 224px sidebar at y=20. The whole 52px top strip is data-tauri-drag-region except interactive controls. Vibrancy off — solid #121417 sidebar." },
  { title: "Layout grid", body: "Sidebar 224px fixed (collapses to 56px below 1100px, later). Top bar 52px. Content padding 24/28. Orders detail panel 420px fixed; below 1200px it becomes a slide-over. Base unit 4px; controls 30px, top-bar controls 32px." },
  { title: "Rows & density", body: "Compact 32px rows (default) / comfortable 40px, user setting. Header row 34px, sticky. Catalog and COA rows 44–46px because they carry two text lines. Virtualize any list over 200 rows (orders, inventory)." },
  { title: "Native vs in-app", body: "Native: window chrome, traffic lights, menu bar (File / Stores / View), Keychain, system notifications, file open/drop for COA PDFs, ⌘, for Settings. In-app: sidebar, store switcher, ⌘K palette, toasts, sheets. Never a native NSAlert for validation." },
  { title: "Keyboard", body: "⌘K palette · ⌘1/2/3 switch store · ⌘R refresh · ⌘⇧R receive · ⌘F focus search on any table · ↑↓ move row selection, ↵ opens detail, esc clears. Focus rings 2px accent at 40% on all interactive elements." },
  { title: "Motion", body: "One spring curve everywhere: cubic-bezier(.2,.8,.2,1), 180–380ms. Screens enter with a 10px rise + 0.8% scale; lists stagger 20–60ms per row (cap 12–14 rows, never on virtualized scroll). Dialogs/toasts overshoot slightly (cubic-bezier(.2,.9,.25,1.15)). Buttons scale to 0.97 on press. Honor prefers-reduced-motion by dropping transforms and keeping opacity fades." },
  { title: "Data & states", body: "Every table implements loading (spinner + label), empty (title + reason + one action) and error (cause, Retry, Open settings). Shopify tab is read-only and labelled as a mirror; FGINV is the write surface. Money and quantities: font-variant-numeric tabular-nums, right-aligned." },
];

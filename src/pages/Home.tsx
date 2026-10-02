import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STORES, type Order, type StoreActivity, type StoreId, adminUrl, fetchShopInfo, isOpenFulfillment, loadActivity, loadInventory, loadOrders, lowStock, money, moneyNum, storeById, useInventory, useOrders } from "../lib/shopify";
import { Pill, Status } from "../components/ui";

type Tone = "green" | "amber" | "red" | "mute";
interface Health { kind: Tone; text: string }
const COLOR: Record<Tone, string> = { green: "var(--green)", amber: "var(--amber)", red: "var(--red)", mute: "var(--mute)" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHECKING: Health = { kind: "mute", text: "Checking…" };
const SHORTCUTS: [string, string][] = [["Low stock", "/inventory?low=1"], ["Unposted COAs", "/lab?posted=unposted"], ["Draft products", "/catalog?status=draft"], ["Store settings", "/settings"]];

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
// Feed row colour by Shopify event action.
const actTone = (a: string | null): Tone =>
  !a ? "mute" : /failure|cancelled/.test(a) ? "red" : /refund|restock|destroy|unpublished/.test(a) ? "amber" : /confirmed|fulfillment_success|published/.test(a) ? "green" : "mute";
const actTime = (iso: string) => {
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat("en-US", today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }).format(d);
};
const age = (o: Order) => Date.now() - new Date(o.createdAt).getTime();

export function Home() {
  const navigate = useNavigate();
  const { store, storeReady, openSheet } = useApp();
  const cache = useOrders();
  const [feed, setFeed] = useState<{ items: StoreActivity[]; failed: StoreId[] } | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const refreshFeed = () => { setFeedError(null); loadActivity().then(setFeed).catch((e) => setFeedError(String(e))); };
  useEffect(refreshFeed, []);
  // Orders of the active store open in-app; anything else opens in Shopify admin.
  const openActivity = (a: StoreActivity) => {
    if (!a.subjectId) return;
    if (a.subjectType === "ORDER" && a.store === store) navigate(`/orders?sel=${encodeURIComponent(a.subjectId)}`);
    else void openUrl(adminUrl(a.store, a.subjectId));
  };
  const [health, setHealth] = useState<Record<StoreId, Health>>({ retail: CHECKING, b2b: CHECKING, bulk: CHECKING });

  useEffect(() => { if (storeReady && cache.status === "idle") void loadOrders(store); }, [storeReady, store, cache.status]);
  // Same cache the Inventory page uses, so visiting either loads it once per store.
  const inv = useInventory();
  useEffect(() => {
    if (storeReady && (inv.status === "idle" || (inv.store !== store && inv.status !== "loading"))) void loadInventory(store);
  }, [storeReady, store, inv.status, inv.store]);

  // Connection health: ping every store's Admin API once, timing each call.
  useEffect(() => {
    let alive = true;
    STORES.forEach((s) => {
      const t0 = performance.now();
      fetchShopInfo(s.id)
        .then(() => alive && setHealth((h) => ({ ...h, [s.id]: { kind: "green", text: `Healthy · ${Math.round(performance.now() - t0)} ms` } })))
        .catch((e) => alive && setHealth((h) => ({ ...h, [s.id]: String(e).includes("429") ? { kind: "amber", text: "Rate-limited" } : { kind: "red", text: "Unreachable" } })));
    });
    return () => { alive = false; };
  }, []);

  // KPIs derived from the (up to 50 most recent) cached orders for the active store.
  const data = cache.status === "data";
  const last24 = cache.orders.filter((o) => age(o) <= DAY);
  const prev24 = cache.orders.filter((o) => age(o) > DAY && age(o) <= 2 * DAY);
  const pct = prev24.length ? Math.round(((last24.length - prev24.length) / prev24.length) * 100) : null;
  const currency = cache.orders[0]?.totalPrice.split(" ")[1] ?? "USD";
  const open = cache.orders.filter(isOpenFulfillment);
  const overdue = open.filter((o) => age(o) > 2 * DAY);
  const oldest = open.reduce<Order | null>((a, o) => (!a || age(o) > age(a) ? o : a), null);
  // Same rule as Inventory's "Low stock only" (tracked, ≤ 10 available), lowest first.
  const invReady = inv.status === "data" && inv.store === store;
  const low = invReady ? inv.data!.variants.filter(lowStock).sort((a, b) => a.available - b.available) : [];

  const kpis: { label: string; value: string | number; delta: string; tone: Tone; sub: string; href?: string }[] = [
    {
      label: "Orders · 24h", value: data ? last24.length : "—",
      delta: !data || pct == null ? "—" : `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`, tone: !data || pct == null ? "mute" : pct >= 0 ? "green" : "red",
      sub: data ? `${money(`${last24.reduce((a, o) => a + moneyNum(o.totalPrice), 0).toFixed(2)} ${currency}`)} · ${storeById(store).label}` : "Loading…",
    },
    {
      label: "Open fulfillments", value: data ? open.length : "—",
      delta: data ? `${overdue.length} overdue` : "—", tone: overdue.length ? "amber" : "mute",
      sub: oldest ? `Oldest: ${oldest.name} · ${Math.floor(age(oldest) / DAY)} days` : data ? "Nothing waiting" : "Loading…",
    },
    {
      label: "Low stock", value: invReady ? low.length : "—", delta: invReady ? "≤ 10 avail" : "—", tone: low.length ? "amber" : "mute", href: "/inventory?low=1",
      sub: inv.status === "error" && inv.store === store ? "Inventory unavailable" : !invReady ? "Loading…"
        : low[0] ? `${low[0].productTitle}${low[0].variantTitle ? ` ${low[0].variantTitle}` : ""} at ${low[0].available}` : "All variants stocked",
    },
    { label: "Alerts", value: 3, delta: "1 new", tone: "red", sub: "COA unposted · drift · wire pending" },
  ];

  const conn = cache.status === "data" ? <span style={{ color: "var(--green)" }}>Shopify connected</span>
    : cache.status === "error" ? <span style={{ color: "var(--red)" }}>Shopify unreachable</span>
    : <span className="mute">Connecting…</span>;

  return (
    <section className="screen screen-pad">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="h-title">{greeting()}, Chase</div>
          <div className="sub" style={{ marginTop: 2 }}>
            {new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" }).format(new Date())} · Active store:{" "}
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{storeById(store).label}</span> · {conn}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary btn-lg" onClick={() => navigate("/orders")}>View orders</button>
          <button className="btn btn-secondary btn-lg" onClick={openSheet}>Receive inventory</button>
        </div>
      </div>

      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div key={k.label} className={`card kpi${k.href ? " kpi-link" : ""}`} style={{ animationDelay: `${i * 60}ms` }}
            {...(k.href ? { role: "link", tabIndex: 0, onClick: () => navigate(k.href!), onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && navigate(k.href!) } : {})}>
            <div className="kpi-top"><span>{k.label}</span><span className="num" style={{ color: COLOR[k.tone] }}>{k.delta}</span></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="home-grid">
        <div className="card clip">
          <div className="card-head">
            <span>Recent activity</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {feed && <Pill kind="green" sm>Live</Pill>}
              <button className="btn btn-control btn-sm" onClick={refreshFeed}>Refresh</button>
            </span>
          </div>
          {feedError ? <div className="mute" style={{ padding: 16, fontSize: 12.5 }}>Couldn’t load activity · {feedError.slice(0, 140)}</div>
            : !feed ? <div className="mute" style={{ padding: 16, fontSize: 12.5 }}>Loading activity from Shopify…</div>
            : feed.items.length === 0 ? <div className="mute" style={{ padding: 16, fontSize: 12.5 }}>No recent activity.</div>
            : feed.items.slice(0, 12).map((a, i) => (
              <div key={`${a.store}-${a.id}`} className={`act-row${a.subjectId ? " act-link" : ""}`} style={{ animationDelay: `${i * 40}ms` }}
                title={new Date(a.createdAt).toLocaleString()} {...(a.subjectId ? { role: "button", tabIndex: 0, onClick: () => openActivity(a), onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && openActivity(a) } : {})}>
                <span className="mute num" style={{ fontSize: 12 }}>{actTime(a.createdAt)}</span>
                <span className={`dot d7 ${actTone(a.action)}`} />
                <span className="ellip">{a.message}</span>
                <span className="tag">{storeById(a.store).short}</span>
              </div>
            ))}
          {feed && feed.failed.length > 0 && <div className="mute" style={{ padding: "8px 16px", fontSize: 11.5 }}>Couldn’t reach {feed.failed.map((id) => storeById(id).short).join(", ")}.</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card card-pad">
            <div className="strong" style={{ marginBottom: 10 }}>Connection health</div>
            {STORES.map((s) => (
              <div key={s.id} className="health-row">
                <span className="soft">{s.short} · Admin API</span>
                <Status kind={health[s.id].kind}>{health[s.id].text}</Status>
              </div>
            ))}
            <div className="health-row"><span className="soft">FGINV database</span><Status kind="mute">Not connected</Status></div>
          </div>
          <div className="card card-pad">
            <div className="strong" style={{ marginBottom: 8 }}>Shortcuts</div>
            <div className="shortcut-grid">
              {SHORTCUTS.map(([label, path]) => <button key={path} className="btn btn-control" onClick={() => navigate(path)}>{label}</button>)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

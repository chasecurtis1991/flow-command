import { useEffect, useState } from "react";
import { prefs } from "../lib/app";
import { ANALYTICS_RANGES, STORES, type AnalyticsEntry, type StoreId, loadAnalytics, money, ordersByDay, useAnalytics } from "../lib/shopify";
import { driftVals } from "../lib/mock";
import { ErrorState, LoadingState, Pill, SampleData, Status } from "../components/ui";

const maxDrift = Math.max(...driftVals);
const RANGE = ANALYTICS_RANGES.map(String);
const nf = new Intl.NumberFormat("en-US");
const LOADING: AnalyticsEntry = { status: "loading", data: null, error: null };

export function Analytics() {
  const an = useAnalytics();
  const [days, setDays] = useState(() => Number(prefs.get("analytics.days", "14", RANGE)));
  useEffect(() => { prefs.set("analytics.days", String(days)); }, [days]);
  useEffect(() => {
    if (an.days !== days || STORES.some((s) => an.stores[s.id].status === "idle")) void loadAnalytics(days);
  }, [days, an]);

  // Until the cache catches up with a new range, treat every store as loading (avoids one frame of mismatched bars).
  const entry = (id: StoreId): AnalyticsEntry => (an.days === days ? an.stores[id] : LOADING);
  const loaded = STORES.filter((s) => entry(s.id).data);
  const allError = STORES.every((s) => entry(s.id).status === "error");
  // Orders per day across the stores that answered, summed by Shopify's own day buckets.
  const reports = loaded.map((s) => entry(s.id).data!);
  const combined = ordersByDay(reports);
  const max = Math.max(1, ...combined.map((b) => b.orders));
  const avg = Math.round(combined.reduce((a, b) => a + b.orders, 0) / Math.max(1, combined.length));
  // Top products across stores (same title = same product; each store's report is its own top 5).
  const top = [...reports.flatMap((r) => r.topProducts).reduce((m, p) => {
    const t = m.get(p.title) ?? { title: p.title, netSales: 0, units: 0 };
    return m.set(p.title, { ...t, netSales: t.netSales + p.netSales, units: t.units < 0 || p.units < 0 ? -1 : t.units + p.units }); // −1: this API version has no units column
  }, new Map<string, { title: string; netSales: number; units: number }>()).values()].sort((a, b) => b.netSales - a.netSales).slice(0, 5);
  const topMax = Math.max(1, ...top.map((p) => p.netSales));
  const cur = reports[0]?.currency ?? "USD";
  const retry = () => void loadAnalytics(days, true);

  return (
    <section className="screen screen-pad" style={{ padding: "20px 24px", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="sub" style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
          Shopify reports across all stores · last {days} days {loaded.length > 0 && <Pill kind="green" sm>Live</Pill>}
        </div>
        <div className="seg-sm" role="radiogroup" aria-label="Range">
          {ANALYTICS_RANGES.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={days === n} className={`seg-sm-item${days === n ? " active" : ""}`} onClick={() => setDays(n)}>{n} days</button>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span className="strong">Orders per day</span>
            {loaded.length > 0 && <span className="num sub" style={{ fontSize: 12 }}>avg {nf.format(avg)}/day</span>}
          </div>
          {allError ? (
            <ErrorState title="Couldn’t reach Shopify" why={(entry("retail").error ?? "Unknown error").slice(0, 160)} actions={<button className="btn btn-primary" onClick={retry}>Retry</button>} />
          ) : loaded.length === 0 ? <LoadingState label="Loading Shopify reports…" /> : (
            <div className="bars">
              {combined.map((b, i) => (
                <div key={b.key} className="bar" title={`${b.label}: ${nf.format(b.orders)} orders`} style={{ height: `${Math.round((b.orders / max) * 100)}%`, background: i === combined.length - 1 ? "var(--accent)" : "rgba(255,255,255,0.14)", animationDelay: `${i * 30}ms` }} />
              ))}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span className="strong" style={{ display: "flex", alignItems: "center", gap: 8 }}>Inventory drift (FGINV vs Shopify) <SampleData /></span>
            <span className="num sub" style={{ fontSize: 12 }}>{driftVals[driftVals.length - 1]} units open</span>
          </div>
          <div className="bars">
            {driftVals.map((v, i) => (
              <div key={i} className="bar" style={{ height: `${Math.round((v / maxDrift) * 100)}%`, background: v > 20 ? "rgba(217,164,65,0.7)" : "rgba(255,255,255,0.14)", animationDelay: `${i * 30}ms` }} />
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
        {STORES.map((s) => {
          const e = entry(s.id);
          const t = e.data?.totals;
          const v = (n: number) => money(`${n.toFixed(2)} ${e.data?.currency ?? "USD"}`);
          return (
            <div key={s.id} className="card card-pad">
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 600, marginBottom: 10 }}><span className={`dot ${s.id}`} />{s.label}</div>
              {e.status === "error" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Status kind="red">Unreachable</Status>
                    <div className="spacer" />
                    <button className="btn btn-control btn-sm" onClick={retry}>Retry</button>
                  </div>
                  <div className="mute" style={{ fontSize: 11.5 }}>{(e.error ?? "").slice(0, 140)}</div>
                </div>
              ) : (
                <div className="stat-grid">
                  <span>Orders</span><span className="v">{t ? nf.format(t.orders) : "…"}</span>
                  <span>Gross sales</span><span className="v">{t ? v(t.grossSales) : "…"}</span>
                  <span>Discounts</span><span className="v">{t ? v(t.discounts) : "…"}</span>
                  <span>Returns</span><span className="v">{t ? v(t.returns) : "…"}</span>
                  <span>Net sales</span><span className="v strong">{t ? v(t.netSales) : "…"}</span>
                  <span>Total sales</span><span className="v">{t ? v(t.totalSales) : "…"}</span>
                  <span>Avg order</span><span className="v">{t ? (t.orders ? v(t.averageOrderValue) : "—") : "…"}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span className="strong">Top products · net sales</span>
          <span className="sub" style={{ fontSize: 12 }}>all stores · last {days} days</span>
        </div>
        {loaded.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>{allError ? "—" : "Loading…"}</div>
          : top.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>No sales in this range.</div>
          : <div className="top-products">{top.map((p) => (
            <div key={p.title} className="top-product">
              <span className="ellip">{p.title}</span>
              <div className="top-bar"><div style={{ width: `${Math.round((p.netSales / topMax) * 100)}%` }} /></div>
              <span className="num r">{money(`${p.netSales.toFixed(2)} ${cur}`)}</span>
              <span className="num r mute">{p.units < 0 ? "—" : `${nf.format(p.units)} sold`}</span>
            </div>
          ))}</div>}
      </div>
    </section>
  );
}

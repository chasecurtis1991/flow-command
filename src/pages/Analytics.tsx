import { useEffect, useState } from "react";
import { prefs } from "../lib/app";
import { ANALYTICS_RANGES, STORES, type AnalyticsEntry, type StoreId, bucketByDay, loadAnalytics, money, useAnalytics } from "../lib/shopify";
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
  // Orders per day across the stores that answered: one concatenated bucket pass is the same as summing per store by index.
  const combined = bucketByDay(loaded.flatMap((s) => entry(s.id).data!.orders), days);
  const max = Math.max(1, ...combined.map((b) => b.orders));
  const avg = Math.round(combined.reduce((a, b) => a + b.orders, 0) / days);
  const retry = () => void loadAnalytics(days, true);

  return (
    <section className="screen screen-pad" style={{ padding: "20px 24px", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="sub" style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
          Ops metrics across all stores · last {days} days {loaded.length > 0 && <Pill kind="green" sm>Live</Pill>}
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
          ) : loaded.length === 0 ? <LoadingState label="Loading orders…" /> : (
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
          const b = e.data ? bucketByDay(e.data.orders, days) : null;
          const orders = b?.reduce((a, x) => a + x.orders, 0) ?? 0;
          const revenue = b?.reduce((a, x) => a + x.revenue, 0) ?? 0;
          const cur = e.data?.orders[0]?.total.split(/\s+/)[1] ?? "USD";
          const v = (n: number) => money(`${n.toFixed(2)} ${cur}`);
          return (
            <div key={s.id} className="card card-pad">
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 600, marginBottom: 10 }}><span className={`dot ${s.id}`} />{s.label}</div>
              {e.status === "error" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Status kind="red">Unreachable</Status>
                  <div className="spacer" />
                  <button className="btn btn-control btn-sm" onClick={retry}>Retry</button>
                </div>
              ) : (
                <div className="stat-grid">
                  <span>Orders</span><span className="v">{b ? nf.format(orders) : "…"}</span>
                  <span>Revenue</span><span className="v">{b ? v(revenue) : "…"}</span>
                  <span>Avg order</span><span className="v">{b ? (orders ? v(revenue / orders) : "—") : "…"}</span>
                </div>
              )}
              {e.data?.truncated && <div className="mute" style={{ fontSize: 11.5, marginTop: 8 }}>first 2,000 orders</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

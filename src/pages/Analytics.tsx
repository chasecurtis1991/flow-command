import { barVals, driftVals, storeStats } from "../lib/mock";
import { money } from "../lib/shopify";
import { SampleData } from "../components/ui";

const max = Math.max(...barVals);
const maxDrift = Math.max(...driftVals);
const avg = Math.round(barVals.reduce((a, b) => a + b, 0) / barVals.length);

export function Analytics() {
  return (
    <section className="screen screen-pad" style={{ padding: "20px 24px", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="sub" style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>Ops metrics across all stores · last 14 days <SampleData /></div>
        <button className="btn btn-control btn-sm">14 days</button>
      </div>
      <div className="grid-2">
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span className="strong">Orders per day</span>
            <span className="num sub" style={{ fontSize: 12 }}>avg {avg} · <span style={{ color: "var(--green)" }}>+8%</span></span>
          </div>
          <div className="bars">
            {barVals.map((v, i) => (
              <div key={i} className="bar" style={{ height: `${Math.round((v / max) * 100)}%`, background: i === barVals.length - 1 ? "var(--accent)" : "rgba(255,255,255,0.14)", animationDelay: `${i * 30}ms` }} />
            ))}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <span className="strong">Inventory drift (FGINV vs Shopify)</span>
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
        {storeStats.map((ss) => (
          <div key={ss.id} className="card card-pad">
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 600, marginBottom: 10 }}><span className={`dot ${ss.id}`} />{ss.label}</div>
            <div className="stat-grid">
              <span>Orders</span><span className="v">{ss.orders}</span>
              <span>Revenue</span><span className="v">{money(`${ss.rev} USD`)}</span>
              <span>Avg order</span><span className="v">{money(`${ss.aov} USD`)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

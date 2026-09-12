import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApp } from "../lib/app";
import { coaColor, driftColor, lotsSummary, shopInv, useLots } from "../lib/mock";
import { EmptyState, Pill, SampleData } from "../components/ui";

const drifted = shopInv.filter((v) => v.sync.startsWith("Drift"));
const driftUnits = drifted.reduce((a, v) => a + Math.abs(parseInt(v.sync.replace(/[^\d+\-−]/g, "").replace("−", "-"), 10) || 0), 0);

export function Inventory() {
  const { toast, openSheet } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "fginv" ? "fginv" : "shopify";
  const setTab = (t: "shopify" | "fginv") => setParams(t === "fginv" ? { tab: "fginv" } : {}, { replace: true });
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const lots = useLots();
  const s = q.trim().toLowerCase();
  const rows = shopInv.filter((v) => (!lowOnly || v.lowStock) && (!s || `${v.title} ${v.size} ${v.sku}`.toLowerCase().includes(s)));

  return (
    <section className="screen screen-full">
      <div className="tabs">
        <button className={`tab${tab === "shopify" ? " active" : ""}`} onClick={() => setTab("shopify")}>Shopify</button>
        <button className={`tab${tab === "fginv" ? " active" : ""}`} onClick={() => setTab("fginv")}>FGINV <span className="tag-caps">SOURCE OF TRUTH</span></button>
        <div className="spacer" />
        {tab === "shopify" && <span className="mute" style={{ fontSize: 12 }}>Read-only mirror of Shopify · sample data</span>}
        <SampleData />
      </div>

      {tab === "shopify" ? (
        <>
          <div className="toolbar">
            <input className="input" style={{ width: 280 }} placeholder="Search variants or SKUs" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-control">Location <span className="muted">All</span></button>
            <button className={`btn btn-control${lowOnly ? " on" : ""}`} onClick={() => setLowOnly((v) => !v)}>Low stock only</button>
            <div className="spacer" />
            <button className="btn btn-control" onClick={() => toast("Shopify sync isn’t wired yet — sample data")}>Sync now</button>
          </div>
          <div className="thead cols-inv">
            <span>Variant</span><span>SKU</span><span className="r">Warehouse</span><span className="r">Retail floor</span><span className="r">Available</span><span className="r">FGINV</span><span>Sync</span>
          </div>
          {rows.length === 0 ? <EmptyState title="No variants match" why="Try another SKU or clear Low stock only." /> : (
            <div className="scroll">
              {rows.map((v) => (
                <div key={v.sku} className="row cols-inv">
                  <span className="ellip">{v.title} <span className="mute">· {v.size}</span></span>
                  <span className="sub mono" style={{ fontSize: 12 }}>{v.sku}</span>
                  <span className="r">{v.wh}</span>
                  <span className="r">{v.retail}</span>
                  <span className="r" style={{ fontWeight: 500, color: v.lowStock ? "var(--amber)" : "var(--text)" }}>{v.avail}</span>
                  <span className="r sub">{v.fginv}</span>
                  <span><Pill kind={v.syncKind}>{v.sync}</Pill></span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, overflow: "auto" }}>
          <div className="banner-warn">
            <span className="dot d8 amber" style={{ marginTop: 6 }} />
            <div style={{ flex: 1 }}>
              <div className="title">Drift detected on {drifted.length} variants</div>
              <div className="body">FGINV and Shopify disagree by {driftUnits} units total. Reconcile before tonight’s sync pushes FGINV counts to Shopify.</div>
            </div>
            <button className="btn btn-warn" style={{ alignSelf: "center" }} onClick={() => toast("Reconcile ships in a later release")}>Reconcile</button>
          </div>
          <div className="action-grid">
            <button className="action-card" onClick={openSheet}>
              <span className="name">Receive</span><span className="desc">Log an incoming lot from a grower or processor with weight, moisture and COA link.</span><span className="cta">New receipt →</span>
            </button>
            <button className="action-card" onClick={() => toast("Transfers ship in a later release")}>
              <span className="name">Transfer</span><span className="desc">Move quantity between Warehouse, Retail floor and Quarantine.</span><span className="cta">New transfer →</span>
            </button>
            <button className="action-card" onClick={() => toast("Adjustments ship in a later release")}>
              <span className="name">Adjust</span><span className="desc">Cycle count corrections, shrink, samples and destroyed product — with a reason code.</span><span className="cta">New adjustment →</span>
            </button>
          </div>
          <div className="card clip">
            <div className="card-head"><span>Open lots</span><span className="meta">{lotsSummary()}</span></div>
            <div className="thead h32 cols-lots"><span>Lot</span><span>Strain</span><span>Received</span><span className="r">On hand</span><span className="r">Drift</span><span>COA</span></div>
            {lots.map((l, i) => (
              <div key={`${l.lot}-${i}`} className="row cols-lots">
                <span className="mono soft" style={{ fontSize: 12 }}>{l.lot}</span>
                <span>{l.strain}</span>
                <span className="sub">{l.received}</span>
                <span className="r">{l.onhand}</span>
                <span className="r" style={{ color: driftColor(l.drift) }}>{l.drift}</span>
                <span style={{ color: coaColor(l.coa), fontSize: 12 }}>{l.coa}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

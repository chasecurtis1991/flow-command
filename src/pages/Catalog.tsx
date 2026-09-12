import { useState } from "react";
import { useApp } from "../lib/app";
import { products, storeChipLabel } from "../lib/mock";
import { money } from "../lib/shopify";
import { EmptyState, Pill, SampleData } from "../components/ui";

const price = (n: number) => money(`${n} USD`);

export function Catalog() {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [view, setView] = useState<"table" | "grid">("table");
  const s = q.trim().toLowerCase();
  const rows = products.filter((p) => !s || `${p.name} ${p.profile}`.toLowerCase().includes(s));

  return (
    <section className="screen screen-full">
      <div className="toolbar">
        <input className="input" style={{ width: 260 }} placeholder="Search products or strains" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-control">Status <span className="muted">All</span></button>
        <button className="btn btn-control">Visible in <span className="muted">Any store</span></button>
        <button className="btn btn-control">Type <span className="muted">Flower</span></button>
        <SampleData />
        <div className="spacer" />
        <div className="seg-sm">
          <button className={`seg-sm-item${view === "table" ? " active" : ""}`} onClick={() => setView("table")}>Table</button>
          <button className={`seg-sm-item${view === "grid" ? " active" : ""}`} onClick={() => setView("grid")}>Grid</button>
        </div>
        <button className="btn btn-primary" onClick={() => toast("Product creation ships in a later release")}>New product</button>
      </div>

      {view === "table" ? (
        <>
          <div className="thead cols-cat">
            <span /><span>Product</span><span>Type</span><span>Status</span><span>Visible in</span><span className="r">Variants</span><span className="r">From</span>
          </div>
          {rows.length === 0 ? <EmptyState title="No products match" why="Try another product or strain name." /> : (
            <div className="scroll">
              {rows.map((p) => (
                <div key={p.name} className="row tall cols-cat">
                  <span className="swatch" style={{ backgroundColor: p.swatch }} />
                  <span className="two-line"><span className="ellip" style={{ fontWeight: 500 }}>{p.name}</span><span className="second">{p.profile}</span></span>
                  <span className="sub">{p.type}</span>
                  <span><Pill kind={p.statusKind} dot={false}>{p.status}</Pill></span>
                  <span style={{ display: "flex", gap: 4 }}>{p.stores.map((id) => <span key={id} className={`store-chip ${id}`}>{storeChipLabel[id]}</span>)}</span>
                  <span className="r soft">{p.variants}</span>
                  <span className="r">{price(p.price)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="grid-5">
          {rows.map((p) => (
            <div key={p.name} className="card product-card">
              <div className="product-photo" style={{ backgroundColor: p.swatch }}>product photo</div>
              <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="ellip" style={{ fontWeight: 500 }}>{p.name}</div>
                <div className="mute" style={{ fontSize: 11.5 }}>{p.type} · {p.profile}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                  <Pill kind={p.statusKind} sm dot={false}>{p.status}</Pill>
                  <span className="num" style={{ fontSize: 12.5 }}>{price(p.price)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

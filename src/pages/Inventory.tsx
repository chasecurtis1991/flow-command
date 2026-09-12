import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/app";
import { coaColor, driftColor, lotsSummary, shopInv, useLots } from "../lib/mock";
import { type InventoryVariant, type Kind, loadInventory, lowStock, storeById, useInventory } from "../lib/shopify";
import { type ColumnDef, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill, SampleData } from "../components/ui";
import { ColumnsMenu, FilterChips, TableHead, TableRow } from "../components/DataTable";

// FGINV drift banner still derives from the design sample until FGINV has a backend.
const drifted = shopInv.filter((v) => v.sync.startsWith("Drift"));
const driftUnits = drifted.reduce((a, v) => a + Math.abs(parseInt(v.sync.replace(/[^\d+\-−]/g, "").replace("−", "-"), 10) || 0), 0);

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const statusPill = (v: InventoryVariant): { label: string; kind: Kind } => {
  if (!v.tracked) return { label: "Untracked", kind: "neutral" };
  if (v.productStatus === "ACTIVE") return { label: "Active", kind: "green" };
  if (v.productStatus === "DRAFT") return { label: "Draft", kind: "amber" };
  if (v.productStatus === "ARCHIVED") return { label: "Archived", kind: "neutral" };
  return { label: titleCase(v.productStatus), kind: "neutral" };
};
/** Summed across locations; null when the products-only fallback ran (no per-location levels). */
const sum = (v: InventoryVariant, k: "onHand" | "committed") => (v.levels.length ? v.levels.reduce((a, l) => a + l[k], 0) : null);
const variantName = (v: InventoryVariant) => `${v.productTitle}${v.variantTitle != null ? ` · ${v.variantTitle}` : ""}`;

const INVENTORY_COLUMNS: ColumnDef<InventoryVariant>[] = [
  {
    id: "variant", label: "Variant", width: "minmax(0, 1.4fr)", cellClass: "ellip", sortValue: variantName,
    filter: { kind: "text", value: (v) => variantName(v), placeholder: "Product or variant" },
    cell: (v) => <>
      {v.productTitle}
      {v.variantTitle != null && <span className="mute"> · {v.variantTitle}</span>}
      {v.productStatus !== "ACTIVE" && <> <span className="tag-caps">{v.productStatus}</span></>}
    </>,
  },
  { id: "sku", label: "SKU", width: "150px", cellClass: "sub mono", cellStyle: () => ({ fontSize: 12 }), sortValue: (v) => v.sku, filter: { kind: "text", value: (v) => v.sku ?? "", placeholder: "SKU" }, cell: (v) => v.sku ?? "—" },
  { id: "onHand", label: "On hand", width: "110px", align: "right", sortValue: (v) => sum(v, "onHand"), sortDir: "desc", cell: (v) => sum(v, "onHand") ?? "—" },
  { id: "committed", label: "Committed", width: "110px", align: "right", sortValue: (v) => sum(v, "committed"), sortDir: "desc", cell: (v) => sum(v, "committed") ?? "—" },
  {
    id: "available", label: "Available", width: "110px", align: "right", sortValue: (v) => v.available, sortDir: "desc",
    cellStyle: (v) => ({ fontWeight: 500, color: lowStock(v) ? "var(--amber)" : "var(--text)" }), cell: (v) => v.available,
  },
  { id: "fginv", label: "FGINV", title: "FGINV counts arrive when the FGINV backend is wired", width: "90px", align: "right", cellClass: "sub", cell: () => "—" },
  {
    id: "status", label: "Status", width: "130px", sortValue: (v) => statusPill(v).label,
    filter: { kind: "enum", value: (v) => statusPill(v).label },
    cell: (v) => { const st = statusPill(v); return <Pill kind={st.kind}>{st.label}</Pill>; },
  },
];

export function Inventory() {
  const navigate = useNavigate();
  const { store, storeReady, toast, openSheet } = useApp();
  const inv = useInventory();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "fginv" ? "fginv" : "shopify";
  const setTab = (t: "shopify" | "fginv") => setParams(t === "fginv" ? { tab: "fginv" } : {}, { replace: true });
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const lots = useLots();

  useEffect(() => {
    if (storeReady && tab === "shopify" && (inv.status === "idle" || (inv.store !== store && inv.status !== "loading"))) void loadInventory(store);
  }, [storeReady, tab, store, inv.status, inv.store]);

  const s = q.trim().toLowerCase();
  const variants = inv.data?.variants ?? [];
  const locations = inv.data?.locations ?? [];
  // Search + Low stock are the toolbar-wide pre-filters; column filters and sort apply on top.
  const searched = useMemo(() => variants.filter((v) =>
    (!lowOnly || lowStock(v)) && (!s || `${v.productTitle} ${v.variantTitle ?? ""} ${v.sku ?? ""}`.toLowerCase().includes(s))), [variants, lowOnly, s]);
  const table = useTable<InventoryVariant>({ id: "inventory", columns: INVENTORY_COLUMNS, rows: searched });
  const rows = table.rowsOut;

  const sync = () => {
    const t0 = performance.now();
    const label = storeById(store).label;
    void loadInventory(store, true).then((st) => {
      const ms = Math.round(performance.now() - t0);
      toast(st.status === "data" ? `Synced ${label} · ${st.data?.variants.length ?? 0} variants · ${ms} ms` : `Sync failed · ${st.error ?? "unknown error"}`);
    });
  };

  let body;
  if (inv.status === "loading" || inv.status === "idle") body = <LoadingState label="Loading inventory from Shopify…" />;
  else if (inv.status === "error") body = (
    <ErrorState title="Couldn’t reach Shopify" why={(inv.error ?? "Unknown error").slice(0, 160)} actions={<>
      <button className="btn btn-primary" onClick={() => void loadInventory(store, true)}>Retry</button>
      <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
    </>} />
  );
  else if (rows.length === 0) body = (
    <EmptyState title="No variants match" why="Try another SKU, or clear Low stock only and the column filters."
      action={<button className="btn btn-secondary" onClick={() => { setQ(""); setLowOnly(false); table.clearFilters(); }}>Clear filters</button>} />
  );
  else body = (
    <div className="scroll">
      {rows.map((v) => <TableRow key={v.id} table={table} row={v} />)}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className="tabs">
        <button className={`tab${tab === "shopify" ? " active" : ""}`} onClick={() => setTab("shopify")}>Shopify</button>
        <button className={`tab${tab === "fginv" ? " active" : ""}`} onClick={() => setTab("fginv")}>FGINV <span className="tag-caps">SOURCE OF TRUTH</span></button>
        <div className="spacer" />
        {tab === "shopify" ? (
          <>
            <span className="mute" style={{ fontSize: 12 }}>Read-only mirror of Shopify</span>
            {inv.status === "data" && <Pill kind="green" sm>Live</Pill>}
          </>
        ) : <SampleData />}
      </div>

      {tab === "shopify" ? (
        <>
          <div className="toolbar" style={{ flexWrap: "wrap" }}>
            <input className="input" style={{ width: 280 }} placeholder="Search variants or SKUs" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-control">Location <span className="muted">{locations.join(", ") || "All"}</span></button>
            <button className={`btn btn-control${lowOnly ? " on" : ""}`} onClick={() => setLowOnly((v) => !v)}>Low stock only</button>
            <FilterChips table={table} />
            <div className="spacer" />
            <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{rows.length} variants</span>
            <ColumnsMenu table={table} />
            <button className="btn btn-control" onClick={sync}>Sync now</button>
          </div>
          {inv.data?.levelsError && (
            <div className="mute" style={{ fontSize: 12, padding: "0 24px 8px" }}>
              On hand / committed unavailable · needs read_inventory + read_locations · {inv.data.levelsError.slice(0, 120)}
            </div>
          )}
          {inv.data?.truncated && <div className="mute" style={{ fontSize: 12, padding: "0 24px 8px" }}>Showing the first 1,500 variants</div>}
          <TableHead table={table} />
          {body}
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

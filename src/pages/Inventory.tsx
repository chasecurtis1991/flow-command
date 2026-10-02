import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import { coaColor, driftColor, lotsSummary, shopInv, useLots } from "../lib/mock";
import {
  type InventoryProduct, type InventoryVariant, type Kind, type StoreId, adminUrl, groupInventory, loadInventory, lowStock, productStatus, storeById, useInventory,
} from "../lib/shopify";
import { type ColumnDef, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill, SampleData } from "../components/ui";
import { ColumnsMenu, FilterChips, TableHead, TableRow } from "../components/DataTable";
import { AdjustDialog } from "./AdjustDialog";
import { type MoveMode, StockMoveDialog } from "./StockMoveDialog";

// FGINV drift banner still derives from the design sample until FGINV has a backend.
const drifted = shopInv.filter((v) => v.sync.startsWith("Drift"));
const driftUnits = drifted.reduce((a, v) => a + Math.abs(parseInt(v.sync.replace(/[^\d+\-−]/g, "").replace("−", "-"), 10) || 0), 0);

const statusPill = (p: InventoryProduct): { label: string; kind: Kind } => (p.tracked ? productStatus(p.status) : { label: "Untracked", kind: "neutral" });
/** Summed across locations; null when the products-only fallback ran (no per-location levels). */
const sum = (v: InventoryVariant, k: "onHand" | "committed") => (v.levels.length ? v.levels.reduce((a, l) => a + l[k], 0) : null);
const leafSku = (p: InventoryProduct) => (p.leaf ? p.variants[0].sku : null);
const canAdjust = (v: InventoryVariant) => v.tracked && !!v.inventoryItemId && v.levels.some((l) => l.locationId);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The tree: useTable only ever sees product rows (sort / filter / count are per product); variant rows are rendered
// under their open product afterwards, so sortValue / filter guard on kind and only read `p`.
type InvRow = { kind: "product"; p: InventoryProduct } | { kind: "variant"; p: InventoryProduct; v: InventoryVariant };

type Adjusting = { p: InventoryProduct; v: InventoryVariant };

function inventoryColumns(store: StoreId, isOpen: (p: InventoryProduct) => boolean, toggle: (id: string) => void, adjust: (a: Adjusting) => void): ColumnDef<InvRow>[] {
  return [
    {
      id: "product", label: "Product", width: "minmax(0, 1.6fr)", cellClass: (r) => (r.kind === "product" ? "ellip" : "ellip child-cell"),
      sortValue: (r) => (r.kind === "product" ? r.p.title : null),
      filter: { kind: "text", value: (r) => (r.kind === "product" ? `${r.p.title} ${r.p.variants.map((v) => `${v.variantTitle ?? ""} ${v.sku ?? ""}`).join(" ")}` : ""), placeholder: "Product, variant or SKU" },
      cell: (r) => (r.kind === "product" ? <>
        {r.p.leaf ? <span style={{ display: "inline-block", width: 22 }} /> : (
          <button className="icon-btn chevron" aria-expanded={isOpen(r.p)} aria-label="Show variants" onClick={(e) => { e.stopPropagation(); toggle(r.p.id); }}>›</button>
        )}
        {r.p.title}
        {r.p.leaf ? r.p.variants[0].variantTitle != null && <span className="mute"> · {r.p.variants[0].variantTitle}</span>
          : <span className="mute"> · {r.p.variants.length} variants</span>}
        {r.p.status !== "ACTIVE" && <> <span className="tag-caps">{r.p.status}</span></>}
      </> : <>
        {r.v.variantTitle ?? "Default"}
        {!r.v.tracked && <> <span className="tag-caps">UNTRACKED</span></>}
      </>),
    },
    {
      id: "sku", label: "SKU", width: "150px", cellClass: "sub mono", cellStyle: () => ({ fontSize: 12 }), sortValue: (r) => (r.kind === "product" ? leafSku(r.p) : null),
      filter: { kind: "text", value: (r) => (r.kind === "product" ? r.p.variants.map((v) => v.sku ?? "").join(" ") : ""), placeholder: "SKU" },
      cell: (r) => (r.kind === "product" ? leafSku(r.p) : r.v.sku) ?? "—",
    },
    { id: "onHand", label: "On hand", width: "110px", align: "right", sortValue: (r) => (r.kind === "product" ? r.p.onHand : null), sortDir: "desc", cell: (r) => (r.kind === "product" ? r.p.onHand : sum(r.v, "onHand")) ?? "—" },
    { id: "committed", label: "Committed", width: "110px", align: "right", sortValue: (r) => (r.kind === "product" ? r.p.committed : null), sortDir: "desc", cell: (r) => (r.kind === "product" ? r.p.committed : sum(r.v, "committed")) ?? "—" },
    {
      id: "available", label: "Available", width: "110px", align: "right", sortValue: (r) => (r.kind === "product" ? r.p.available : null), sortDir: "desc",
      cellStyle: (r) => ({ fontWeight: r.kind === "product" ? 500 : undefined, color: (r.kind === "product" ? r.p.low : lowStock(r.v)) ? "var(--amber)" : "var(--text)" }),
      cell: (r) => (r.kind === "product" ? r.p.available : r.v.available),
    },
    { id: "fginv", label: "FGINV", title: "FGINV counts arrive when the FGINV backend is wired", width: "90px", align: "right", cellClass: "sub", cell: () => "—" },
    {
      id: "status", label: "Status", width: "130px", sortValue: (r) => (r.kind === "product" ? statusPill(r.p).label : null),
      filter: { kind: "enum", value: (r) => (r.kind === "product" ? statusPill(r.p).label : null) },
      cell: (r) => { if (r.kind !== "product") return null; const st = statusPill(r.p); return <Pill kind={st.kind}>{st.label}</Pill>; }, // status is product-level; UNTRACKED tags mark variants
    },
    {
      id: "open", label: "", title: "Adjust stock · Open in Shopify", width: "64px", hideable: false, cellStyle: () => ({ display: "flex", alignItems: "center", gap: 2 }),
      cell: (r) => {
        const v = r.kind === "variant" ? r.v : r.p.leaf ? r.p.variants[0] : null; // multi-variant products adjust per variant row
        return <>
          {v && canAdjust(v) ? <button className="icon-btn" title="Adjust stock" aria-label={`Adjust stock for ${v.variantTitle ?? r.p.title}`} onClick={(e) => { e.stopPropagation(); adjust({ p: r.p, v }); }}>±</button>
            : <span style={{ display: "inline-block", width: 22 }} />}
          {r.kind === "product" && <button className="icon-btn" title="Open in Shopify" aria-label="Open in Shopify" onClick={(e) => { e.stopPropagation(); void openUrl(adminUrl(store, r.p.id)); }}>{"↗"}</button>}
        </>;
      },
    },
  ];
}

export function Inventory() {
  const navigate = useNavigate();
  const { store, storeReady, toast } = useApp();
  const inv = useInventory();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "fginv" ? "fginv" : "shopify";
  const setTab = (t: "shopify" | "fginv") => setParams(t === "fginv" ? { tab: "fginv" } : {}, { replace: true });
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [lowOnly, setLowOnly] = useState(() => params.get("low") === "1"); // Home's Low stock card links here with ?low=1
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const lots = useLots();
  // The store is pinned when ± is clicked (the store whose data was shown), so a store switch can't retarget the write.
  const [adjusting, setAdjusting] = useState<(Adjusting & { storeId: StoreId }) | null>(null);
  // Receive / Transfer: opened from the toolbar, the FGINV cards, or ?action=receive|transfer (Home, ⌘⇧R, palette).
  const [move, setMove] = useState<{ mode: MoveMode; storeId: StoreId } | null>(null);
  const openMove = useCallback((mode: MoveMode) => { if (inv.store && inv.status === "data") setMove({ mode, storeId: inv.store }); }, [inv.store, inv.status]);
  const action = params.get("action");
  useEffect(() => {
    if ((action === "receive" || action === "transfer") && inv.status === "data" && inv.store === store) {
      openMove(action);
      setParams({}, { replace: true });
    }
  }, [action, inv.status, inv.store, store, openMove, setParams]);
  // ?q= / ?low=1 deep links (assistant, Home), consumed also while the page is open; keeps ?tab.
  useEffect(() => {
    const pq = params.get("q"), low = params.get("low");
    if (pq == null && low == null) return;
    if (pq != null) setQ(pq);
    if (low === "1") setLowOnly(true);
    setParams(params.get("tab") === "fginv" ? { tab: "fginv" } : {}, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  // ?adjust=<variant gid> (assistant: "adjust Lifter 7g") opens the Adjust dialog for that variant.
  const adjustParam = params.get("adjust");
  useEffect(() => {
    if (!adjustParam || inv.status !== "data" || inv.store !== store) return;
    const v = inv.data?.variants.find((x) => x.id === adjustParam);
    const p = v && groupInventory(inv.data!.variants).find((x) => x.id === v.productId);
    if (v && p) setAdjusting({ p, v, storeId: store });
    setParams({}, { replace: true });
  }, [adjustParam, inv.status, inv.store, store]); // eslint-disable-line react-hooks/exhaustive-deps
  const onAdjust = useCallback((a: Adjusting) => { if (inv.store) setAdjusting({ ...a, storeId: inv.store }); }, [inv.store]);

  useEffect(() => {
    if (storeReady && (inv.status === "idle" || (inv.store !== store && inv.status !== "loading"))) void loadInventory(store);
  }, [storeReady, store, inv.status, inv.store]);

  const s = q.trim().toLowerCase();
  const filtering = !!s || lowOnly; // an active pre-filter auto-reveals its matches
  const variants = inv.data?.variants ?? [];
  const locations = inv.data?.locations ?? [];
  const products = useMemo(() => groupInventory(variants), [variants]);
  // Search + Low stock are the toolbar-wide pre-filters; column filters and sort apply on top (per product).
  const hit = (v: InventoryVariant) => `${v.variantTitle ?? ""} ${v.sku ?? ""}`.toLowerCase().includes(s);
  const productRows = useMemo<InvRow[]>(() => products
    .filter((p) => (!lowOnly || p.low) && (!s || p.title.toLowerCase().includes(s) || p.variants.some(hit)))
    .map((p) => ({ kind: "product", p })), [products, lowOnly, s]); // eslint-disable-line react-hooks/exhaustive-deps
  // Children under an open product: only low ones under Low stock; only matching ones when the search hit a variant but not the title.
  const kids = (p: InventoryProduct) => p.variants.filter((v) => (!lowOnly || lowStock(v)) && (!s || p.title.toLowerCase().includes(s) || hit(v)));
  const isOpen = useCallback((p: InventoryProduct) => filtering || expanded.has(p.id), [filtering, expanded]);
  const toggle = useCallback((id: string) => setExpanded((e) => { const n = new Set(e); if (!n.delete(id)) n.add(id); return n; }), []);
  const anyClosed = !products.length || products.some((p) => !p.leaf && !expanded.has(p.id));
  const columns = useMemo(() => inventoryColumns(store, isOpen, toggle, onAdjust), [store, isOpen, toggle, onAdjust]);
  const table = useTable<InvRow>({ id: "inventory", columns, rows: productRows });
  const rows = table.rowsOut;
  const shown = rows.reduce((a, r) => a + (r.p.leaf ? 1 : isOpen(r.p) ? kids(r.p).length : 0), 0); // leaves + visible children

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
    <EmptyState title="No products match" why="Try another product, variant or SKU, or clear Low stock only and the column filters."
      action={<button className="btn btn-secondary" onClick={() => { setQ(""); setLowOnly(false); table.clearFilters(); }}>Clear filters</button>} />
  );
  else body = (
    <div className="scroll">
      {rows.map(({ p }) => (
        <Fragment key={p.id}>
          <TableRow table={table} row={{ kind: "product", p }} className={p.leaf ? undefined : "parent"} onClick={p.leaf ? undefined : () => toggle(p.id)} />
          {!p.leaf && isOpen(p) && kids(p).map((v) => <TableRow key={v.id} table={table} row={{ kind: "variant", p, v }} className="child" />)}
        </Fragment>
      ))}
    </div>
  );

  return (
    <section className="screen screen-full">
      {move && <StockMoveDialog mode={move.mode} storeId={move.storeId} variants={inv.data?.variants ?? []} onClose={() => setMove(null)} />}
      {adjusting && <AdjustDialog variant={adjusting.v} productTitle={adjusting.p.title} storeId={adjusting.storeId} onClose={() => setAdjusting(null)} />}
      <div className="tabs">
        <button className={`tab${tab === "shopify" ? " active" : ""}`} onClick={() => setTab("shopify")}>Shopify</button>
        <button className={`tab${tab === "fginv" ? " active" : ""}`} onClick={() => setTab("fginv")}>FGINV <span className="tag-caps">SOURCE OF TRUTH</span></button>
        <div className="spacer" />
        {tab === "shopify" ? (
          <>
            <span className="mute" style={{ fontSize: 12 }}>Mirror of Shopify · ± adjusts stock</span>
            {inv.status === "data" && <Pill kind="green" sm>Live</Pill>}
          </>
        ) : <SampleData />}
      </div>

      {tab === "shopify" ? (
        <>
          <div className="toolbar" style={{ flexWrap: "wrap" }}>
            <input className="input" style={{ width: 280 }} placeholder="Search products, variants or SKUs" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-control">Location <span className="muted">{locations.join(", ") || "All"}</span></button>
            <button className={`btn btn-control${lowOnly ? " on" : ""}`} onClick={() => setLowOnly((v) => !v)}>Low stock only</button>
            <button className="btn btn-control" onClick={() => setExpanded(anyClosed ? new Set(products.filter((p) => !p.leaf).map((p) => p.id)) : new Set())}>{anyClosed ? "Expand all" : "Collapse all"}</button>
            <FilterChips table={table} />
            <div className="spacer" />
            <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{plural(rows.length, "product")} · {plural(shown, "variant")}</span>
            <ColumnsMenu table={table} />
            <button className="btn btn-control" disabled={inv.status !== "data"} onClick={() => openMove("receive")}>Receive</button>
            <button className="btn btn-control" disabled={inv.status !== "data"} onClick={() => openMove("transfer")}>Transfer</button>
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
            <button className="action-card" onClick={() => openMove("receive")}>
              <span className="name">Receive</span><span className="desc">Add incoming units to Shopify stock at a location, with a lot or PO reference.</span><span className="cta">New receipt →</span>
            </button>
            <button className="action-card" onClick={() => openMove("transfer")}>
              <span className="name">Transfer</span><span className="desc">Move units between Shopify locations — both sides apply together.</span><span className="cta">New transfer →</span>
            </button>
            <button className="action-card" onClick={() => { setTab("shopify"); toast("Adjust Shopify stock with ± on a variant row"); }}>
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

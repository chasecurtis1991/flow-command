import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import {
  STORES, type CatalogProduct, type PresenceState, type StoreId, adminUrl, isScopeError, loadCatalog, loadPresence, money, moneyNum, presenceIn, productProfile,
  productStatus, storeById, swatchColor, useCatalog, usePresence,
} from "../lib/shopify";
import { type ColumnDef, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";
import { ColumnsMenu, FilterButton, FilterChips, TableHead, TableRow } from "../components/DataTable";
import { VariantSplitDialog } from "./VariantSplitDialog";
import { ProductDetailPanel } from "./ProductDetailPanel";

const storeChipLabel: Record<StoreId, string> = { retail: "R", b2b: "B2B", bulk: "Bulk" };
const STATUS_OPTIONS = ["ACTIVE", "DRAFT", "ARCHIVED"].map((v) => ({ value: v, label: productStatus(v).label }));

/** Featured image when Shopify has one, otherwise a stable colour derived from the title. */
const art = (p: CatalogProduct): CSSProperties =>
  p.imageUrl ? { backgroundImage: `url("${p.imageUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : { backgroundColor: swatchColor(p.title) };
const priceRange = (p: CatalogProduct) => (p.minPrice !== p.maxPrice ? `${money(p.minPrice)} – ${money(p.maxPrice)}` : undefined);
const openBtn = (store: StoreId, gid: string) => (
  <button className="icon-btn" title="Open in Shopify" aria-label="Open in Shopify" onClick={(e) => { e.stopPropagation(); void openUrl(adminUrl(store, gid)); }}>{"↗"}</button>
);

function catalogColumns(store: StoreId, typeOptions: { value: string; label: string }[], presence: PresenceState, split: (p: CatalogProduct) => void): ColumnDef<CatalogProduct>[] {
  // The active store answers from the product itself; the others from their presence lists (handle / title match).
  const statusIn = (p: CatalogProduct, id: StoreId) => (id === store ? p.status : presenceIn(p, presence[id].data?.products));
  const pending = (id: StoreId) => id !== store && (presence[id].status === "idle" || presence[id].status === "loading");
  const activeIn = (p: CatalogProduct) => STORES.filter((s) => statusIn(p, s.id) === "ACTIVE");
  const visibleIn = (p: CatalogProduct) => {
    const chips = activeIn(p).map((s) => <span key={s.id} className={`store-chip ${s.id}`}>{storeChipLabel[s.id]}</span>);
    const wait = STORES.some((s) => pending(s.id));
    const title = STORES.map((s) => {
      if (pending(s.id)) return `Loading ${s.short}`;
      if (s.id !== store && presence[s.id].status === "error") return `${s.short} unavailable`;
      const st = statusIn(p, s.id);
      return `${st ? productStatus(st).label : "Not listed"} in ${s.short}`;
    }).join(" · ");
    return <span title={title} style={{ display: "flex", gap: 4, minWidth: 0 }}>{chips}{wait ? <span className="mute">…</span> : !chips.length && <span className="mute">—</span>}</span>;
  };
  return [
    { id: "art", label: "", title: "Image", width: "36px", cellClass: "swatch", cellStyle: art, cell: () => null },
    {
      id: "product", label: "Product", width: "minmax(0, 1.4fr)", cellClass: "two-line", sortValue: (p) => p.title,
      filter: { kind: "text", value: (p) => `${p.title} ${productProfile(p)} ${p.vendor ?? ""}`, placeholder: "Title, size, vendor" },
      cell: (p) => <><span className="ellip" style={{ fontWeight: 500 }}>{p.title}</span><span className="second ellip">{productProfile(p)}</span></>,
    },
    {
      id: "type", label: "Type", width: "110px", cellClass: "sub ellip", sortValue: (p) => p.productType,
      filter: { kind: "enum", value: (p) => p.productType ?? "", options: typeOptions }, cell: (p) => p.productType ?? "—",
    },
    {
      id: "status", label: "Status", width: "90px", sortValue: (p) => p.status,
      filter: { kind: "enum", value: (p) => p.status, options: STATUS_OPTIONS },
      cell: (p) => { const st = productStatus(p.status); return <Pill kind={st.kind} dot={false}>{st.label}</Pill>; },
    },
    {
      id: "visible", label: "Visible in", title: "Stores where the product is active", width: "160px", cell: visibleIn,
      filter: { kind: "text", value: (p) => activeIn(p).map((s) => s.short).join(" "), placeholder: "e.g. B2B" },
    },
    { id: "variants", label: "Variants", width: "80px", align: "right", cellClass: "soft", sortValue: (p) => p.variantCount, sortDir: "desc", cell: (p) => p.variantCount },
    { id: "price", label: "From", width: "110px", align: "right", sortValue: (p) => moneyNum(p.minPrice), sortDir: "desc", cell: (p) => <span title={priceRange(p)}>{money(p.minPrice)}</span> },
    { id: "inventory", label: "Inventory", width: "90px", align: "right", defaultHidden: true, sortValue: (p) => (p.tracksInventory ? p.totalInventory : null), sortDir: "desc", cell: (p) => (p.tracksInventory ? p.totalInventory : "—") },
    { id: "vendor", label: "Vendor", width: "120px", defaultHidden: true, cellClass: "sub ellip", sortValue: (p) => p.vendor, filter: { kind: "text", value: (p) => p.vendor ?? "" }, cell: (p) => p.vendor ?? "—" },
    { id: "split", label: "", title: "Split variants", width: "112px", hideable: false, cell: (p) => p.variantCount > 1 && <button className="btn btn-control" onClick={(e) => { e.stopPropagation(); split(p); }}>Split variants</button> },
    { id: "open", label: "", title: "Open in Shopify", width: "32px", hideable: false, cell: (p) => openBtn(store, p.id) },
  ];
}

export function Catalog() {
  const navigate = useNavigate();
  const { store, storeReady, toast } = useApp();
  const cat = useCatalog();
  const presence = usePresence();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [splitTarget, setSplitTarget] = useState<{ product: CatalogProduct; storeId: StoreId } | null>(null);
  // Selected product lives in ?sel=<gid>; its detail panel opens beside the list/grid (× or Esc closes it).
  const selected = params.get("sel");
  const select = (id: string | null) => setParams(id ? { sel: id } : {}, { replace: true });
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) select(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selStore, setSelStore] = useState(store);
  useEffect(() => { if (store !== selStore) { setSelStore(store); select(null); } }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => select(id === selected ? null : id);
  const [view, setView] = useState<"table" | "grid">(() => (params.get("view") === "grid" ? "grid" : "table")); // ?view=grid deep link

  useEffect(() => {
    if (storeReady && (cat.status === "idle" || (cat.store !== store && cat.status !== "loading"))) void loadCatalog(store);
  }, [storeReady, store, cat.status, cat.store]);
  // The other stores' presence lists feed "Visible in"; errored entries stay put until ⌘R (Retry is explicit).
  useEffect(() => {
    if (storeReady) STORES.forEach((s) => { if (s.id !== store && presence[s.id].status === "idle") void loadPresence(s.id); });
  }, [storeReady, store, presence]);

  const products = cat.data?.products ?? [];
  const typeOptions = useMemo(() => {
    const types = [...new Set(products.map((p) => p.productType ?? ""))].sort((a, b) => a.localeCompare(b));
    return types.map((t) => ({ value: t, label: t || "(blank)" }));
  }, [products]);
  // Search is the toolbar-wide text filter; column filters and sort then apply on top of it.
  const s = q.trim().toLowerCase();
  const searched = useMemo(() => (!s ? products : products.filter((p) =>
    `${p.title} ${p.productType ?? ""} ${p.vendor ?? ""} ${p.tags.join(" ")} ${productProfile(p)}`.toLowerCase().includes(s))), [products, s]);

  const split = (product: CatalogProduct) => { if (cat.store === store && storeReady) setSplitTarget({ product, storeId: store }); };
  const columns = useMemo(() => catalogColumns(store, typeOptions, presence, split), [store, typeOptions, presence, cat.store, storeReady]);
  const table = useTable<CatalogProduct>({ id: "catalog", columns, rows: searched });
  const rows = table.rowsOut;

  // Deep links (⌘K palette, Home shortcuts): ?q=<title> prefills search, ?status=draft presets the filter; then drop them.
  useEffect(() => {
    if (!params.has("q") && !params.has("status")) return;
    const pq = params.get("q");
    if (pq != null) setQ(pq);
    const ps = params.get("status")?.toUpperCase();
    if (ps) table.setFilter("status", STATUS_OPTIONS.some((o) => o.value === ps) ? [ps] : null);
    setParams({}, { replace: true });
  }, [params, setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = () => {
    const t0 = performance.now();
    const label = storeById(store).label;
    void loadCatalog(store, true).then((st) => {
      const ms = Math.round(performance.now() - t0);
      toast(st.status === "data" ? `Synced ${label} · ${st.data?.products.length ?? 0} products · ${ms} ms` : `Sync failed · ${st.error ?? "unknown error"}`);
    });
  };
  const clearAll = () => { setQ(""); table.clearFilters(); };

  let body;
  if (cat.status === "loading" || cat.status === "idle") body = <LoadingState label="Loading catalog from Shopify…" />;
  else if (cat.status === "error") {
    const scope = isScopeError(cat.error);
    body = (
      <ErrorState
        title={scope ? "Missing product access" : "Couldn’t reach Shopify"}
        why={scope ? `Grant the read_products scope to the Flow Command app on ${storeById(store).label} (${storeById(store).domain}), then retry.` : (cat.error ?? "Unknown error").slice(0, 160)}
        actions={<>
          <button className="btn btn-primary" onClick={() => void loadCatalog(store, true)}>Retry</button>
          <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
        </>}
      />
    );
  } else if (rows.length === 0) body = (
    <EmptyState
      title={products.length === 0 ? "No products in this store" : "No products match"}
      why={products.length === 0 ? `${storeById(store).label} has an empty catalog.` : "Try another product, type or tag, or clear the filters."}
      action={products.length > 0 && <button className="btn btn-secondary" onClick={clearAll}>Clear filters</button>}
    />
  );
  else if (view === "table") body = (
    <div className="scroll">
      {rows.map((p) => <TableRow key={p.id} table={table} row={p} className={`tall clickable${p.id === selected ? " selected" : ""}`} onClick={() => toggle(p.id)} />)}
    </div>
  );
  else body = (
    <div className="grid-5">
      {rows.map((p) => {
        const st = productStatus(p.status);
        return (
          <div key={p.id} className={`card product-card clickable${p.id === selected ? " selected" : ""}`} role="button" tabIndex={0}
            onClick={() => toggle(p.id)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && toggle(p.id)}>
            <div className="product-photo" style={art(p)}>{!p.imageUrl && "no photo"}</div>
            <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="ellip" style={{ fontWeight: 500 }} title={p.title}>{p.title}</div>
              <div className="mute ellip" style={{ fontSize: 11.5 }}>{p.productType ?? "—"} · {productProfile(p)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <Pill kind={st.kind} sm dot={false}>{st.label}</Pill>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="num" style={{ fontSize: 12.5 }} title={priceRange(p)}>{money(p.minPrice)}</span>
                  {openBtn(store, p.id)}
                </span>
              </div>
              {p.variantCount > 1 && <button className="btn btn-control" style={{ marginTop: 8 }} onClick={(e) => { e.stopPropagation(); split(p); }}>Split variants</button>}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className={selected ? "orders" : "cust-full"}>
      <div className="orders-list">
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ width: 240 }} placeholder="Search products, types or tags" value={q} onChange={(e) => setQ(e.target.value)} />
        <FilterButton table={table} column="status" />
        <FilterButton table={table} column="type" />
        <FilterChips table={table} exclude={["status", "type"]} />
        {cat.status === "data" && (import.meta.env.DEV && "__FLOW_COMMAND_BROWSER_PREVIEW__" in window
          ? <Pill kind="neutral" sm>Sample data</Pill> : <Pill kind="green" sm>Live</Pill>)}
        <div className="spacer" />
        <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{rows.length} products</span>
        <button className="btn btn-control" onClick={sync}>Sync now</button>
        {view === "table" && <ColumnsMenu table={table} />}
        <div className="seg-sm">
          <button className={`seg-sm-item${view === "table" ? " active" : ""}`} onClick={() => setView("table")}>Table</button>
          <button className={`seg-sm-item${view === "grid" ? " active" : ""}`} onClick={() => setView("grid")}>Grid</button>
        </div>
        <button className="btn btn-primary" onClick={() => toast("Product creation ships in a later release")}>New product</button>
      </div>
      {cat.data?.truncated && <div className="mute" style={{ fontSize: 12, padding: "8px 24px 0" }}>Showing the first 1,000 products</div>}

      {view === "table" && <TableHead table={table} />}
      {body}
      </div>
      {selected && <ProductDetailPanel store={store} id={selected} onClose={() => select(null)} />}
      </div>
      {splitTarget && <VariantSplitDialog product={splitTarget.product} storeId={splitTarget.storeId} onClose={() => setSplitTarget(null)} />}
    </section>
  );
}

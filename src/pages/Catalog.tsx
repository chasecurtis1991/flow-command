import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/app";
import {
  type CatalogProduct, type StoreId, isScopeError, loadCatalog, money, moneyNum, productProfile, productStatus, storeById, swatchColor, useCatalog,
} from "../lib/shopify";
import { type ColumnDef, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";
import { ColumnsMenu, FilterButton, FilterChips, TableHead, TableRow } from "../components/DataTable";

const storeChipLabel: Record<StoreId, string> = { retail: "R", b2b: "B2B", bulk: "Bulk" };
const STATUS_OPTIONS = ["ACTIVE", "DRAFT", "ARCHIVED"].map((v) => ({ value: v, label: productStatus(v).label }));

/** Featured image when Shopify has one, otherwise a stable colour derived from the title. */
const art = (p: CatalogProduct): CSSProperties =>
  p.imageUrl ? { backgroundImage: `url("${p.imageUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : { backgroundColor: swatchColor(p.title) };
const priceRange = (p: CatalogProduct) => (p.minPrice !== p.maxPrice ? `${money(p.minPrice)} – ${money(p.maxPrice)}` : undefined);

function catalogColumns(store: StoreId, typeOptions: { value: string; label: string }[]): ColumnDef<CatalogProduct>[] {
  // Only the active store's catalog is loaded, so a chip is shown for it alone — never inferred for the other stores.
  const visibleIn = (p: CatalogProduct) =>
    p.status === "ACTIVE"
      ? <span className={`store-chip ${store}`} title={`Active in ${storeById(store).label}`}>{storeChipLabel[store]}</span>
      : <span className="mute">—</span>;
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
    { id: "visible", label: "Visible in", title: "Only the active store’s catalog is loaded", width: "160px", cellStyle: () => ({ display: "flex", gap: 4 }), cell: visibleIn },
    { id: "variants", label: "Variants", width: "80px", align: "right", cellClass: "soft", sortValue: (p) => p.variantCount, sortDir: "desc", cell: (p) => p.variantCount },
    { id: "price", label: "From", width: "110px", align: "right", sortValue: (p) => moneyNum(p.minPrice), sortDir: "desc", cell: (p) => <span title={priceRange(p)}>{money(p.minPrice)}</span> },
    { id: "inventory", label: "Inventory", width: "90px", align: "right", defaultHidden: true, sortValue: (p) => (p.tracksInventory ? p.totalInventory : null), sortDir: "desc", cell: (p) => (p.tracksInventory ? p.totalInventory : "—") },
    { id: "vendor", label: "Vendor", width: "120px", defaultHidden: true, cellClass: "sub ellip", sortValue: (p) => p.vendor, filter: { kind: "text", value: (p) => p.vendor ?? "" }, cell: (p) => p.vendor ?? "—" },
  ];
}

export function Catalog() {
  const navigate = useNavigate();
  const { store, storeReady, toast } = useApp();
  const cat = useCatalog();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [view, setView] = useState<"table" | "grid">("table");

  useEffect(() => {
    if (storeReady && (cat.status === "idle" || (cat.store !== store && cat.status !== "loading"))) void loadCatalog(store);
  }, [storeReady, store, cat.status, cat.store]);

  const products = cat.data?.products ?? [];
  const typeOptions = useMemo(() => {
    const types = [...new Set(products.map((p) => p.productType ?? ""))].sort((a, b) => a.localeCompare(b));
    return types.map((t) => ({ value: t, label: t || "(blank)" }));
  }, [products]);
  // Search is the toolbar-wide text filter; column filters and sort then apply on top of it.
  const s = q.trim().toLowerCase();
  const searched = useMemo(() => (!s ? products : products.filter((p) =>
    `${p.title} ${p.productType ?? ""} ${p.vendor ?? ""} ${p.tags.join(" ")} ${productProfile(p)}`.toLowerCase().includes(s))), [products, s]);

  const columns = useMemo(() => catalogColumns(store, typeOptions), [store, typeOptions]);
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
      {rows.map((p) => <TableRow key={p.id} table={table} row={p} className="tall" />)}
    </div>
  );
  else body = (
    <div className="grid-5">
      {rows.map((p) => {
        const st = productStatus(p.status);
        return (
          <div key={p.id} className="card product-card">
            <div className="product-photo" style={art(p)}>{!p.imageUrl && "no photo"}</div>
            <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="ellip" style={{ fontWeight: 500 }} title={p.title}>{p.title}</div>
              <div className="mute ellip" style={{ fontSize: 11.5 }}>{p.productType ?? "—"} · {productProfile(p)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <Pill kind={st.kind} sm dot={false}>{st.label}</Pill>
                <span className="num" style={{ fontSize: 12.5 }} title={priceRange(p)}>{money(p.minPrice)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ width: 240 }} placeholder="Search products, types or tags" value={q} onChange={(e) => setQ(e.target.value)} />
        <FilterButton table={table} column="status" />
        <button className="btn btn-control" title="Only the active store’s catalog is loaded" onClick={() => toast("Cross-store catalog ships in a later release")}>
          Visible in <span className="muted">{storeById(store).short}</span>
        </button>
        <FilterButton table={table} column="type" />
        <FilterChips table={table} exclude={["status", "type"]} />
        {cat.status === "data" && <Pill kind="green" sm>Live</Pill>}
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
    </section>
  );
}

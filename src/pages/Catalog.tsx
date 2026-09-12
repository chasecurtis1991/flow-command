import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/app";
import {
  type CatalogProduct, type StoreId, isScopeError, loadCatalog, money, productProfile, productStatus, storeById, swatchColor, useCatalog,
} from "../lib/shopify";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";

const STATUS_FILTERS = ["All", "Active", "Draft", "Archived"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const storeChipLabel: Record<StoreId, string> = { retail: "R", b2b: "B2B", bulk: "Bulk" };

const next = <T,>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length];
/** Featured image when Shopify has one, otherwise a stable colour derived from the title. */
const art = (p: CatalogProduct): CSSProperties =>
  p.imageUrl ? { backgroundImage: `url("${p.imageUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : { backgroundColor: swatchColor(p.title) };
const priceRange = (p: CatalogProduct) => (p.minPrice !== p.maxPrice ? `${money(p.minPrice)} – ${money(p.maxPrice)}` : undefined);

export function Catalog() {
  const navigate = useNavigate();
  const { store, storeReady, toast } = useApp();
  const cat = useCatalog();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [status, setStatus] = useState<StatusFilter>("All");
  const [type, setType] = useState("All");
  const [view, setView] = useState<"table" | "grid">("table");

  useEffect(() => {
    if (storeReady && (cat.status === "idle" || (cat.store !== store && cat.status !== "loading"))) void loadCatalog(store);
  }, [storeReady, store, cat.status, cat.store]);

  // Deep links (⌘K palette, Home shortcuts): ?q=<title> prefills search, ?status=draft presets the filter; then drop them.
  useEffect(() => {
    if (!params.has("q") && !params.has("status")) return;
    const pq = params.get("q");
    if (pq != null) setQ(pq);
    const ps = params.get("status")?.toLowerCase();
    if (ps) setStatus(STATUS_FILTERS.find((f) => f.toLowerCase() === ps) ?? "All");
    setParams({}, { replace: true });
  }, [params, setParams]);

  const products = cat.data?.products ?? [];
  const types = useMemo(() => ["All", ...[...new Set(products.map((p) => p.productType).filter((t): t is string => t != null))].sort()], [products]);
  useEffect(() => { if (!types.includes(type)) setType("All"); }, [types, type]);

  const s = q.trim().toLowerCase();
  const rows = products.filter((p) =>
    (status === "All" || p.status === status.toUpperCase()) &&
    (type === "All" || p.productType === type) &&
    (!s || `${p.title} ${p.productType ?? ""} ${p.vendor ?? ""} ${p.tags.join(" ")} ${productProfile(p)}`.toLowerCase().includes(s)));

  const sync = () => {
    const t0 = performance.now();
    const label = storeById(store).label;
    void loadCatalog(store, true).then((st) => {
      const ms = Math.round(performance.now() - t0);
      toast(st.status === "data" ? `Synced ${label} · ${st.data?.products.length ?? 0} products · ${ms} ms` : `Sync failed · ${st.error ?? "unknown error"}`);
    });
  };

  // Only the active store's catalog is loaded, so a chip is shown for it alone — never inferred for the other stores.
  const visibleIn = (p: CatalogProduct) =>
    p.status === "ACTIVE"
      ? <span className={`store-chip ${store}`} title={`Active in ${storeById(store).label}`}>{storeChipLabel[store]}</span>
      : <span className="mute">—</span>;

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
      action={products.length > 0 && <button className="btn btn-secondary" onClick={() => { setQ(""); setStatus("All"); setType("All"); }}>Clear filters</button>}
    />
  );
  else if (view === "table") body = (
    <div className="scroll">
      {rows.map((p) => {
        const st = productStatus(p.status);
        return (
          <div key={p.id} className="row tall cols-cat">
            <span className="swatch" style={art(p)} />
            <span className="two-line">
              <span className="ellip" style={{ fontWeight: 500 }}>{p.title}</span>
              <span className="second ellip">{productProfile(p)}</span>
            </span>
            <span className="sub ellip">{p.productType ?? "—"}</span>
            <span><Pill kind={st.kind} dot={false}>{st.label}</Pill></span>
            <span style={{ display: "flex", gap: 4 }}>{visibleIn(p)}</span>
            <span className="r soft">{p.variantCount}</span>
            <span className="r" title={priceRange(p)}>{money(p.minPrice)}</span>
          </div>
        );
      })}
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
      <div className="toolbar">
        <input className="input" style={{ width: 240 }} placeholder="Search products, types or tags" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`btn btn-control${status !== "All" ? " on" : ""}`} onClick={() => setStatus(next(STATUS_FILTERS, status))}>
          Status <span className="muted">{status}</span>
        </button>
        <button className="btn btn-control" title="Only the active store’s catalog is loaded" onClick={() => toast("Cross-store catalog ships in a later release")}>
          Visible in <span className="muted">{storeById(store).short}</span>
        </button>
        <button className={`btn btn-control${type !== "All" ? " on" : ""}`} disabled={types.length < 2} onClick={() => setType(next(types, type))}>
          Type <span className="muted">{type}</span>
        </button>
        {cat.status === "data" && <Pill kind="green" sm>Live</Pill>}
        <div className="spacer" />
        <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{rows.length} products</span>
        <button className="btn btn-control" onClick={sync}>Sync now</button>
        <div className="seg-sm">
          <button className={`seg-sm-item${view === "table" ? " active" : ""}`} onClick={() => setView("table")}>Table</button>
          <button className={`seg-sm-item${view === "grid" ? " active" : ""}`} onClick={() => setView("grid")}>Grid</button>
        </div>
        <button className="btn btn-primary" onClick={() => toast("Product creation ships in a later release")}>New product</button>
      </div>
      {cat.data?.truncated && <div className="mute" style={{ fontSize: 12, padding: "8px 24px 0" }}>Showing the first 1,000 products</div>}

      {view === "table" && (
        <div className="thead cols-cat">
          <span /><span>Product</span><span>Type</span><span>Status</span><span title="Only the active store’s catalog is loaded">Visible in</span><span className="r">Variants</span><span className="r">From</span>
        </div>
      )}
      {body}
    </section>
  );
}

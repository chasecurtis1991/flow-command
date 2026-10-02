import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STORES, type ProductDetail, type StoreCopy, type StoreId, adminUrl, getProductDetail, matchVariant, money, productStatus, storeById } from "../lib/shopify";
import { ErrorState, LoadingState, Pill } from "../components/ui";

const usd = (amount: string) => money(`${amount} USD`); // ponytail: all three stores sell in USD; carry currency per store if that changes
const nf = new Intl.NumberFormat("en-US");

/** Right-hand panel on Catalog: photos, details, and every variant's price in all three stores side by side. */
export function ProductDetailPanel({ store, id, onClose }: { store: StoreId; id: string; onClose: () => void }) {
  const [d, setD] = useState<{ product: ProductDetail; copies: StoreCopy[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [photo, setPhoto] = useState(0);

  useEffect(() => {
    let alive = true;
    setD(null); setError(null); setPhoto(0);
    getProductDetail(store, id).then((r) => alive && setD(r)).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [store, id, attempt]);

  const head = <div className="panel-close"><button className="icon-btn" aria-label="Close product" title="Close (Esc)" onClick={onClose}>×</button></div>;
  if (error) return <div className="detail">{head}<ErrorState title="Couldn’t load product" why={error.slice(0, 200)} actions={<button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>Retry</button>} /></div>;
  if (!d) return <div className="detail">{head}<LoadingState label="Loading product and the other stores…" /></div>;

  const p = d.product;
  const st = productStatus(p.status);
  // Column order follows the store switcher; the active store's own variants are the rows.
  const cols = STORES.map((s) => ({ store: s, copy: s.id === store ? null : d.copies.find((c) => c.storeId === s.id) ?? null }));
  const single = p.variants.length === 1 && p.variants[0].title === "Default Title";

  return (
    <div className="detail" key={p.id}>
      {head}
      <div className="detail-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingRight: 24 }}>
          <span className="h-heading">{p.title}</span>
          <Pill kind={st.kind} dot={false}>{st.label}</Pill>
        </div>
        <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>{[p.productType, p.vendor].filter(Boolean).join(" · ") || "—"} · {storeById(store).label}</div>
      </div>
      {p.images.length > 0 && (
        <div className="detail-section">
          <div className="product-hero" style={{ backgroundImage: `url("${p.images[photo]}")` }} role="img" aria-label={`${p.title} photo ${photo + 1}`} />
          {p.images.length > 1 && <div className="thumbs">{p.images.map((u, i) => (
            <button key={u} type="button" className={`thumb${i === photo ? " on" : ""}`} style={{ backgroundImage: `url("${u}")` }} aria-label={`Photo ${i + 1}`} onClick={() => setPhoto(i)} />
          ))}</div>}
        </div>
      )}
      <div className="detail-section">
        <span className="label">{single ? "Price by store" : `Variants · price by store`}</span>
        <table className="variant-table">
          <thead><tr>
            <th>{single ? "" : "Variant"}</th>
            {cols.map(({ store: s, copy }) => (
              <th key={s.id} className="r" title={copy?.state === "found" ? `Matched by ${copy.matchedBy}${copy.status && copy.status !== "ACTIVE" ? ` · ${productStatus(copy.status).label}` : ""}` : copy?.state === "error" ? copy.error ?? "" : undefined}>
                <span className={`dot ${s.id}`} /> {s.short}{copy?.state === "found" && copy.status !== "ACTIVE" ? "*" : ""}
              </th>
            ))}
            <th className="r">Stock</th>
          </tr></thead>
          <tbody>{p.variants.map((v) => (
            <tr key={v.id}>
              <td><div>{single ? "—" : v.title}</div>{v.sku && <div className="mono mute" style={{ fontSize: 11 }}>{v.sku}</div>}</td>
              {cols.map(({ store: s, copy }) => {
                if (!copy) return <td key={s.id} className="r num strong">{usd(v.price)}{v.compareAtPrice && <del className="mute" style={{ display: "block", fontSize: 11 }}>{usd(v.compareAtPrice)}</del>}</td>;
                if (copy.state === "error") return <td key={s.id} className="r mute" title={copy.error ?? ""}>error</td>;
                if (copy.state === "missing") return <td key={s.id} className="r mute">—</td>;
                const m = matchVariant(v, copy);
                return <td key={s.id} className="r num">{m ? usd(m.price) : <span className="mute" title="No variant with this SKU or name">—</span>}</td>;
              })}
              <td className="r num">{v.tracked ? nf.format(v.inventory) : <span className="mute">untracked</span>}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="mute" style={{ fontSize: 11.5, marginTop: 6 }}>
          {cols.filter((c) => c.copy?.state === "missing").map((c) => c.store.short).join(", ") ? `Not listed in ${cols.filter((c) => c.copy?.state === "missing").map((c) => c.store.short).join(", ")}. ` : ""}
          Other stores are matched by handle, then title; variants by SKU, then name.{cols.some((c) => c.copy?.state === "found" && c.copy.status !== "ACTIVE") ? " * = not active there." : ""} Stock is {storeById(store).short}’s.
        </div>
      </div>
      {p.description && <div className="detail-section"><span className="label">Description</span><div className="soft product-desc">{p.description}</div></div>}
      <div className="detail-section">
        <div className="kv">
          <span>Handle</span><span className="mono">{p.handle}</span>
          {p.tags.length > 0 && <><span>Tags</span><span className="tag-row" style={{ margin: 0 }}>{p.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</span></>}
          <span>Updated</span><span>{new Date(p.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="detail-section" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-secondary" onClick={() => void openUrl(adminUrl(store, p.id))}>Open in Shopify</button>
        {p.onlineStoreUrl && <button className="btn btn-control" onClick={() => void openUrl(p.onlineStoreUrl!)}>View on store ↗</button>}
        {d.copies.filter((c) => c.state === "found" && c.productId).map((c) => (
          <button key={c.storeId} className="btn btn-control" onClick={() => void openUrl(adminUrl(c.storeId, c.productId!))}>{storeById(c.storeId).short} ↗</button>
        ))}
      </div>
    </div>
  );
}

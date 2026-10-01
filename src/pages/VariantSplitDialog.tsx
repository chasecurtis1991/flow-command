import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { adminUrl, invalidateCatalog, invalidateInventory, loadPresence, money, storeById, type CatalogProduct, type StoreId } from "../lib/shopify";
import { prepareVariantSplit, releaseVariantSplit, splitProductVariant, type SplitPreview, type SplitResult } from "../lib/variantSplit";
import { ErrorState, LoadingState, Pill } from "../components/ui";

type RowState = { result?: SplitResult; error?: string };

export function VariantSplitDialog({ product, storeId, onClose }: { product: CatalogProduct; storeId: StoreId; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.showModal();
    return () => { mounted.current = false; stop.current = true; el.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let planId: string | undefined;
    setError(null);
    setPreview(null);
    void prepareVariantSplit(storeId, product.id).then((p) => {
      if (cancelled) { void releaseVariantSplit(p.planId).catch(() => {}); return; }
      planId = p.planId;
      setPreview(p);
    }).catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; if (planId) void releaseVariantSplit(planId).catch(() => {}); };
  }, [storeId, product.id, attempt]);

  const successful = Object.values(rows).filter((r) => r.result).length;
  const failed = Object.values(rows).filter((r) => r.error).length;
  const remaining = (preview?.variants.length ?? 0) - successful;
  const needsReview = Object.values(rows).filter((r) => r.result?.warnings.length).length;

  async function run() {
    if (!preview || busyRef.current) return;
    busyRef.current = true;
    stop.current = false;
    setBusy(true);
    setStopping(false);
    setStarted(true);
    setRows((previous) => Object.fromEntries(Object.entries(previous).filter(([, row]) => row.result)));
    try {
      for (const v of preview.variants) {
        if (stop.current || !mounted.current) break;
        if (rows[v.id]?.result) continue;
        setCurrent(v.id);
        setRows((r) => ({ ...r, [v.id]: {} }));
        try {
          const result = await splitProductVariant(preview.planId, v.id);
          if (mounted.current) setRows((r) => ({ ...r, [v.id]: { result } }));
        } catch (e) {
          if (mounted.current) setRows((r) => ({ ...r, [v.id]: { error: String(e) } }));
        }
      }
    } finally {
      busyRef.current = false;
      invalidateCatalog();
      invalidateInventory();
      void loadPresence(storeId, true);
      if (mounted.current) { setBusy(false); setCurrent(null); setStopping(false); }
    }
  }

  return (
    <dialog ref={dialog} className="dialog split-dialog" aria-labelledby="split-title" aria-describedby="split-description"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <div className="sheet-head">
        <div className="split-heading">
          <div><div className="split-eyebrow">{storeById(storeId).label} · Catalog</div><h2 id="split-title">Split variants into products</h2></div>
          <Pill kind="neutral" dot={false}>Drafts · 0 stock</Pill>
        </div>
        <p id="split-description" className="split-intro">One separate product per variant of <strong>{product.title}</strong>. The original product stays intact.</p>
      </div>
      <div className="split-body">
        {error ? <ErrorState title="Couldn’t prepare this split" why={error} actions={<button className="btn btn-secondary" onClick={() => setAttempt((v) => v + 1)}>Retry preview</button>} /> : !preview ? <LoadingState label="Reading variants, photos, metafields and locations…" /> : <>
          <div className="split-summary">
            <div><strong>{preview.variants.length}</strong><span>variants to separate</span></div>
            <div><strong>Draft</strong><span>every product</span></div>
            <div title={preview.locations.join(", ")}><strong>0 stock</strong><span>across {preview.locations.length} locations</span></div>
          </div>
          <p className="split-copy">Keeps prices, SKUs, photos, product and variant metafields, descriptions, tags, options, and available shipping details.</p>
          <p className="split-copy">Each source SKU is copied exactly. Missing SKUs stay blank.</p>
          <details className="split-notes">
            <summary>Copy details and limitations</summary>
            <p>The variant photo becomes the cover; the full gallery is retained. Each copy gets a new product ID and URL, with inventory tracking enabled. Product metafields stay on the product; variant metafields stay on its single variant. Manual collections, category, vendor, SEO, template, costs, barcodes, tax settings, and customs details are copied when available.</p>
            <p>Store-currency prices are copied. Market/B2B price lists, translations, subscriptions, custom shipping profiles, option-to-metafield links, app-owned data that Shopify hides, sales history, and channel publishing are not copied. Automatic collections follow their rules. Any metafields Shopify refuses to copy are listed in the result.</p>
            <p>Copies from a previous split are reused as they are. Retrying never resets changes you made to those products.</p>
          </details>
          {preview.warnings.length > 0 && <ul className="split-warning">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {started && <div className="split-progress" role="status" aria-live="polite">
            <span>{busy ? stopping ? "Stopping after the current variant…" : `Processing ${successful + failed + 1} of ${preview.variants.length}…` : remaining === 0 ? "Split complete" : "Ready to continue"}</span>
            <span>{successful} finished{failed > 0 ? ` · ${failed} failed` : ""}{needsReview > 0 ? ` · ${needsReview} with notes` : ""}</span>
            <progress value={successful + failed} max={preview.variants.length} />
          </div>}
          <table className="split-table">
            <thead><tr><th>New product</th><th>Price</th><th>{started ? "Result" : "Stock"}</th></tr></thead>
            <tbody>{preview.variants.map((v) => {
              const row = rows[v.id];
              const result = row?.result;
              return <tr key={v.id}>
                <td><div className="split-product">
                  {v.imageUrl ? <img src={v.imageUrl} alt="" /> : <span className="split-photo-placeholder" />}
                  <div><strong>{v.title}</strong><span className="split-sku">Source SKU: {v.sku || "Not set"}</span></div>
                </div>
                  {row?.error && <div className="split-error" role="alert">{row.error}<div>A draft may already exist; retry checks for it before creating another.</div></div>}
                  {result && result.warnings.length > 0 && <details className="split-warning"><summary>{result.warnings.length} copy notes</summary><ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
                </td>
                <td className="num">{money(`${v.price} ${v.currency}`)}{v.compareAtPrice && <del className="split-compare">{money(`${v.compareAtPrice} ${v.currency}`)}</del>}</td>
                <td>{current === v.id ? <Pill kind="amber" sm>Creating…</Pill> : result ? <button className="btn btn-control" title={`Open ${result.title} in Shopify`} onClick={() => void openUrl(adminUrl(storeId, result.productId))}>{result.existing ? "Already split" : "Draft created"} ↗</button> : row?.error ? <Pill kind="red" sm>Failed</Pill> : <span className="mute">{started ? "Waiting" : "0 everywhere"}</span>}</td>
              </tr>;
            })}</tbody>
          </table>
        </>}
      </div>
      <div className="sheet-foot split-foot">
        <span className="mute">{busy ? "Keep Flow Command open while the split runs." : started ? "Completed copies are remembered when you retry." : "Nothing is published or removed."}</span>
        {busy ? <button className="btn btn-secondary" disabled={stopping} onClick={() => { stop.current = true; setStopping(true); }}>Stop after current</button> : <>
          <button className="btn btn-secondary" onClick={onClose}>{started ? "Done" : "Cancel"}</button>
          {preview && remaining > 0 && <button className="btn btn-primary" onClick={() => void run()}>{started ? `Retry / continue (${remaining})` : `Create ${preview.variants.length} drafts`}</button>}
        </>}
      </div>
    </dialog>
  );
}

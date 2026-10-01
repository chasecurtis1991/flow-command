import { useEffect, useMemo, useRef, useState } from "react";
import { ADJUST_REASONS, adjustInventory, invalidateInventory, storeById, type AdjustResult, type InventoryVariant, type StoreId } from "../lib/shopify";
import { Pill } from "../components/ui";

type Mode = "by" | "count";

/** Review-then-apply stock adjustment for one variant at one location (Shopify `available`, relative delta). */
export function AdjustDialog({ variant, productTitle, storeId, onClose }: { variant: InventoryVariant; productTitle: string; storeId: StoreId; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const levels = variant.levels.filter((l) => l.locationId);
  const [locationId, setLocationId] = useState(levels[0]?.locationId ?? "");
  const [mode, setMode] = useState<Mode>("by");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("correction");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdjustResult | null>(null);

  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.showModal();
    amountRef.current?.focus(); // showModal focuses the first control (Location); the count is what you type
    return () => { el.close(); previous?.focus(); };
  }, []);

  const level = levels.find((l) => l.locationId === locationId);
  const n = /^[+-]?\d+$/.test(amount.trim()) ? parseInt(amount.trim(), 10) : null;
  const delta = n === null || !level ? null : mode === "by" ? n : n - level.available;
  const valid = delta !== null && delta !== 0 && (mode === "by" || (n ?? -1) >= 0);
  // One key per reviewed proposal: editing anything mints a new one; retrying the same proposal reuses it so Shopify dedupes.
  const key = useMemo(() => crypto.randomUUID(), [locationId, delta, reason]);
  const label = `${productTitle}${variant.variantTitle ? ` · ${variant.variantTitle}` : ""}`;
  const stale = !!error?.startsWith("The count changed");
  const signed = (d: number) => (d > 0 ? `+${d}` : `${d}`);

  async function apply() {
    if (!valid || !level || !variant.inventoryItemId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      setResult(await adjustInventory({ storeId, inventoryItemId: variant.inventoryItemId, locationId, delta: delta!, reason, changeFrom: level.available, idempotencyKey: key }));
      invalidateInventory();
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const switchMode = (m: Mode) => { setMode(m); setAmount(""); amountRef.current?.focus(); setReason(m === "count" ? "cycle_count_available" : "correction"); };

  return (
    <dialog ref={dialog} className="dialog split-dialog adjust-dialog" aria-labelledby="adjust-title"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <div className="sheet-head">
        <div className="split-heading">
          <div><div className="split-eyebrow">{storeById(storeId).label} · Inventory</div><h2 id="adjust-title">Adjust stock</h2></div>
          <Pill kind="neutral" dot={false}>Writes to Shopify</Pill>
        </div>
        <p className="split-intro"><strong>{label}</strong>{variant.sku && <span className="mono mute"> · {variant.sku}</span>}</p>
      </div>
      {result ? (
        <div className="adjust-body" role="status">
          <div className="adjust-preview">
            <div><span className="label">Applied</span><strong>{signed(result.delta)}</strong></div>
            <div><span className="label">Available now</span><strong>{result.available}</strong></div>
            <div><span className="label">On hand now</span><strong>{result.onHand}</strong></div>
          </div>
          <p className="mute" style={{ margin: 0, fontSize: 12 }}>Counts re-read from Shopify after the write. Inventory is refreshing.</p>
        </div>
      ) : levels.length === 0 ? (
        <div className="adjust-body"><p className="mute" style={{ margin: 0 }}>No location levels loaded for this variant — sync inventory (needs read_inventory + read_locations) and try again.</p></div>
      ) : (
        <div className="adjust-body">
          <div className="sheet-body" style={{ padding: 0 }}>
            <label className="field">Location
              <select className="input input-dark" value={locationId} disabled={busy || levels.length < 2} onChange={(e) => setLocationId(e.target.value)}>
                {levels.map((l) => <option key={l.locationId} value={l.locationId}>{l.location}</option>)}
              </select>
            </label>
            <label className="field">Reason
              <select className="input input-dark" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}>
                {ADJUST_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <div className="field">Enter
              <div className="seg-sm dark" role="radiogroup" aria-label="Adjustment type">
                <button type="button" role="radio" aria-checked={mode === "by"} className={`seg-sm-item${mode === "by" ? " active" : ""}`} disabled={busy} onClick={() => switchMode("by")}>Change by ±</button>
                <button type="button" role="radio" aria-checked={mode === "count"} className={`seg-sm-item${mode === "count" ? " active" : ""}`} disabled={busy} onClick={() => switchMode("count")}>Counted available</button>
              </div>
            </div>
            <label className="field">{mode === "by" ? "Units (−2 removes two)" : "Available units counted"}
              <input ref={amountRef} className="input input-dark num" inputMode="numeric" placeholder={mode === "by" ? "-2" : String(level?.available ?? 0)} value={amount} disabled={busy}
                onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void apply()} />
            </label>
          </div>
          {level && <div className="adjust-preview">
            <div><span className="label">Available</span><strong>{level.available}{delta ? <> → <span style={{ color: delta < 0 ? "var(--amber)" : "var(--green)" }}>{level.available + delta}</span></> : null}</strong></div>
            <div><span className="label">On hand</span><strong>{level.onHand}{delta ? <> → {level.onHand + delta}</> : null}</strong></div>
            <div><span className="label">Change</span><strong>{delta ? signed(delta) : "—"}</strong></div>
          </div>}
          {mode === "count" && n !== null && delta === 0 && <p className="mute" style={{ margin: 0, fontSize: 12 }}>Count matches Shopify — nothing to change.</p>}
          {error && <div className="split-error" role="alert">{error}{stale ? null : <div>Retrying this exact change is safe — Shopify ignores a repeat of the same request.</div>}</div>}
        </div>
      )}
      <div className="sheet-foot">
        {result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
          {stale ? <button className="btn btn-primary" onClick={() => { invalidateInventory(); onClose(); }}>Sync &amp; close</button>
            : levels.length > 0 && <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void apply()}>
              {busy ? "Applying…" : error ? "Retry" : delta ? `Apply ${signed(delta)}` : "Apply"}
            </button>}
        </>}
      </div>
    </dialog>
  );
}

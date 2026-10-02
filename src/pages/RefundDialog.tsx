import { useEffect, useMemo, useRef, useState } from "react";
import { type LineQty, type RefundInfo, type RefundPreview, type StoreId, createRefund, getRefundInfo, money, previewRefund, storeById } from "../lib/shopify";
import { ErrorState, LoadingState, Pill } from "../components/ui";

const GATEWAY: Record<string, string> = { shopify_payments: "Shopify Payments", paypal: "PayPal", manual: "Manual payment", cash: "Cash" };
const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;
const gateway = (g: string) => GATEWAY[g] ?? g.replace(/_/g, " ");

/** Pick items/shipping → Shopify calculates the refund → confirm the exact amount → refund to the original payment method. */
export function RefundDialog({ store, orderId, onClose, onDone }: { store: StoreId; orderId: string; onClose: () => void; onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [pinned] = useState(store); // a store switch can't retarget this refund
  const [info, setInfo] = useState<RefundInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [shipping, setShipping] = useState(false);
  const [restock, setRestock] = useState(true);
  const [location, setLocation] = useState("");
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RefundPreview | null>(null);

  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.showModal();
    return () => { el.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    getRefundInfo(pinned, orderId).then((i) => { setInfo(i); setLocation(i.defaultLocationId ?? i.locations[0]?.id ?? ""); }).catch((e) => setLoadError(String(e)));
  }, [pinned, orderId]);

  const rows = (info?.lines ?? []).map((l) => {
    const raw = (qty[l.id] ?? "").trim(), n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    return { l, n: Number.isNaN(n) ? 0 : n, problem: raw === "" || n === 0 ? null : Number.isNaN(n) ? "Whole number" : n > l.refundable ? `Max ${l.refundable}` : null };
  });
  const lines: LineQty[] = rows.filter((r) => r.n > 0 && !r.problem).map((r) => ({ lineItemId: r.l.id, quantity: r.n }));
  const linesKey = JSON.stringify(lines);
  const valid = rows.every((r) => !r.problem) && (lines.length > 0 || shipping);

  // Ask Shopify for the exact refund whenever the selection changes (debounced); any change also cancels a pending confirm.
  useEffect(() => {
    setConfirming(false);
    if (!info || !valid) { setPreview(null); return; }
    let alive = true;
    setPreviewing(true);
    const t = window.setTimeout(() => {
      previewRefund(pinned, orderId, lines, shipping)
        .then((p) => { if (alive) { setPreview(p); setError(null); } })
        .catch((e) => { if (alive) { setPreview(null); setError(String(e)); } })
        .finally(() => alive && setPreviewing(false));
    }, 300);
    return () => { alive = false; window.clearTimeout(t); };
  }, [linesKey, shipping, info, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // One key per confirmed proposal; retrying the same one reuses it so Shopify can't refund twice.
  const key = useMemo(() => crypto.randomUUID(), [linesKey, shipping, restock, location, notify, note, preview?.amount]);
  const amount = preview ? money(`${preview.amount} ${preview.currency}`) : "—";
  const canRefund = !!preview && Number(preview.amount) > 0 && !previewing;
  const stale = !!error && /changed to|Reload the order/.test(error);

  async function submit() {
    if (!preview || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const r = await createRefund({
        storeId: pinned, orderId, lines, refundShipping: shipping, restock: restock && lines.length > 0, locationId: restock ? location : undefined,
        notify, note: note.trim() || undefined, expectedAmount: preview.amount, idempotencyKey: key,
      });
      setDone(r);
      onDone();
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const refundAll = () => setQty(Object.fromEntries((info?.lines ?? []).map((l) => [l.id, String(l.refundable)])));
  const nothingLeft = !!info && info.lines.every((l) => l.refundable === 0);

  return (
    <dialog ref={dialog} className="dialog split-dialog adjust-dialog stock-dialog" aria-labelledby="refund-title"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <div className="sheet-head">
        <div className="split-heading">
          <div><div className="split-eyebrow">{storeById(pinned).label} · {info?.name ?? "Order"}</div><h2 id="refund-title">Refund</h2></div>
          <Pill kind="amber" dot={false}>Moves money</Pill>
        </div>
        {info && !done && <p className="split-intro">Refunds go back to the original payment method. Already refunded on this order: {money(info.refunded)}.</p>}
      </div>
      {loadError ? <div className="adjust-body"><ErrorState title="Couldn’t load the order" why={loadError.slice(0, 200)} /></div>
        : !info ? <div className="adjust-body"><LoadingState label="Loading order…" /></div>
        : done ? (
          <div className="adjust-body" role="status">
            <p style={{ margin: 0 }}>Refunded <strong>{money(`${done.amount} ${done.currency}`)}</strong>{done.gateways.length ? ` to ${done.gateways.map(gateway).join(" + ")}` : ""}.
              {notify ? " Shopify will email the customer." : " The customer wasn’t notified."}</p>
          </div>
        ) : nothingLeft && !shipping ? (
          <div className="adjust-body"><p className="mute" style={{ margin: 0 }}>Every item on this order has already been refunded. Shipping can still be refunded below if it wasn’t.</p>
            <label className="check-row"><input type="checkbox" checked={shipping} onChange={(e) => setShipping(e.target.checked)} /> Refund shipping</label></div>
        ) : (
          <div className="adjust-body">
            <table className="split-table stock-table">
              <thead><tr><th>Item</th><th className="r">Price</th><th className="r">Refundable</th><th className="r">Refund</th></tr></thead>
              <tbody>{rows.map(({ l, problem }) => (
                <tr key={l.id}>
                  <td><div className="ellip">{l.title}</div>{l.sku && <div className="mono mute" style={{ fontSize: 11 }}>{l.sku}</div>}
                    {problem && <div className="split-error" style={{ marginTop: 2 }}>{problem}</div>}</td>
                  <td className="r num">{money(l.unitPrice)}</td>
                  <td className="r num mute">{l.refundable} of {l.quantity}</td>
                  <td className="r"><input className="input input-dark num stock-qty" inputMode="numeric" placeholder="0" value={qty[l.id] ?? ""} disabled={busy || l.refundable === 0}
                    aria-label={`Quantity to refund for ${l.title}`} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} /></td>
                </tr>
              ))}</tbody>
            </table>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn btn-control btn-sm" disabled={busy} onClick={refundAll}>Refund all items</button>
              <label className="check-row"><input type="checkbox" checked={shipping} disabled={busy} onChange={(e) => setShipping(e.target.checked)} /> Refund shipping</label>
              <label className="check-row"><input type="checkbox" checked={restock} disabled={busy} onChange={(e) => setRestock(e.target.checked)} /> Restock items</label>
              {restock && info.locations.length > 1 && (
                <select className="input input-dark" style={{ height: 28 }} value={location} disabled={busy} aria-label="Restock location" onChange={(e) => setLocation(e.target.value)}>
                  {info.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
            </div>
            <div className="sheet-body" style={{ padding: 0 }}>
              <label className="field">Reason / note (optional, staff only)<input className="input input-dark" value={note} disabled={busy} placeholder="Damaged in transit" onChange={(e) => setNote(e.target.value)} /></label>
              <label className="check-row" style={{ alignSelf: "end", paddingBottom: 6 }}><input type="checkbox" checked={notify} disabled={busy} onChange={(e) => setNotify(e.target.checked)} /> Email the customer a refund notice</label>
            </div>
            <div className="refund-summary">
              <span>Items</span><span className="r num">{preview ? money(`${preview.subtotal} ${preview.currency}`) : "—"}</span>
              <span>Tax</span><span className="r num">{preview ? money(`${preview.tax} ${preview.currency}`) : "—"}</span>
              <span>Shipping</span><span className="r num">{preview ? money(`${preview.shipping} ${preview.currency}`) : "—"}</span>
              <span className="total">Refund total</span><span className="total r num">{previewing ? "Calculating…" : amount}</span>
              {preview && preview.gateways.length > 0 && <span className="mute" style={{ gridColumn: "1 / -1", fontSize: 11.5 }}>Back to {preview.gateways.map(gateway).join(" + ")} · calculated by Shopify</span>}
            </div>
            {error && <div className="split-error" role="alert" style={{ marginTop: 0 }}>{error}</div>}
            {confirming && preview && <div className="fulfill-warn" role="alert" style={{ margin: 0 }}>Refund <strong>{amount}</strong> to {preview.gateways.map(gateway).join(" + ") || "the customer"}? This can’t be undone.</div>}
          </div>
        )}
      <div className="sheet-foot">
        {done || loadError ? <button className="btn btn-primary" onClick={onClose}>{done ? "Done" : "Close"}</button> : <>
          <span className="mute" style={{ fontSize: 12, marginRight: "auto", alignSelf: "center" }}>{lines.length ? units(lines.reduce((a, l) => a + l.quantity, 0)) : shipping ? "Shipping only" : "Choose what to refund"}</span>
          <button className="btn btn-secondary" disabled={busy} onClick={confirming ? () => setConfirming(false) : onClose}>{confirming ? "Back" : "Cancel"}</button>
          {stale && !confirming ? <button className="btn btn-secondary" onClick={() => { setError(null); setQty({}); setInfo(null); getRefundInfo(pinned, orderId).then(setInfo).catch((e) => setLoadError(String(e))); }}>Reload order</button> : null}
          {confirming
            ? <button className="btn btn-danger" disabled={busy || !canRefund} onClick={() => void submit()}>{busy ? "Refunding…" : `Confirm refund ${amount}`}</button>
            : <button className="btn btn-primary" disabled={!valid || !canRefund || busy} onClick={() => setConfirming(true)}>{canRefund ? `Refund ${amount}…` : "Refund"}</button>}
        </>}
      </div>
    </dialog>
  );
}

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type FulfillmentInfo, type StoreId, fmtCreated, fulfillOrder, fulfillable, getFulfillment, storeById } from "../lib/shopify";
import { Pill } from "../components/ui";

const CARRIERS = ["USPS", "UPS", "FedEx", "DHL Express"]; // Shopify builds tracking links for these; "Other" takes a URL
const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
const tone = (s: string) => (s === "DELIVERED" ? "green" : s === "FAILURE" || s === "CANCELLED" || s === "ERROR" ? "red" : "neutral");

/** Shipments (usually created by ShipStation) plus a manual Fulfill for orders shipped outside it. */
export function OrderFulfillment({ store, orderId, onChanged, autoOpen = 0 }: { store: StoreId; orderId: string; onChanged: () => void; autoOpen?: number }) {
  const [info, setInfo] = useState<FulfillmentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setInfo(null); setError(null);
    getFulfillment(store, orderId).then((i) => alive && setInfo(i)).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [store, orderId, reloadKey]);

  const ready = fulfillable(info);
  // ?open=fulfill (autoOpen is a fresh number per command): open the form once the data is in, if anything is left to ship.
  const auto = useRef(0);
  useEffect(() => { if (autoOpen) auto.current = autoOpen; }, [autoOpen]);
  useEffect(() => { if (auto.current && info) { auto.current = 0; if (fulfillable(info).length) setOpen(true); } }, [info, autoOpen]);
  return (
    <div className="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="label" style={{ marginBottom: 0 }}>Shipments</span>
        {ready.length > 0 && <button className="btn btn-control btn-sm" onClick={() => setOpen(true)}>Fulfill…</button>}
      </div>
      {error ? <div className="mute" style={{ fontSize: 12 }}>Couldn’t load shipments · {error.slice(0, 140)}</div>
        : !info ? <div className="mute" style={{ fontSize: 12 }}>Loading…</div>
        : info.shipments.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>{ready.length ? "Nothing shipped yet." : "No shipments."}</div>
        : info.shipments.map((s) => (
          <div key={s.id} className="shipment">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Pill kind={tone(s.status)} sm>{nice(s.status)}</Pill>
              <span className="mute" style={{ fontSize: 11.5 }}>{fmtCreated(s.createdAt)}</span>
            </div>
            {s.tracking.map((t, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                {t.company ?? "Tracking"}{" "}
                {t.url ? <button className="link-btn mono" onClick={() => void openUrl(t.url!)}>{t.number ?? "link"} ↗</button> : <span className="mono">{t.number}</span>}
              </div>
            ))}
            <div className="mute" style={{ fontSize: 11.5 }}>{s.items.join(" · ")}</div>
          </div>
        ))}
      {open && info && <FulfillDialog store={store} orderId={orderId} info={info} onClose={() => setOpen(false)}
        onDone={(i) => { setInfo(i); onChanged(); }} onReload={() => { setReloadKey((k) => k + 1); onChanged(); }} />}
    </div>
  );
}

function FulfillDialog({ store, orderId, info, onClose, onDone, onReload }: {
  store: StoreId; orderId: string; info: FulfillmentInfo; onClose: () => void; onDone: (i: FulfillmentInfo) => void; onReload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [pinned] = useState(store); // a store switch can't retarget this write
  const options = fulfillable(info);
  const [foId, setFoId] = useState(options[0]?.id ?? "");
  const fo = options.find((f) => f.id === foId);
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries((fo?.lines ?? []).map((l) => [l.id, String(l.remaining)])));
  const [carrier, setCarrier] = useState("USPS");
  const [other, setOther] = useState("");
  const [number, setNumber] = useState("");
  const [url, setUrl] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null); // units shipped, captured before the refreshed info empties the form

  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.showModal();
    return () => { el.close(); previous?.focus(); };
  }, []);

  const pickFo = (id: string) => { setFoId(id); setQty(Object.fromEntries((options.find((f) => f.id === id)?.lines ?? []).map((l) => [l.id, String(l.remaining)]))); };
  const lines = (fo?.lines ?? []).filter((l) => l.remaining > 0).map((l) => {
    const raw = (qty[l.id] ?? "").trim(), n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    return { l, n, problem: raw === "" || n === 0 ? null : Number.isNaN(n) ? "Whole number" : n > l.remaining ? `Max ${l.remaining}` : null };
  });
  const picked = lines.filter((x) => x.n > 0 && !x.problem);
  const units = picked.reduce((a, x) => a + x.n, 0);
  const valid = !!fo && picked.length > 0 && lines.every((x) => !x.problem) && (carrier !== "Other" || !number.trim() || url.trim().startsWith("http"));
  const reload = !!error && /Reload the order/.test(error);

  async function submit() {
    if (!valid || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const company = carrier === "Other" ? other.trim() : carrier;
      const i = await fulfillOrder({
        storeId: pinned, orderId, fulfillmentOrderId: fo!.id, lines: picked.map((x) => ({ id: x.l.id, quantity: x.n })), notifyCustomer: notify,
        trackingNumber: number.trim() || undefined, trackingCompany: number.trim() && company ? company : undefined, trackingUrl: carrier === "Other" && url.trim() ? url.trim() : undefined,
      });
      setDone(units);
      onDone(i);
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog split-dialog adjust-dialog stock-dialog" aria-labelledby="fulfill-title"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <div className="sheet-head">
        <div className="split-heading">
          <div><div className="split-eyebrow">{storeById(pinned).label} · Orders</div><h2 id="fulfill-title">Fulfill items</h2></div>
          <Pill kind="neutral" dot={false}>Writes to Shopify</Pill>
        </div>
        {done === null && <p className="fulfill-warn">ShipStation normally fulfills orders. Only use this for items shipped or handed over outside ShipStation — otherwise they’ll show as shipped there too.</p>}
      </div>
      {done !== null ? (
        <div className="adjust-body" role="status"><p style={{ margin: 0 }}>Fulfilled {done} unit{done === 1 ? "" : "s"}.{notify ? " Shopify will email the customer." : " The customer wasn’t notified."}</p></div>
      ) : (
        <div className="adjust-body">
          {options.length > 1 && <label className="field">Ship from
            <select className="input input-dark" value={foId} disabled={busy} onChange={(e) => pickFo(e.target.value)}>
              {options.map((f) => <option key={f.id} value={f.id}>{f.location ?? "Unknown location"} · {f.lines.reduce((a, l) => a + l.remaining, 0)} left</option>)}
            </select>
          </label>}
          <table className="split-table stock-table">
            <thead><tr><th>Item</th><th className="r">Left</th><th className="r">Ship</th></tr></thead>
            <tbody>{lines.map(({ l, problem }) => (
              <tr key={l.id}>
                <td><div className="ellip">{l.title}</div>{l.sku && <div className="mono mute" style={{ fontSize: 11 }}>{l.sku}</div>}
                  {problem && <div className="split-error" style={{ marginTop: 2 }}>{problem}</div>}</td>
                <td className="r num mute">{l.remaining} of {l.total}</td>
                <td className="r"><input className="input input-dark num stock-qty" inputMode="numeric" value={qty[l.id] ?? ""} disabled={busy} aria-label={`Quantity to ship for ${l.title}`}
                  onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} /></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="sheet-body" style={{ padding: 0 }}>
            <label className="field">Carrier
              <select className="input input-dark" value={carrier} disabled={busy} onChange={(e) => setCarrier(e.target.value)}>
                {[...CARRIERS, "Other"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="field">Tracking number (optional)
              <input className="input input-dark mono" value={number} disabled={busy} placeholder="Leave blank for pickup / hand delivery" onChange={(e) => setNumber(e.target.value)} />
            </label>
            {carrier === "Other" && <>
              <label className="field">Carrier name<input className="input input-dark" value={other} disabled={busy} onChange={(e) => setOther(e.target.value)} /></label>
              <label className="field">Tracking URL<input className="input input-dark" value={url} disabled={busy} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></label>
            </>}
          </div>
          <label className="check-row"><input type="checkbox" checked={notify} disabled={busy} onChange={(e) => setNotify(e.target.checked)} /> Notify customer (Shopify sends the shipping confirmation email)</label>
          {error && <div className="split-error" role="alert" style={{ marginTop: 0 }}>{error}</div>}
        </div>
      )}
      <div className="sheet-foot">
        {done !== null ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
          <span className="mute" style={{ fontSize: 12, marginRight: "auto", alignSelf: "center" }}>{units ? `${picked.length} item${picked.length === 1 ? "" : "s"} · ${units} units` : "Set quantities to ship"}</span>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
          {reload ? <button className="btn btn-primary" onClick={() => { onClose(); onReload(); }}>Close &amp; reload</button>
            : <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? "Fulfilling…" : error ? "Retry" : `Fulfill ${units || ""}`.trim()}</button>}
        </>}
      </div>
    </dialog>
  );
}

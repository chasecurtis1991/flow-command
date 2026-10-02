import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { adjustInventory, adminUrl, invalidateInventory, inventoryLocations, storeById, transferInventory, type InventoryVariant, type LevelAfter, type StockChange, type StoreId, type TransferResult } from "../lib/shopify";
import { Pill } from "../components/ui";

export type MoveMode = "receive" | "transfer";
type Line = { v: InventoryVariant; qty: string };

const label = (v: InventoryVariant) => `${v.productTitle}${v.variantTitle ? ` · ${v.variantTitle}` : ""}`;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `T-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/** Multi-line Receive (+N at one location) or Transfer (−N at one location, +N at another), applied as one all-or-nothing Shopify write. */
export function StockMoveDialog({ mode, storeId, variants, onClose }: { mode: MoveMode; storeId: StoreId; variants: InventoryVariant[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const locations = useMemo(() => inventoryLocations(variants), [variants]);
  const [from, setFrom] = useState(locations[0]?.id ?? "");
  const [to, setTo] = useState(locations[1]?.id ?? "");
  const [reference, setReference] = useState(() => (mode === "transfer" ? stamp() : ""));
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LevelAfter[] | null>(null);
  const [transfer, setTransfer] = useState<TransferResult | null>(null);
  const [receiveNow, setReceiveNow] = useState(true); // transfer: "Move now" vs leave "In transit"
  const [trackCompany, setTrackCompany] = useState("");
  const [trackNumber, setTrackNumber] = useState("");

  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.showModal();
    searchRef.current?.focus();
    return () => { el.close(); previous?.focus(); };
  }, []);

  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "—";
  const level = (v: InventoryVariant, loc: string) => v.levels.find((l) => l.locationId === loc);
  const s = q.trim().toLowerCase();
  const matches = s ? variants.filter((v) => v.tracked && v.inventoryItemId && !lines.some((l) => l.v.id === v.id)
    && `${label(v)} ${v.sku ?? ""}`.toLowerCase().includes(s)).slice(0, 8) : [];

  // Per line: parsed qty and the reason it can't be applied, if any.
  const checked = lines.map((l) => {
    const n = /^\d+$/.test(l.qty.trim()) ? parseInt(l.qty.trim(), 10) : 0;
    const src = level(l.v, from), dst = mode === "transfer" ? level(l.v, to) : undefined;
    const problem = !src ? `Not stocked at ${name(from)}` : mode === "transfer" && !dst ? `Not stocked at ${name(to)}`
      : n <= 0 ? "Enter a quantity" : mode === "transfer" && n > src.available ? `Only ${src.available} available at ${name(from)}` : null;
    return { ...l, n, src, dst, problem };
  });
  const sameLoc = mode === "transfer" && from === to;
  const valid = lines.length > 0 && !sameLoc && checked.every((c) => !c.problem);
  const changes: StockChange[] = valid ? checked.flatMap((c) => mode === "receive"
    ? [{ inventoryItemId: c.v.inventoryItemId!, locationId: from, delta: c.n, changeFrom: c.src!.available }]
    : [{ inventoryItemId: c.v.inventoryItemId!, locationId: from, delta: -c.n, changeFrom: c.src!.available },
       { inventoryItemId: c.v.inventoryItemId!, locationId: to, delta: c.n, changeFrom: c.dst!.available }]) : [];
  // One key per reviewed proposal; any edit mints a new one, a retry of the same proposal reuses it so Shopify dedupes.
  const key = useMemo(() => crypto.randomUUID(), [JSON.stringify(changes), reference, receiveNow, trackCompany, trackNumber]); // eslint-disable-line react-hooks/exhaustive-deps
  const units = checked.reduce((a, c) => a + c.n, 0);
  const stale = !!error?.includes("The count changed");

  const add = (v: InventoryVariant) => { setLines((ls) => [...ls, { v, qty: "" }]); setQ(""); searchRef.current?.focus(); };
  const setQty = (id: string, qty: string) => setLines((ls) => ls.map((l) => (l.v.id === id ? { ...l, qty } : l)));

  async function apply() {
    if (!valid || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (mode === "receive") {
        setResult(await adjustInventory({ storeId, reason: "received", changes, idempotencyKey: key, kind: "receive", reference: reference.trim() || undefined }));
      } else {
        const t = await transferInventory({
          storeId, originLocationId: from, destinationLocationId: to, idempotencyKey: key, receiveNow, reference: reference.trim() || undefined,
          lines: checked.map((c) => ({ inventoryItemId: c.v.inventoryItemId!, quantity: c.n })),
          trackingCompany: receiveNow ? undefined : trackCompany.trim() || undefined, trackingNumber: receiveNow ? undefined : trackNumber.trim() || undefined,
        });
        setTransfer(t);
        setResult(t.levels);
      }
      invalidateInventory();
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const after = (v: InventoryVariant, loc: string) => result?.find((r) => r.inventoryItemId === v.inventoryItemId && r.locationId === loc);
  const title = mode === "receive" ? "Receive stock" : "Transfer stock";

  return (
    <dialog ref={dialog} className="dialog split-dialog adjust-dialog stock-dialog" aria-labelledby="move-title"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <div className="sheet-head">
        <div className="split-heading">
          <div><div className="split-eyebrow">{storeById(storeId).label} · Inventory</div><h2 id="move-title">{title}</h2></div>
          <Pill kind="neutral" dot={false}>Writes to Shopify</Pill>
        </div>
        <p className="split-intro">{mode === "receive" ? "Adds units to available stock at one location (reason: Received)." : "Creates a Shopify Transfer (Products → Transfers). Move now ships and receives it at once; In transit leaves it for the destination to receive in Shopify."}</p>
      </div>
      {mode === "transfer" && locations.length < 2 ? (
        <div className="adjust-body"><p className="mute" style={{ margin: 0 }}>{storeById(storeId).label} stocks items at {locations.length ? `one location (${locations[0].name})` : "no locations"}, so there's nowhere to transfer to.</p></div>
      ) : (
        <div className="adjust-body">
          <div className="sheet-body" style={{ padding: 0, gridTemplateColumns: mode === "transfer" ? "1fr 1fr 1fr" : "1fr 1fr" }}>
            <label className="field">{mode === "receive" ? "Location" : "From"}
              <select className="input input-dark" value={from} disabled={busy || !!result} onChange={(e) => setFrom(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            {mode === "transfer" && <label className="field">To
              <select className="input input-dark" value={to} disabled={busy || !!result} onChange={(e) => setTo(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>}
            <label className="field">{mode === "receive" ? "Lot / PO / supplier (optional)" : "Reference"}
              <input className="input input-dark mono" value={reference} disabled={busy || !!result} placeholder="FG-24-0918" onChange={(e) => setReference(e.target.value)} />
            </label>
          </div>
          {sameLoc && <div className="split-error" style={{ marginTop: 0 }}>Pick two different locations.</div>}
          {mode === "transfer" && !result && <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="seg-sm dark" role="radiogroup" aria-label="Transfer type">
              <button type="button" role="radio" aria-checked={receiveNow} className={`seg-sm-item${receiveNow ? " active" : ""}`} disabled={busy} onClick={() => setReceiveNow(true)}>Move now</button>
              <button type="button" role="radio" aria-checked={!receiveNow} className={`seg-sm-item${!receiveNow ? " active" : ""}`} disabled={busy} onClick={() => setReceiveNow(false)}>In transit</button>
            </div>
            {!receiveNow && <>
              <input className="input input-dark" style={{ width: 120 }} placeholder="Carrier" aria-label="Carrier" value={trackCompany} disabled={busy} onChange={(e) => setTrackCompany(e.target.value)} />
              <input className="input input-dark mono" style={{ width: 200 }} placeholder="Tracking number (optional)" aria-label="Tracking number" value={trackNumber} disabled={busy} onChange={(e) => setTrackNumber(e.target.value)} />
            </>}
          </div>}
          {!result && <div className="stock-search">
            <input ref={searchRef} className="input input-dark" placeholder="Add an item — search product, variant or SKU" value={q} disabled={busy}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { e.preventDefault(); add(matches[0]); } }} />
            {matches.length > 0 && <div className="stock-results" role="listbox">
              {matches.map((v) => <button key={v.id} type="button" role="option" aria-selected={false} className="stock-result" onClick={() => add(v)}>
                <span className="ellip">{label(v)}</span><span className="mono mute">{v.sku ?? ""}</span><span className="mute num">{level(v, from)?.available ?? "—"} at {name(from)}</span>
              </button>)}
            </div>}
            {s && matches.length === 0 && <div className="mute" style={{ fontSize: 12, padding: "6px 2px" }}>No tracked items match.</div>}
          </div>}
          {lines.length > 0 && <table className="split-table stock-table">
            <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">{name(from)}</th>{mode === "transfer" && <th className="r">{name(to)}</th>}<th /></tr></thead>
            <tbody>{checked.map((c) => {
              const a1 = after(c.v, from), a2 = after(c.v, to);
              return <tr key={c.v.id}>
                <td><div className="ellip">{label(c.v)}</div>{c.v.sku && <div className="mono mute" style={{ fontSize: 11 }}>{c.v.sku}</div>}
                  {c.problem && (c.qty.trim() !== "" || c.problem.startsWith("Not stocked")) && <div className="split-error" style={{ marginTop: 2 }}>{c.problem}</div>}</td>
                <td className="r"><input className="input input-dark num stock-qty" inputMode="numeric" placeholder="0" value={c.qty} disabled={busy || !!result}
                  aria-label={`Quantity for ${label(c.v)}`} onChange={(e) => setQty(c.v.id, e.target.value)} onKeyDown={(e) => e.key === "Enter" && void apply()} /></td>
                <td className="r num">{a1 ? <strong>{a1.available}</strong> : c.src ? <>{c.src.available}{c.n > 0 && <> → <span style={{ color: mode === "receive" ? "var(--green)" : "var(--amber)" }}>{c.src.available + (mode === "receive" ? c.n : -c.n)}</span></>}</> : "—"}</td>
                {mode === "transfer" && <td className="r num">{a2 ? <strong>{a2.available}</strong> : c.dst ? <>{c.dst.available}{c.n > 0 && (receiveNow ? <> → <span style={{ color: "var(--green)" }}>{c.dst.available + c.n}</span></> : <span className="mute"> (+{c.n} incoming)</span>)}</> : "—"}</td>}
                <td className="r">{!result && <button className="icon-btn" aria-label={`Remove ${label(c.v)}`} disabled={busy} onClick={() => setLines((ls) => ls.filter((l) => l.v.id !== c.v.id))}>×</button>}</td>
              </tr>;
            })}</tbody>
          </table>}
          {result && <p className="mute" role="status" style={{ margin: 0, fontSize: 12 }}>
            {transfer ? <>Transfer <button className="link-btn" onClick={() => void openUrl(adminUrl(storeId, transfer.transferId))}>{transfer.name} ↗</button> {transfer.received ? "moved and received." : "is in transit — receive it in Shopify when it arrives."}{" "}</> : "Applied. "}
            Bold counts were re-read from Shopify; Inventory is refreshing.</p>}
          {error && <div className="split-error" role="alert" style={{ marginTop: 0 }}>{error}{!stale && <div>Retrying this exact change is safe — Shopify ignores a repeat of the same request.</div>}</div>}
        </div>
      )}
      <div className="sheet-foot">
        {result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <>
          <span className="mute" style={{ fontSize: 12, marginRight: "auto", alignSelf: "center" }}>{lines.length ? `${lines.length} item${lines.length === 1 ? "" : "s"} · ${units} units` : "Add items to begin"}</span>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
          {stale ? <button className="btn btn-primary" onClick={() => { invalidateInventory(); onClose(); }}>Sync &amp; close</button>
            : !(mode === "transfer" && locations.length < 2) && <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void apply()}>
              {busy ? "Applying…" : error ? "Retry" : `${mode === "receive" ? "Receive" : "Transfer"}${units ? ` ${units}` : ""} units`}
            </button>}
        </>}
      </div>
    </dialog>
  );
}

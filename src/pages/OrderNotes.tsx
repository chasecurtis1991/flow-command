import { useState } from "react";
import { type OrderDetail, type StoreId, updateOrderNoteTags } from "../lib/shopify";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Notes + tags for one order: read view, then an inline editor whose Save sends only what changed. */
export function OrderNotes({ store, data, onSaved, onReload }: {
  store: StoreId; data: OrderDetail;
  onSaved: (v: { note: string | null; tags: string[] }) => void; onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<string[]>([]);
  const [draftTag, setDraftTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<StoreId>(store);

  const start = () => { setNote(data.note ?? ""); setRemoved([]); setAdded([]); setDraftTag(""); setError(null); setPinned(store); setEditing(true); };
  const original = data.note ?? "";
  const noteChanged = note.trimEnd() !== original.trimEnd();
  const pending = draftTag.split(",").map((t) => t.trim()).filter(Boolean); // typed but not yet committed with Enter
  const adds = [...added, ...pending].filter((t, i, a) => a.findIndex((x) => same(x, t)) === i && !data.tags.some((c) => same(c, t)));
  const dirty = noteChanged || adds.length > 0 || removed.length > 0;
  const stale = !!error?.includes("The note changed");

  const commitTags = () => { if (pending.length) { setAdded((a) => [...a, ...pending]); setDraftTag(""); } };
  const toggleRemove = (t: string) => setRemoved((r) => (r.includes(t) ? r.filter((x) => x !== t) : [...r, t]));

  async function save() {
    if (!dirty || busy) return;
    setBusy(true); setError(null);
    try {
      const v = await updateOrderNoteTags({
        storeId: pinned, orderId: data.id, note: noteChanged ? note : null, expectedNote: data.note ?? null, addTags: adds, removeTags: removed,
      });
      onSaved(v);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="detail-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span className="label" style={{ marginBottom: 0 }}>Notes &amp; tags</span>
          <button className="btn btn-control btn-sm" onClick={start}>Edit</button>
        </div>
        {data.tags.length > 0 && <div className="tag-row">{data.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</div>}
        <div className="note-box">{data.note ?? "—"}</div>
      </div>
    );
  }

  const summary = [noteChanged && (note.trim() ? "Note updated" : "Note cleared"), adds.length > 0 && `+${plural(adds.length, "tag")}`, removed.length > 0 && `−${plural(removed.length, "tag")}`].filter(Boolean).join(" · ");
  return (
    <div className="detail-section" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="label" style={{ marginBottom: 0 }}>Notes &amp; tags</span>
      <div className="tag-row">
        {data.tags.map((t) => {
          const off = removed.includes(t);
          return <button key={t} type="button" className={`tag-chip${off ? " removing" : ""}`} disabled={busy} aria-pressed={off}
            title={off ? "Keep this tag" : "Remove this tag"} onClick={() => toggleRemove(t)}>{t} <span aria-hidden="true">{off ? "↺" : "×"}</span></button>;
        })}
        {adds.filter((t) => added.some((a) => same(a, t))).map((t) => (
          <button key={`+${t}`} type="button" className="tag-chip adding" disabled={busy} title="Don't add" onClick={() => setAdded((a) => a.filter((x) => !same(x, t)))}>+ {t} <span aria-hidden="true">×</span></button>
        ))}
        <input className="input input-dark tag-input" placeholder="Add tag…" value={draftTag} disabled={busy} aria-label="Add tag"
          onChange={(e) => setDraftTag(e.target.value)} onBlur={commitTags}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTags(); } }} />
      </div>
      <textarea className="input input-dark note-edit" rows={4} placeholder="Order note (visible to staff in Shopify)" value={note} disabled={busy}
        aria-label="Order note" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) { e.preventDefault(); void save(); } }} />
      {error && <div className="split-error" role="alert" style={{ marginTop: 0 }}>{error}{!stale && <div>Retrying is safe — the same change won't be applied twice.</div>}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mute" style={{ fontSize: 11.5, flex: 1 }}>{summary || "No changes yet"}{dirty && " · tags you didn't touch are kept"}</span>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        {stale ? <button className="btn btn-primary btn-sm" onClick={() => { setEditing(false); onReload(); }}>Reload order</button>
          : <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "Saving…" : error ? "Retry" : "Save to Shopify"}</button>}
      </div>
    </div>
  );
}

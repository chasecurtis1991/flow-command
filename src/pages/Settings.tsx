import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../lib/app";
import { STORES, getCredentials, saveCredentials, storeById, useOrders } from "../lib/shopify";
import { Pill, SampleData, Status } from "../components/ui";

type Creds = { status: "loading" | "saved" | "missing"; clientId?: string };
const mask = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "••••");

export function Settings() {
  const { store, accent, setAccent, density, setDensity, toast } = useApp();
  const cache = useOrders();
  const [creds, setCreds] = useState<Creds>({ status: "loading" });
  const [modal, setModal] = useState(false);
  const [push, setPush] = useState(true);

  const load = useCallback(() => {
    getCredentials().then((c) => setCreds({ status: "saved", clientId: c.clientId })).catch(() => setCreds({ status: "missing" }));
  }, []);
  useEffect(load, [load]);

  const notSaved = creds.status === "missing" ? <Pill kind="amber">Not saved</Pill> : null;
  const activeStatus = cache.status === "data" ? <Status kind="green">Connected</Status>
    : cache.status === "error" ? <Status kind="red">Unreachable</Status> : <Status kind="mute">Checking…</Status>;

  return (
    <section className="screen screen-pad" style={{ padding: "24px 28px 40px", gap: 22, maxWidth: 760 }}>
      <Group title="Shopify credentials">
        <div className="list-row"><span>Client ID</span>{creds.status === "saved" ? <span className="mono sub" style={{ fontSize: 12 }}>{mask(creds.clientId ?? "")}</span> : notSaved}</div>
        <div className="list-row">
          <span>Client secret</span>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="mono sub" style={{ fontSize: 12 }}>••••••••••••••••</span>
            {creds.status === "saved" ? <Pill kind="green">Saved in Keychain</Pill> : notSaved}
          </span>
        </div>
        <div className="list-row"><span>Access tokens</span><span className="value">3 stores · cached 23h · refreshed on demand</span></div>
        <div className="list-row">
          <span className="sub" style={{ fontSize: 12.5 }}>Stored in the macOS Keychain under com.flowgardens.command</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setModal(true)}>Update credentials…</button>
        </div>
      </Group>

      <Group title="Stores">
        {STORES.map((s) => (
          <div key={s.id} className="list-row tall" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 14 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className={`dot d8 ${s.id}`} />
              <span className="two-line"><span style={{ fontWeight: 500 }}>{s.label}</span><span className="second">{s.plan}</span></span>
            </span>
            <span className="mono sub" style={{ fontSize: 12 }}>{s.domain}</span>
            {s.id === store ? activeStatus : <Status kind="mute">Idle</Status>}
          </div>
        ))}
        <div className="list-row"><span>Default store on launch</span><span className="value">{storeById(store).label} ›</span></div>
      </Group>

      <Group title="Sync" extra={<SampleData />}>
        <div className="list-row"><span>Poll orders every</span><span className="value">2 minutes ›</span></div>
        <div className="list-row"><span>Push FGINV counts to Shopify</span><button role="switch" aria-checked={push} className={`toggle${push ? "" : " off"}`} onClick={() => setPush((v) => !v)} /></div>
        <div className="list-row"><span>Notify on drift over</span><span className="value num">10 units ›</span></div>
      </Group>

      <Group title="Appearance">
        <div className="list-row">
          <span>Theme</span>
          <span className="seg-sm dark"><span className="seg-sm-item active">Dark</span><span className="seg-sm-item">Light</span><span className="seg-sm-item">System</span></span>
        </div>
        <div className="list-row">
          <span>Accent</span>
          <span style={{ display: "flex", gap: 8 }}>
            {(["blue", "green"] as const).map((a) => (
              <button key={a} aria-label={`${a} accent`} onClick={() => setAccent(a)} style={{
                width: 18, height: 18, borderRadius: "50%", border: 0, cursor: "pointer", background: a === "blue" ? "#4c8dff" : "#3fb97a",
                outline: accent === a ? "2px solid rgba(255,255,255,0.5)" : "none", outlineOffset: 2,
              }} />
            ))}
          </span>
        </div>
        <div className="list-row link" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}>
          <span>Table density</span><span className="value">{density === "compact" ? "Compact" : "Comfortable"} ›</span>
        </div>
      </Group>

      <Group title="About">
        <div className="list-row"><span>Flow Command</span><span className="value num">0.1.0 · macOS</span></div>
        <div className="list-row"><span>Bundle identifier</span><span className="mono sub" style={{ fontSize: 12 }}>com.flowgardens.command</span></div>
      </Group>

      {modal && <CredsModal onClose={() => setModal(false)} onSaved={(msg) => { setModal(false); toast(msg); load(); }} />}
    </section>
  );
}

function Group({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div style={{ padding: "0 12px 8px", display: "flex", alignItems: "center", gap: 8 }}><span className="label">{title}</span>{extra}</div>
      <div className="card list">{children}</div>
    </div>
  );
}

function CredsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = !!id.trim() && !!secret.trim() && !busy;

  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const save = async () => {
    if (!ready) return;
    setBusy(true); setErr(null);
    try { onSaved(await saveCredentials(id.trim(), secret.trim())); }
    catch (e) { setErr(String(e)); setBusy(false); }
  };

  return createPortal(
    <div className="overlay center" onClick={onClose}>
      <div className="dialog sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Update Shopify credentials">
        <div className="sheet-head">
          <div className="title">Update Shopify credentials</div>
          <div className="why">Client credentials are shared by all three stores and stored in the macOS Keychain.</div>
        </div>
        <div className="sheet-body">
          <label className="field full">Client ID<input autoFocus className="input input-dark mono" value={id} onChange={(e) => setId(e.target.value)} /></label>
          <label className="field full">Client secret<input type="password" className="input input-dark" value={secret} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} /></label>
          {err && <div className="full" style={{ fontSize: 11.5, color: "var(--red)", marginTop: -4 }}>{err}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void save()}>{busy ? "Saving…" : "Save to Keychain"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

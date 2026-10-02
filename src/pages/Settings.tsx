import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { prefs, useApp } from "../lib/app";
import {
  GOOGLE_PREFS, type GoogleConfig, type GoogleStatus, OPENROUTER_MODEL_PREF, type OpenRouterStatus, STORES, getCredentials, getOpenRouterStatus, googleConfig, googleStatus, saveCredentials, saveOpenRouterKey,
  seedGoogleConfig, storeById, useOrders, type Voice, type VoiceStatus, listVoices, saveElevenLabsKey, setupVoiceAgent, voiceStatus,
} from "../lib/shopify";
import { Pill, SampleData, Spinner, Status } from "../components/ui";

type Creds = { status: "loading" | "saved" | "missing"; clientId?: string };
const mask = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "••••");
type GoogleKey = keyof GoogleConfig;
const GOOGLE_FIELDS: [GoogleKey, string, string, string][] = [
  ["keyFile", "Service-account key file", "/Users/…/service-account.json", "path to the downloaded JSON key"],
  ["sheetId", "Sheet id", "1M4q…", "docs.google.com/spreadsheets/d/<id>/edit"],
  ["sheetTab", "Tab", "first tab", "blank = the first tab"],
  ["folderId", "Drive folder id", "1lCD…", "drive.google.com/drive/folders/<id>"],
];
const readGoogleForm = () => Object.fromEntries(GOOGLE_FIELDS.map(([k]) => [k, prefs.get(GOOGLE_PREFS[k], "")])) as Record<GoogleKey, string>;
const NO_STATUS: GoogleStatus = { configured: false, serviceAccountEmail: null, sheetReachable: false, sheetTitle: null, tabs: [], driveReachable: false, driveFolderName: null, error: null };

export function Settings() {
  const { store, accent, setAccent, density, setDensity, toast } = useApp();
  const cache = useOrders();
  const [creds, setCreds] = useState<Creds>({ status: "loading" });
  const [modal, setModal] = useState(false);
  const [push, setPush] = useState(true);
  const [or, setOr] = useState<OpenRouterStatus | null>(null); // null = checking
  const [orKey, setOrKey] = useState("");
  const [orBusy, setOrBusy] = useState(false);
  const [model, setModel] = useState(() => prefs.get<string>(OPENROUTER_MODEL_PREF, ""));
  const [gForm, setGForm] = useState(readGoogleForm); // mirrors the four google.* prefs
  const [g, setG] = useState<GoogleStatus | null>(null); // last Test connection result
  const [gBusy, setGBusy] = useState<"import" | "test" | null>(null);

  const setGField = (k: GoogleKey, v: string) => { prefs.set(GOOGLE_PREFS[k], v.trim()); setGForm((f) => ({ ...f, [k]: v })); };
  const importG = () => {
    setGBusy("import");
    seedGoogleConfig()
      .then((cfg) => {
        if (!cfg) return toast("Nothing to import");
        for (const [k] of GOOGLE_FIELDS) setGField(k, cfg[k] ?? "");
        setG(null);
        toast("Imported Google settings from the old dashboard");
      })
      .catch((e) => toast(`Import failed · ${e}`)).finally(() => setGBusy(null));
  };
  const testG = () => {
    setGBusy("test");
    googleStatus(googleConfig()).then(setG).catch((e) => setG({ ...NO_STATUS, error: String(e) })).finally(() => setGBusy(null));
  };
  /** One probe line: "—" when that id is blank, the name + a green pill when reachable, else the error. */
  const probe = (id: string | null, ok: boolean, text: string) =>
    !id ? <span className="sub" style={{ fontSize: 12 }}>—</span>
    : ok ? <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}><span className="sub ellip" style={{ fontSize: 12 }}>{text}</span><Pill kind="green">reachable</Pill></span>
    : <span className="ellip" style={{ fontSize: 12, color: "var(--red)" }} title={g?.error ?? undefined}>{g?.error ?? "unreachable"}</span>;

  const load = useCallback(() => {
    getCredentials().then((c) => setCreds({ status: "saved", clientId: c.clientId })).catch(() => setCreds({ status: "missing" }));
  }, []);
  useEffect(load, [load]);
  const loadOr = useCallback(() => { getOpenRouterStatus().then(setOr).catch(() => setOr({ hasKey: false, keyHint: null, defaultModel: "" })); }, []);
  useEffect(loadOr, [loadOr]);
  const saveOr = (key: string) => {
    setOrBusy(true);
    saveOpenRouterKey(key).then((msg) => { toast(msg); setOrKey(""); loadOr(); }).catch((e) => toast(`Save failed · ${e}`)).finally(() => setOrBusy(false));
  };

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

      <Group title="OpenRouter · COA parsing">
        <div className="list-row">
          <span>API key</span>
          {or === null ? <Status kind="mute">Checking…</Status> : or.hasKey ? <Pill kind="green">Key saved · ends in {or.keyHint}</Pill> : <Pill kind="amber">No key — parsing is disabled</Pill>}
        </div>
        <div className="list-row tall" style={{ gap: 8 }}>
          <input type="password" className="input input-dark" placeholder="sk-or-…" value={orKey} style={{ flex: 1, minWidth: 0 }} disabled={orBusy}
            onChange={(e) => setOrKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && orKey.trim() && saveOr(orKey.trim())} />
          <button className="btn btn-primary btn-sm" disabled={!orKey.trim() || orBusy} onClick={() => saveOr(orKey.trim())}>{orBusy ? "Saving…" : "Save to Keychain"}</button>
          {or?.hasKey && <button className="btn btn-secondary btn-sm" disabled={orBusy} onClick={() => saveOr("")}>Remove key</button>}
        </div>
        <div className="list-row tall" style={{ gap: 14 }}>
          <span className="two-line"><span>Model</span><span className="second">OpenRouter model id; blank uses the default</span></span>
          <input className="input input-dark mono" placeholder={or?.defaultModel || "default"} value={model} style={{ width: 280, fontSize: 12 }}
            onChange={(e) => { setModel(e.target.value); prefs.set(OPENROUTER_MODEL_PREF, e.target.value.trim()); }} />
        </div>
        <div className="list-row">
          <span className="sub" style={{ fontSize: 12.5 }}>Stored in the macOS Keychain · used by Parse / Re-parse on the Lab page</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void openUrl("https://openrouter.ai/keys")}>openrouter.ai/keys ↗</button>
        </div>
      </Group>

      <VoiceSettings toast={toast} />

      <Group title="Google · COA mirror">
        {GOOGLE_FIELDS.map(([k, label, ph, help]) => (
          <div key={k} className="list-row tall" style={{ gap: 14 }}>
            <span className="two-line"><span>{label}</span><span className="second">{help}</span></span>
            <input className="input input-dark mono" placeholder={ph} value={gForm[k]} style={{ width: 340, fontSize: 12 }} disabled={gBusy === "import"} spellCheck={false}
              onChange={(e) => setGField(k, e.target.value)} onKeyDown={(e) => e.key === "Enter" && testG()} />
          </div>
        ))}
        <div className="list-row tall" style={{ gap: 8 }}>
          <span className="sub" style={{ fontSize: 12.5, flex: 1 }}>Saved as you type · the wizard's Mirror toggle and the detail pane's Mirror to Google use these</span>
          <button className="btn btn-control btn-sm" disabled={!!gBusy} title="Read the old dashboard's .env" onClick={importG}>{gBusy === "import" ? "Importing…" : "Import from old dashboard"}</button>
          <button className="btn btn-secondary btn-sm" disabled={!!gBusy} onClick={testG}>Test connection</button>
        </div>
        {gBusy === "test" ? <div className="list-row"><Status kind="mute"><Spinner size={12} /> Testing the Sheet and the folder as the service account…</Status></div> : g && (
          <>
            <div className="list-row">
              <span className="two-line"><span>Service account</span><span className="second">Share the Sheet and the Drive folder with this address as Editor</span></span>
              {g.serviceAccountEmail ? <span className="mono sub ellip" style={{ fontSize: 12 }}>{g.serviceAccountEmail}</span> : <Pill kind="amber">{g.error ?? "Not configured"}</Pill>}
            </div>
            <div className="list-row"><span>Sheet</span>{probe(googleConfig().sheetId, g.sheetReachable, `${g.sheetTitle} · tabs: ${g.tabs.join(", ")}`)}</div>
            <div className="list-row"><span>Drive</span>{probe(googleConfig().folderId, g.driveReachable, g.driveFolderName ?? "")}</div>
          </>
        )}
        <div className="list-row">
          <span className="sub" style={{ fontSize: 12.5 }}>Drive gets the PDF named after the strain (same name = updated in place) · the Sheet row is upserted by batch id</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void openUrl("https://console.cloud.google.com/")}>console.cloud.google.com ↗</button>
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

/** ElevenLabs key (Keychain), voice picker, and one-click agent setup for the voice assistant. */
function VoiceSettings({ toast }: { toast: (m: string) => void }) {
  const [st, setSt] = useState<VoiceStatus | null>(null);
  const [key, setKey] = useState("");
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState<"key" | "voices" | "setup" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => voiceStatus().then((s) => { setSt(s); setVoice((v) => v || s.voiceId || ""); }).catch((e) => setErr(String(e))), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const loadVoices = () => { setBusy("voices"); setErr(null); listVoices().then(setVoices).catch((e) => setErr(String(e))).finally(() => setBusy(null)); };
  useEffect(() => { if (st?.hasKey && !voices) loadVoices(); }, [st?.hasKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveKey = (k: string) => {
    setBusy("key"); setErr(null);
    saveElevenLabsKey(k).then((m) => { toast(m); setKey(""); setVoices(null); return refresh(); }).catch((e) => setErr(String(e))).finally(() => setBusy(null));
  };
  const setup = () => {
    setBusy("setup"); setErr(null);
    setupVoiceAgent(voice, voices?.find((v) => v.id === voice)?.name).then(() => { toast("Voice agent ready — press Talk in the title bar"); return refresh(); })
      .catch((e) => setErr(String(e))).finally(() => setBusy(null));
  };
  return (
    <Group title="ElevenLabs · voice assistant">
      <div className="list-row">
        <span>API key</span>
        {st === null ? <Status kind="mute">Checking…</Status> : st.hasKey ? <Pill kind="green">Key saved · ends in {st.keyHint}</Pill> : <Pill kind="amber">No key — the assistant is off</Pill>}
      </div>
      <div className="list-row tall" style={{ gap: 8 }}>
        <input type="password" className="input input-dark" placeholder="ElevenLabs API key" value={key} style={{ flex: 1, minWidth: 0 }} disabled={!!busy}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey(key.trim())} />
        <button className="btn btn-primary btn-sm" disabled={!key.trim() || !!busy} onClick={() => saveKey(key.trim())}>{busy === "key" ? "Saving…" : "Save to Keychain"}</button>
        {st?.hasKey && <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => saveKey("")}>Remove key</button>}
      </div>
      {st?.hasKey && <>
        <div className="list-row tall" style={{ gap: 10 }}>
          <span className="two-line"><span>Voice</span><span className="second">Your own (cloned) voices are listed first</span></span>
          <select className="input input-dark" style={{ width: 260 }} value={voice} disabled={!!busy || !voices} onChange={(e) => setVoice(e.target.value)}>
            <option value="">{voices ? "Choose a voice…" : busy === "voices" ? "Loading voices…" : "—"}</option>
            {voices?.map((v) => <option key={v.id} value={v.id}>{v.name}{v.category && v.category !== "premade" ? ` (${v.category})` : ""}</option>)}
          </select>
        </div>
        <div className="list-row">
          <span className="two-line">
            <span>Agent</span>
            <span className="second">{st.agentId ? `${st.voiceName ?? "Custom voice"} · ${st.llm ?? "default model"} · ${st.needsUpdate ? "update available — click Update agent for faster replies" : "ready"}` : "Not set up yet — creates a private “Flow Command” agent and its tools in your ElevenLabs workspace"}</span>
          </span>
          <button className="btn btn-primary btn-sm" disabled={!voice || !!busy} onClick={setup}>
            {busy === "setup" ? "Setting up…" : !st.agentId ? "Set up agent" : st.needsUpdate || voice !== st.voiceId ? "Update agent" : "Re-apply"}
          </button>
        </div>
      </>}
      {err && <div className="list-row"><span className="sub" style={{ color: "var(--red)", fontSize: 12.5 }}>{err.slice(0, 300)}</span></div>}
      <div className="list-row">
        <span className="sub" style={{ fontSize: 12.5 }}>Key stays in the Keychain; audio and transcripts go to ElevenLabs. The assistant can only look things up — changes become review cards you Apply.</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void openUrl("https://elevenlabs.io/app/settings/api-keys")}>API keys ↗</button>
      </div>
    </Group>
  );
}

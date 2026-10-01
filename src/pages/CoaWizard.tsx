// COA import wizard (Phase C + D): Upload → Extract → Map → Import in the app's sheet dialog. Ported from the old dashboard's
// wizard.jsx including the Google Drive / Sheet mirror (step 4 toggle; google_mirror_coa after each import; Settings → Google).
// "upload" starts from local PDFs (staged into the retail Files library); "library" starts from Coa rows already in Shopify
// (Bulk import, the detail pane's Import…) and skips uploading.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { prefs, useApp } from "../lib/app";
import {
  type Coa, type ImportFields, type ImportResult, type Kind, type MirrorLeg, OPENROUTER_MODEL_PREF, TERPENE_LIST, dec3, fileToBase64, fmtDate, getOpenRouterStatus, googleConfig, googleConfigured,
  googleMirrorCoa, importCoa, loadCoas, parseCoas, pdfStem as stem, uploadCoaPdf,
} from "../lib/shopify";
import { Pill, Spinner } from "../components/ui";
import { ProductSearch } from "./Lab";

const STEPS = ["Upload", "Extract", "Map", "Import"] as const;
const STEP_LABEL: Record<string, string> = { terpenes: "terpenes", metaobject: "coa_record", productLink: "product link", coaPage: "/pages/coa", cacheFields: "cache" };
type Status = "queued" | "uploading" | "uploaded" | "failed" | "parsing" | "parsed" | "importing" | "imported" | "import-failed";
const STATUS_KIND: Record<Status, Kind> = { queued: "neutral", uploading: "amber", uploaded: "green", failed: "red", parsing: "amber", parsed: "green", importing: "amber", imported: "green", "import-failed": "red" };
const STATUS_LABEL: Partial<Record<Status, string>> = { uploaded: "in Shopify", "import-failed": "failed" };
/** Form-shaped fields: numbers stay strings while editing; toImportFields() converts for import_coa. */
interface Fields {
  batchId: string; issueDate: string; expiryDate: string; lab: string; producer: string;
  thcaPercent: string; cbdPercent: string; cbgPercent: string; totalCannabinoidsPercent: string;
  terpenes: { name: string; percent: string }[]; notes: string; qrPresent: boolean;
}
type TextKey = Exclude<keyof Fields, "terpenes" | "qrPresent">;
interface Row {
  id: string; file?: File; fileId?: string; fileUrl?: string | null; fileName: string; status: Status; error?: string;
  fields: Fields; touched: Partial<Record<keyof Fields, true>>; // touched = edited by hand, never overwritten by a parse
  productId: string | null; productTitle: string | null; matchVia: string | null; pageName: string; result?: ImportResult;
  mirror?: { drive: MirrorLeg & { webViewLink?: string | null }; sheet: MirrorLeg }; // Google legs, set after a successful import when the toggle is on
}

let seq = 0;
const EMPTY: Fields = { batchId: "", issueDate: "", expiryDate: "", lab: "", producer: "", thcaPercent: "", cbdPercent: "", cbgPercent: "", totalCannabinoidsPercent: "", terpenes: [], notes: "", qrPresent: false };
const str =(v: string | number | null | undefined) => (v == null ? "" : String(v));
const fieldsFromCoa = (c: Coa): Fields => ({
  batchId: c.batch ?? "", issueDate: c.issued.slice(0, 10), expiryDate: c.expires.slice(0, 10), lab: c.lab ?? "", producer: c.producer ?? "",
  thcaPercent: str(c.thca), cbdPercent: str(c.cbd), cbgPercent: str(c.cbg), totalCannabinoidsPercent: str(c.totalCannabinoids),
  terpenes: c.terpenes.map((t) => ({ name: t.name, percent: str(t.pct) })), notes: c.notes ?? "", qrPresent: !!c.qrPresent,
});
const rowFromCoa = (c: Coa): Row => ({
  id: `r${++seq}`, fileId: c.fileId, fileUrl: c.fileUrl, fileName: c.fileName, status: c.parsed ? "parsed" : "uploaded", fields: fieldsFromCoa(c), touched: {},
  productId: c.productId, productTitle: c.productId ? c.productName : null, matchVia: c.matchVia, pageName: c.productId ? c.productName : stem(c.fileName),
});
const rowFromFile = (file: File): Row => ({ id: `r${++seq}`, file, fileName: file.name, status: "queued", fields: EMPTY, touched: {}, productId: null, productTitle: null, matchVia: null, pageName: stem(file.name) });
const num = (s: string) => { const n = parseFloat(s); return s.trim() === "" || !Number.isFinite(n) ? null : n; };
const nul = (s: string) => s.trim() || null;
const plusYear = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCFullYear(t.getUTCFullYear() + 1); return t.toISOString().slice(0, 10); };
const toImportFields = (f: Fields): ImportFields => ({
  batchId: nul(f.batchId), issueDate: nul(f.issueDate), expiryDate: nul(f.expiryDate) ?? (nul(f.issueDate) ? plusYear(f.issueDate.trim()) : null), lab: nul(f.lab), producer: nul(f.producer),
  thcaPercent: num(f.thcaPercent), cbdPercent: num(f.cbdPercent), cbgPercent: num(f.cbgPercent), totalCannabinoidsPercent: num(f.totalCannabinoidsPercent),
  terpenes: f.terpenes.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), percent: num(t.percent) })), notes: nul(f.notes), qrPresent: f.qrPresent,
});
const hasContent = (f: Fields) => !!(f.batchId.trim() || f.lab.trim() || [f.thcaPercent, f.cbdPercent, f.cbgPercent, f.totalCannabinoidsPercent].some((v) => num(v) != null));
const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const INPUT = { height: 28, fontSize: 12, width: "100%" } as const;
const IMPORT_COLS = "minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.6fr)";

export function CoaWizard({ mode, prefill = [], onClose, onDone }: { mode: "upload" | "library"; prefill?: Coa[]; onClose: () => void; onDone: (msg: string) => void }) {
  const { toast } = useApp();
  const [step, setStep] = useState(1);
  const [rows, setRows] = useState<Row[]>(() => prefill.map(rowFromCoa));
  const [busy, setBusy] = useState(false); // an upload / parse / import loop is running
  const [post, setPost] = useState(true);
  const [done, setDone] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null); // null = not checked yet
  const gCfg = useMemo(googleConfig, []);
  const gOk = googleConfigured(gCfg);
  const [google, setGoogle] = useState(gOk);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { getOpenRouterStatus().then((s) => setHasKey(s.hasKey)).catch(() => setHasKey(false)); }, []);
  const patch = (id: string, p: Partial<Row> | ((r: Row) => Partial<Row>)) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...(typeof p === "function" ? p(r) : p) } : r)));

  const inShopify = rows.filter((r) => r.fileId);
  const queued = rows.filter((r) => r.status === "queued");
  const targets = inShopify.filter((r) => r.status !== "imported");
  const imported = inShopify.length - targets.length;
  const linked = inShopify.filter((r) => r.productId).length;
  // Files staged by this wizard live in Shopify even if the user bails; make them confirm.
  const pending = mode === "upload" && !done && targets.length > 0;
  const tryClose = () => { if (!pending || window.confirm(`${plural(targets.length, "PDF")} in the Files library but not imported. Close anyway?`)) onClose(); };
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") tryClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); });

  // ---- Upload: sequential staged uploads (each waits up to ~20 s for the CDN URL).
  const addFiles = (list: FileList | null) => {
    const pdfs = [...(list ?? [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return toast("Drop PDF files");
    setRows((rs) => [...rs, ...pdfs.map(rowFromFile)]);
  };
  const upload = async () => {
    setBusy(true);
    for (const r of queued) {
      patch(r.id, { status: "uploading", error: undefined });
      try {
        const out = await uploadCoaPdf(r.file!.name, await fileToBase64(r.file!));
        patch(r.id, { status: "uploaded", fileId: out.fileId, fileUrl: out.url, fileName: out.filename || r.fileName, error: out.ok ? undefined : `file status ${out.fileStatus} — no CDN URL yet` });
      } catch (e) { patch(r.id, { status: "failed", error: String(e) }); }
    }
    setBusy(false);
  };

  // ---- Extract: on entry, parse the unparsed uploads (with a key), then re-pull the list so parsed fields + the filename auto-match land in the rows.
  useEffect(() => {
    if (step !== 2 || hasKey == null) return;
    const ids = new Set(rows.filter((r) => r.fileId && r.status === "uploaded").map((r) => r.id));
    if (!ids.size) return;
    const files = rows.filter((r) => ids.has(r.id)).map((r) => ({ fileId: r.fileId!, fileUrl: r.fileUrl ?? "" }));
    setBusy(true);
    if (hasKey) setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, status: "parsing" } : r)));
    (hasKey ? parseCoas(files, prefs.get(OPENROUTER_MODEL_PREF, "")) : Promise.resolve(null))
      .then((res) => loadCoas(true).then((st) => {
        const by = new Map((st.data?.coas ?? []).map((c) => [c.fileId, c]));
        const failed = new Map((res?.results ?? []).filter((x) => !x.ok).map((x) => [x.fileId, x.error ?? "parse failed"]));
        setRows((rs) => rs.map((r) => {
          if (!ids.has(r.id)) return r;
          const c = by.get(r.fileId!), err = failed.get(r.fileId!);
          if (!c) return { ...r, status: "uploaded", error: err ?? "not in the COA list yet — try Back → Next" };
          const kept = Object.fromEntries(Object.keys(r.touched).map((k) => [k, r.fields[k as keyof Fields]]));
          const auto = !r.productId && c.matchVia && c.productId ? { productId: c.productId, productTitle: c.productName, matchVia: c.matchVia } : {};
          return {
            ...r, ...auto, status: !err && c.parsed ? "parsed" : "uploaded", error: err, fields: { ...fieldsFromCoa(c), ...kept } as Fields,
            pageName: auto.productTitle && r.pageName === stem(r.fileName) ? auto.productTitle : r.pageName,
          };
        }));
      }))
      .catch((e) => { toast(`Parse failed · ${e}`); setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, status: "uploaded", error: String(e) } : r))); })
      .finally(() => setBusy(false));
  }, [step, hasKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (r: Row, k: keyof Fields, v: Fields[keyof Fields]) => patch(r.id, (x) => ({ fields: { ...x.fields, [k]: v }, touched: { ...x.touched, [k]: true } }));
  const setTerp = (r: Row, i: number, p: Partial<Fields["terpenes"][number]>) => set(r, "terpenes", r.fields.terpenes.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const text = (r: Row, k: TextKey, label: string, o: { type?: string; mono?: boolean; num?: boolean; placeholder?: string; span?: number } = {}) => (
    <label className="field" style={o.span ? { gridColumn: `span ${o.span}` } : undefined}>{label}
      <input className={`input input-dark${o.mono ? " mono" : ""}${o.num ? " num" : ""}`} type={o.type ?? "text"} inputMode={o.num ? "decimal" : undefined} value={r.fields[k]} placeholder={o.placeholder}
        style={{ ...INPUT, textAlign: o.num ? "right" : undefined }} onChange={(e) => set(r, k, e.target.value)} />
    </label>
  );

  // ---- Import: one import_coa per row, sequentially; the result's step list drives the chips. With the Google toggle on, a
  // successful import is followed by google_mirror_coa (Drive PDF + Sheet row); its failure never fails the row.
  const runImport = async () => {
    setBusy(true);
    for (const r of targets) {
      patch(r.id, { status: "importing", error: undefined });
      const fields = toImportFields(r.fields), pageName = r.pageName.trim() || null;
      let result: ImportResult;
      try {
        result = await importCoa({ fileId: r.fileId!, fileUrl: r.fileUrl ?? null, fileName: r.fileName, fields, productId: r.productId, productTitle: r.productTitle, pageName, post });
        patch(r.id, { status: result.ok ? "imported" : "import-failed", result });
      } catch (e) { patch(r.id, { status: "import-failed", error: String(e) }); continue; }
      if (!google || !result.ok) continue;
      const link = result.steps.find((s) => s.step === "productLink")?.detail as { flowerType?: string | null; category?: string | null } | null | undefined;
      const name = pageName ?? stem(r.fileName);
      try {
        patch(r.id, { mirror: await googleMirrorCoa(gCfg, { fileUrl: r.fileUrl ?? null, pdfName: `${name}.pdf`, row: {
          batch: fields.batchId ?? null, productName: name, flowerType: link?.flowerType ?? null, category: link?.category ?? null, lab: fields.lab ?? null, issued: fields.issueDate ?? null, expires: fields.expiryDate ?? null,
          thca: dec3(fields.thcaPercent), cbd: dec3(fields.cbdPercent), cbg: dec3(fields.cbgPercent), totalCannabinoids: dec3(fields.totalCannabinoidsPercent), shopifyUrl: r.fileUrl ?? null,
          posted: post ? "Yes" : "No", importedAt: new Date().toISOString(), notes: fields.notes ?? null,
        } }) });
      } catch (e) { const leg = { ok: false, skipped: null, error: String(e) }; patch(r.id, { mirror: { drive: leg, sheet: leg } }); }
    }
    setBusy(false);
    setDone(true);
  };

  const canNext = step === 1 ? inShopify.length > 0 && !rows.some((r) => r.status === "queued" || r.status === "uploading")
    : step === 2 ? !busy && inShopify.length > 0 && inShopify.every((r) => hasContent(r.fields))
    : true;
  const parsingN = rows.filter((r) => r.status === "parsing").length;
  const statusPill = (r: Row) => <Pill kind={STATUS_KIND[r.status]} sm><span title={r.error}>{STATUS_LABEL[r.status] ?? r.status}{r.error && r.status !== "failed" && r.status !== "import-failed" && " ⚠"}</span></Pill>;
  /** A Google leg chip: ✓ green, ✗ red with the error as title, or a mute "–" when the Rust side skipped it (e.g. no file URL / no folder id). */
  const legChip = (k: "drive" | "sheet", l: MirrorLeg) => (
    <span key={k} className={`pill sm nodot ${l.skipped ? "neutral" : l.ok ? "green" : "red"}`} title={l.error ?? (l.skipped ? `skipped: ${l.skipped}` : k)}>{l.skipped ? "–" : l.ok ? "✓" : "✗"} {k}</span>
  );
  const chips = (r: Row): ReactNode => r.status === "importing" ? <Pill kind="amber" sm>importing…</Pill> : r.result ? (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {r.result.steps.map((s) => <span key={s.step} className={`pill sm nodot ${s.ok ? "green" : "red"}`} title={s.error ?? STEP_LABEL[s.step] ?? s.step}>{s.ok ? "✓" : "✗"} {STEP_LABEL[s.step] ?? s.step}</span>)}
      {r.result.unknownTerpenes.length > 0 && <span className="pill sm nodot amber" title="Not in the terpene library — left off the metaobject">unknown: {r.result.unknownTerpenes.join(", ")}</span>}
      {r.mirror ? [legChip("drive", r.mirror.drive), legChip("sheet", r.mirror.sheet)] : google && r.status === "imported" && <Pill kind="amber" sm>google…</Pill>}
    </span>
  ) : r.status === "import-failed" ? <Pill kind="red" sm><span title={r.error}>{r.error ?? "failed"}</span></Pill> : <Pill kind="neutral" sm dot={false}>ready</Pill>;
  const coaLine = (r: Row) => (
    <span className="two-line" style={{ minWidth: 0 }}>
      <span className="ellip" style={{ fontWeight: 500 }} title={r.fileName}>{r.fields.batchId || stem(r.fileName)}</span>
      <span className="second ellip">{r.fields.lab || "no lab"} · THCa {r.fields.thcaPercent || "—"}% · {r.fields.issueDate ? fmtDate(r.fields.issueDate) : "no issue date"}</span>
    </span>
  );
  const mirrored = inShopify.filter((r) => r.mirror && !r.mirror.drive.error && !r.mirror.sheet.error).length; // both legs ok or skipped
  const doneMsg = `Imported ${plural(imported, "COA")}${targets.length ? ` · ${targets.length} failed` : ""}${google ? ` · mirrored ${mirrored}` : ""}`;

  let body: ReactNode;
  if (done) body = <>
    <div style={{ textAlign: "center", padding: "10px 0 2px" }}>
      <div className="h-heading">Imported {imported} · {targets.length} failed{google && ` · mirrored ${mirrored}`}</div>
      <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>
        {post ? "coa_record ACTIVE · posted to /pages/coa" : "coa_record saved as DRAFT — nothing visible to customers yet"}{linked > 0 && ` · ${plural(linked, "product link")}`}
      </div>
    </div>
    {inShopify.map((r) => {
      const drive = r.mirror?.drive.webViewLink ?? null;
      return (
        <div key={r.id} className="row tall" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)", padding: "6px 8px", height: "auto", minHeight: 44 }}>
          {coaLine(r)}
          <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {chips(r)}
            {drive && <span className="mute" style={{ fontSize: 12 }}>· Drive: <button className="btn btn-ghost btn-sm" style={{ height: 22, padding: "0 6px" }} title={drive} onClick={() => void openUrl(drive)}>open ↗</button></span>}
          </span>
        </div>
      );
    })}
  </>;
  else if (step === 1) body = <>
    {mode === "upload" && (
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }} onClick={() => fileRef.current?.click()}
        style={{ border: "1px dashed rgba(255, 255, 255, 0.18)", borderRadius: 10, padding: "26px 16px", textAlign: "center", cursor: "pointer", background: "rgba(255, 255, 255, 0.02)" }}>
        <div className="strong">Drop COA PDFs here</div>
        <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>or click to browse · uploads to the retail Files library (~20 s each while the CDN propagates)</div>
        <input ref={fileRef} type="file" accept="application/pdf" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>
    )}
    {mode === "library" && <div className="mute" style={{ fontSize: 12 }}>{plural(rows.length, "COA")} already in the Files library — Next reviews the parsed fields.</div>}
    {rows.map((r) => (
      <div key={r.id} className="row tall" style={{ gridTemplateColumns: "26px minmax(0, 1fr) auto auto", padding: "0 8px" }}>
        <span className="pdf-icon">PDF</span>
        <span className="two-line">
          <span className="ellip" style={{ fontWeight: 500 }} title={r.fileName}>{r.fileName}</span>
          <span className="second mono ellip">{r.file ? kb(r.file.size) : r.fields.batchId || "—"}{r.fileId && ` · ${r.fileId.split("/").pop()}`}{r.productTitle && ` · ${r.productTitle}`}</span>
        </span>
        {statusPill(r)}
        {mode === "upload" ? <button className="icon-btn" aria-label="Remove" disabled={r.status === "uploading"} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>×</button> : <span />}
      </div>
    ))}
  </>;
  else if (step === 2) body = <>
    {hasKey === false && <div className="mute" style={{ fontSize: 12 }}>No OpenRouter key — fill in fields manually (Settings → OpenRouter).</div>}
    {inShopify.map((r) => (
      <div key={r.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="pdf-icon">PDF</span>
          <span className="ellip strong" style={{ minWidth: 0, flex: 1 }} title={r.fileName}>{r.fileName}</span>
          {statusPill(r)}
          {r.fileUrl && <button className="icon-btn" title="Open PDF" aria-label="Open PDF" onClick={() => void openUrl(r.fileUrl!)}>{"↗"}</button>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          {text(r, "batchId", "Batch", { mono: true })}
          {text(r, "lab", "Lab")}
          {text(r, "producer", "Owner")}
          {text(r, "issueDate", "Issued", { type: "date", mono: true })}
          {text(r, "expiryDate", "Expires", { type: "date", mono: true, placeholder: "issued + 1 year" })}
          {text(r, "thcaPercent", "THCa %", { num: true })}
          {text(r, "cbdPercent", "CBDa %", { num: true })}
          {text(r, "cbgPercent", "CBG %", { num: true })}
          {text(r, "totalCannabinoidsPercent", "Total %", { num: true })}
          {text(r, "notes", "Notes", { span: 2 })}
          <label className="field" style={{ justifyContent: "flex-end" }}>QR present
            <span style={{ display: "flex", alignItems: "center", gap: 6, height: 28 }}>
              <input type="checkbox" checked={r.fields.qrPresent} onChange={(e) => set(r, "qrPresent", e.target.checked)} /><span className="mute" style={{ fontSize: 11.5 }}>lab QR on the PDF</span>
            </span>
          </label>
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className="label">Terpenes · {r.fields.terpenes.length}</span>
            <button className="btn btn-ghost btn-sm" style={{ height: 22, padding: "0 6px" }} onClick={() => set(r, "terpenes", [...r.fields.terpenes, { name: TERPENE_LIST.find((n) => !r.fields.terpenes.some((t) => t.name === n)) ?? "", percent: "" }])}>+ Add terpene</button>
          </div>
          {r.fields.terpenes.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>None parsed — add one or leave empty.</div> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {r.fields.terpenes.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 4 }}>
                  <input className="input input-dark" list="fc-terpenes" value={t.name} placeholder="Terpene" aria-label="Terpene" style={{ height: 26, fontSize: 12, flex: 1, minWidth: 0 }} onChange={(e) => setTerp(r, i, { name: e.target.value })} />
                  <input className="input input-dark num" inputMode="decimal" value={t.percent} placeholder="%" aria-label="Percent" style={{ height: 26, fontSize: 12, width: 64, textAlign: "right" }} onChange={(e) => setTerp(r, i, { percent: e.target.value })} />
                  <button className="icon-btn" aria-label="Remove terpene" onClick={() => set(r, "terpenes", r.fields.terpenes.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    ))}
    <datalist id="fc-terpenes">{TERPENE_LIST.map((n) => <option key={n} value={n} />)}</datalist>
  </>;
  else if (step === 3) body = <>
    <div className="mute" style={{ fontSize: 12 }}>
      Linking is optional but recommended: only linked COAs get the product's <span className="mono">custom.coa_records</span> entry (the storefront's COA link).
      Page name is the block title on flowgardens.com/pages/coa and the coa_record's display title.
    </div>
    {inShopify.map((r) => (
      <div key={r.id} className="card" style={{ padding: 12, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr) 200px", gap: 12, alignItems: "start" }}>
        {coaLine(r)}
        {r.productId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
            <span className="ellip" style={{ minWidth: 0, flex: 1, fontWeight: 500 }}>{r.productTitle}</span>
            {r.matchVia && r.matchVia !== "manual" && <span className="tag" title={`auto-matched via ${r.matchVia}`}>auto</span>}
            <button className="btn btn-control btn-sm" onClick={() => patch(r.id, { productId: null, productTitle: null, matchVia: null })}>Clear</button>
          </div>
        ) : <ProductSearch autoFocus={false} pickLabel="Pick" onPick={(p) => patch(r.id, { productId: p.id, productTitle: p.title, matchVia: "manual", pageName: p.title })} />}
        <label className="field">Page name<input className="input input-dark" value={r.pageName} style={INPUT} onChange={(e) => patch(r.id, { pageName: e.target.value })} /></label>
      </div>
    ))}
  </>;
  else body = <>
    <div className="card card-pad" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <button type="button" role="switch" aria-checked={post} aria-label="Post to flowgardens.com/pages/coa" className={`toggle${post ? "" : " off"}`} disabled={busy} onClick={() => setPost(!post)} />
      <div style={{ minWidth: 0 }}>
        <div className="strong">Post to flowgardens.com/pages/coa</div>
        <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>On: the coa_record is ACTIVE and the page name's block is added or updated on the public COA page. Off: the record is saved as DRAFT and the theme is not touched.</div>
        <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>A backup of the theme template is saved locally before every write.</div>
      </div>
    </div>
    <div className="card card-pad" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <button type="button" role="switch" aria-checked={google} aria-label="Mirror to Google Drive + Sheet" className={`toggle${google ? "" : " off"}`} disabled={busy || !gOk} onClick={() => setGoogle(!google)} />
      <div style={{ minWidth: 0 }}>
        <div className="strong">Mirror to Google Drive + Sheet</div>
        <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>On: after each import the PDF is uploaded to the Drive folder as “&lt;page name&gt;.pdf” (a same-name file is updated in place) and the Sheet row for the batch is added or updated. A Google failure never fails the import.</div>
        {!gOk && <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>Set up Google in Settings</div>}
      </div>
    </div>
    <div>
      <div className="thead" style={{ gridTemplateColumns: IMPORT_COLS, padding: "0 8px" }}><span>COA</span><span>Product</span><span>Steps</span></div>
      {inShopify.map((r) => (
        <div key={r.id} className="row tall" style={{ gridTemplateColumns: IMPORT_COLS, padding: "6px 8px", height: "auto", minHeight: 44 }}>
          {coaLine(r)}
          <span className="two-line"><span className="ellip" style={{ color: r.productTitle ? undefined : "var(--mute)" }}>{r.productTitle ?? "no product link"}</span><span className="second ellip">page “{r.pageName || "—"}”</span></span>
          <span>{chips(r)}</span>
        </div>
      ))}
    </div>
    {busy && <div className="mute" style={{ fontSize: 12, textAlign: "center" }}>Importing one at a time — leave this open until it finishes.</div>}
  </>;

  return (
    <div className="overlay center" onClick={tryClose}>
      <div className="dialog sheet" style={{ width: 880, maxWidth: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Import COAs">
        <div className="sheet-head" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div className="title">Import COAs</div>
            <div className="why ellip">{mode === "upload" ? "PDF → Files library → parse → link → coa_record + /pages/coa" : `${plural(rows.length, "COA")} from the library`}</div>
          </div>
          <div className="spacer" />
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, whiteSpace: "nowrap" }}>
            {STEPS.map((s, i) => {
              const n = i + 1, on = n === step && !done, past = n < step || done;
              return (
                <Fragment key={s}>
                  {i > 0 && <span className="mute">·</span>}
                  <span className={on ? "strong" : past ? "sub" : "mute"} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: on ? "var(--accent)" : undefined }}>
                    <span className="tag mono num" style={past ? { color: "var(--green)" } : on ? { color: "var(--accent)", background: "var(--accent-soft)" } : undefined}>{past ? "✓" : n}</span>{s}
                  </span>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>{body}</div>
        <div className="sheet-foot" style={{ alignItems: "center" }}>
          {!done && <button className="btn btn-secondary" onClick={tryClose}>Cancel</button>}
          <span className="mute ellip" style={{ fontSize: 12, flex: 1, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            {busy && <Spinner size={12} />}
            {busy && step === 2 ? (hasKey ? `Parsing ${parsingN}…` : "Refreshing the COA list…") : `${plural(rows.length, "COA")} · ${inShopify.length} in Shopify · ${linked} linked`}
          </span>
          {!done && step > 1 && <button className="btn btn-control" disabled={busy} onClick={() => setStep(step - 1)}>Back</button>}
          {!done && step === 1 && queued.length > 0 && <button className="btn btn-primary" disabled={busy} onClick={() => void upload()}>Upload {queued.length}</button>}
          {!done && step < 4 && <button className={`btn ${queued.length ? "btn-secondary" : "btn-primary"}`} disabled={busy || !canNext} onClick={() => setStep(step + 1)}>Next</button>}
          {!done && step === 4 && <button className="btn btn-primary" disabled={busy || targets.length === 0} onClick={() => void runImport()}>{busy ? "Importing…" : `Import ${plural(targets.length, "COA")}`}</button>}
          {done && <button className="btn btn-primary" onClick={() => onDone(doneMsg)}>Close</button>}
        </div>
      </div>
    </div>
  );
}

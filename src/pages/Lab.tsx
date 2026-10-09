// Lab / COAs — Phase A: every COA in the retail Files library, cross-checked with the coa_record metaobjects, the
// linked products and /pages/coa. Read-only plus local edits (save_coa_fields) and manual links (save_coa_link).
// Phase B: LLM parsing through OpenRouter (parse_coas; key + model in Settings). Phase C: the import wizard
// (pages/CoaWizard.tsx — upload_coa_pdf / import_coa) and Repost (repost_coas). Phase D: the Google Drive / Sheet mirror
// (google_mirror_coa — the wizard's toggle and the detail pane's Mirror to Google; config in Settings → Google).
import { Fragment, useEffect, useMemo, useState, type ReactNode, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { prefs, useApp } from "../lib/app";
import {
  type Coa, type MirrorLeg, OPENROUTER_MODEL_PREF, type OpenRouterStatus, type ProductHit, adminUrl, coaStateLabel, exportCoasCsv, fmtDate, getOpenRouterStatus, googleConfig, googleConfigured,
  googleMirrorCoa, isScopeError, loadCoas, mirrorRowFromCoa, parseCoas, patchCoaLocal, pdfNameFor, productStatus, relinkCoaLocal, repostCoas, saveCoaFields, saveCoaLink, searchProducts, storeById, useCoas,
} from "../lib/shopify";
import { type ColumnDef, type FilterValue, useDebounced, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill, Spinner } from "../components/ui";
import { ColumnsMenu, FilterButton, FilterChips, TableHead, TableRow } from "../components/DataTable";
import { CoaWizard } from "./CoaWizard";

/** Bulk import sends this many library rows through the wizard at once (the Rust import is sequential, ~5–10 s per COA). */
const BULK_MAX = 25;

const VIEWS = ["table", "calendar", "labs", "link"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { table: "Table", calendar: "Calendar", labs: "Labs", link: "Link" };
const STATE_OPTIONS = [{ value: "valid", label: "Valid" }, { value: "expiring", label: "Expiring" }, { value: "expired", label: "Expired" }];
const POSTED_OPTIONS = [{ value: "posted", label: "Posted" }, { value: "unposted", label: "Not posted" }];
const SRC: Record<string, string> = { page: "page", product: "prod", metaobject: "meta" };
/** 12 columns don't fit beside the 420px detail pane; below this the table scrolls sideways instead of collapsing the fr columns. */
const TABLE_MIN = { minWidth: 1220 };

/** Shopify appends `_<uuid>` to uploaded file names; hide it in the table (the full name is the title / detail line). */
const baseName = (f: string) => f.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.\w+$)/i, "");
const pct = (n: number | null) => (n == null ? "—" : n.toFixed(2));
const stamp = () => new Date().toISOString().slice(0, 10);
/** One value picked in an enum filter reads back as the seg selection; none → "all", several → nothing highlighted. */
const segValue = (v: FilterValue | undefined) => (v == null ? "all" : Array.isArray(v) && v.length === 1 ? v[0] : "");
const postedPill = (c: Coa) => (
  <span title={c.postedReason}>
    {c.postedStatus === "posted" ? <Pill kind="green">Posted{c.postedSource && ` · ${SRC[c.postedSource]}`}</Pill> : <Pill kind="neutral">Not posted</Pill>}
  </span>
);

// CSV export — one row per table row, RFC-4180 escaping (ported from the old dashboard minus Stores / Lab result ID).
const CSV_COLUMNS: [string, (c: Coa) => unknown][] = [
  ["File", (c) => c.fileName], ["Owner", (c) => c.producer], ["Batch", (c) => c.batch], ["Product", (c) => c.productName], ["Lab", (c) => c.lab],
  ["THCa %", (c) => c.thca], ["CBDa %", (c) => c.cbd], ["CBGa %", (c) => c.cbg], ["Total cannabinoids %", (c) => c.totalCannabinoids],
  ["Issued", (c) => c.issued], ["Expires", (c) => c.expires], ["Days to expire", (c) => c.daysToExpire], ["State", (c) => c.state], ["Posted", (c) => c.postedStatus],
  ["File URL", (c) => c.fileUrl],
];
const escapeCsv = (v: unknown) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows: Coa[]) =>
  [CSV_COLUMNS.map(([h]) => escapeCsv(h)), ...rows.map((c) => CSV_COLUMNS.map(([, get]) => escapeCsv(get(c))))].map((r) => r.join(",")).join("\n") + "\n";

function coaColumns(setOwner: (p: string) => void): ColumnDef<Coa>[] {
  return [
    {
      id: "file", label: "File", width: "minmax(0, 1.4fr)", cellClass: "cell-2", sortValue: (c) => c.fileName,
      filter: { kind: "text", value: (c) => c.fileName, placeholder: "File name" },
      cell: (c) => {
        const flags: ReactNode[] = [];
        if (c.parsed) flags.push(<span style={c.parseStale ? { color: "var(--amber)" } : undefined} title={c.parseStale ? "Parsed with an older prompt — re-parse" : `Parsed by ${c.parsedModel ?? "AI"}`}>AI</span>);
        if (c.qrPresent) flags.push("QR");
        if (c.edited) flags.push("✎");
        return <>
          <span className="pdf-icon">PDF</span>
          <span className="two-line">
            <span className="ellip" style={{ fontWeight: 500 }} title={c.fileName}>{baseName(c.fileName)}</span>
            <span className="second mono">{flags.length ? flags.map((f, i) => <Fragment key={i}>{i > 0 && " · "}{f}</Fragment>) : " "}</span>
          </span>
        </>;
      },
    },
    {
      id: "product", label: "Product", width: "minmax(0, 1fr)", cellClass: "two-line", sortValue: (c) => c.productName,
      filter: { kind: "text", value: (c) => `${c.productName} ${c.strain ?? ""} ${c.type ?? ""}`, placeholder: "Product, strain or type" },
      cell: (c) => <>
        <span className="ellip" style={{ color: c.productId ? "var(--text)" : "var(--mute)" }}>{c.productName || "—"}</span>
        <span className="second ellip">{[c.strain, c.type].filter(Boolean).join(" · ") || " "}</span>
      </>,
    },
    {
      id: "owner", label: "Owner", title: "Brand / company that owns the COA (parsed from the PDF); click to filter", width: "104px", cellClass: "sub ellip", sortValue: (c) => c.producer,
      filter: { kind: "enum", value: (c) => c.producer ?? "" },
      cell: (c) => (c.producer ? <span style={{ cursor: "pointer" }} title={`Filter by owner: ${c.producer}`} onClick={(e) => { e.stopPropagation(); setOwner(c.producer!); }}>{c.producer}</span> : "—"),
    },
    { id: "lab", label: "Lab", width: "96px", cellClass: "sub ellip", sortValue: (c) => c.lab, filter: { kind: "text", value: (c) => c.lab ?? "" }, cell: (c) => c.lab ?? "—" },
    { id: "batch", label: "Batch", width: "120px", defaultHidden: true, cellClass: "sub mono ellip", cellStyle: () => ({ fontSize: 12 }), sortValue: (c) => c.batch, filter: { kind: "text", value: (c) => c.batch ?? "" }, cell: (c) => c.batch ?? "—" },
    { id: "thca", label: "THCa", width: "54px", align: "right", sortValue: (c) => c.thca, sortDir: "desc", cell: (c) => pct(c.thca) },
    { id: "cbd", label: "CBDa", width: "54px", align: "right", sortValue: (c) => c.cbd, sortDir: "desc", cell: (c) => pct(c.cbd) },
    { id: "total", label: "Total", width: "54px", align: "right", sortValue: (c) => c.totalCannabinoids, sortDir: "desc", cell: (c) => pct(c.totalCannabinoids) },
    { id: "issued", label: "Issued", width: "92px", cellClass: "sub", sortValue: (c) => c.issued, cell: (c) => fmtDate(c.issued) },
    { id: "expires", label: "Expires", width: "92px", cellClass: "sub", sortValue: (c) => c.expires, cell: (c) => fmtDate(c.expires) },
    {
      id: "state", label: "State", width: "84px", sortValue: (c) => c.daysToExpire, filter: { kind: "enum", value: (c) => c.state, options: STATE_OPTIONS },
      cell: (c) => { const s = coaStateLabel(c); return <Pill kind={s.kind}>{s.label}</Pill>; },
    },
    { id: "posted", label: "Posted", width: "112px", sortValue: (c) => c.postedStatus, filter: { kind: "enum", value: (c) => c.postedStatus, options: POSTED_OPTIONS }, cell: postedPill },
    {
      id: "open", label: "", title: "Open PDF", width: "32px", hideable: false,
      cell: (c) => <button className="icon-btn" title="Open PDF" aria-label="Open PDF" onClick={(e) => { e.stopPropagation(); void openUrl(c.fileUrl); }}>{"↗"}</button>,
    },
  ];
}

export function Lab() {
  const navigate = useNavigate();
  const { toast } = useApp();
  const st = useCoas();
  const [params, setParams] = useSearchParams();
  const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "table";
  const setView = (v: View) => setParams(v === "table" ? {} : { view: v }, { replace: true });
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [sel, setSel] = useState<string | null>(null); // fileId
  const [linkFor, setLinkFor] = useState<Coa | null>(null);
  const [wizard, setWizard] = useState<{ mode: "upload" | "library"; prefill?: Coa[] } | null>(null);
  const [or, setOr] = useState<OpenRouterStatus | null>(null); // null = not checked yet; re-read on the next visit after Settings changes it
  const [parsing, setParsing] = useState<{ n: number; via: string } | null>(null); // which button is spinning + how many PDFs

  useEffect(() => { if (st.status === "idle") void loadCoas(); }, [st.status]);
  useEffect(() => { getOpenRouterStatus().then(setOr).catch(() => setOr({ hasKey: false, keyHint: null, defaultModel: "" })); }, []);

  const all = st.data?.coas ?? [];
  const s = q.trim().toLowerCase();
  const searched = useMemo(() => (!s ? all : all.filter((c) => `${c.batch ?? ""} ${c.productName} ${c.lab ?? ""} ${c.fileName} ${c.producer ?? ""}`.toLowerCase().includes(s))), [all, s]);
  const columns = useMemo(() => coaColumns((p) => table.setFilter("owner", [p])), []); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useTable<Coa>({ id: "coas", columns, rows: searched, defaultSort: { id: "expires", dir: "asc" } });
  const rows = table.rowsOut;
  const selected = sel ? all.find((c) => c.fileId === sel) ?? null : null;
  // ?pick=1 with ?q= (assistant: "open the COA for batch FG-24-0918"): open the single match once COAs are loaded.
  const pick = useRef(false);
  useEffect(() => { if (pick.current && st.status === "data" && s) { pick.current = false; if (rows.length === 1) setSel(rows[0].fileId); } }, [st.status, s, rows]);
  const seg = (col: "state" | "posted", v: string) => table.setFilter(col, v === "all" ? null : [v]);

  // Deep links (⌘K palette, Home shortcut, KPI buttons): ?q=<text> prefills search, ?posted=unposted presets the filter; then drop them (keep ?view).
  useEffect(() => {
    if (!params.has("q") && !params.has("posted")) return;
    if (params.get("pick") === "1") pick.current = true;
    const pq = params.get("q");
    if (pq != null) setQ(pq);
    if (params.get("posted") === "unposted") table.setFilter("posted", ["unposted"]);
    setParams(view === "table" ? {} : { view }, { replace: true });
  }, [params, setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = () => {
    const t0 = performance.now();
    void loadCoas(true).then((r) => toast(r.status === "data" ? `Synced ${r.data?.count ?? 0} COAs · ${Math.round(performance.now() - t0)} ms` : `Sync failed · ${r.error ?? "unknown error"}`));
  };
  const exportCsv = () => {
    const filename = `coas-${rows.length === all.length ? "all" : "filtered"}-${stamp()}.csv`;
    exportCoasCsv(filename, toCsv(rows))
      .then((path) => { void revealItemInDir(path); toast(`Exported ${rows.length} COAs to Downloads`); })
      .catch((e) => toast(`Export failed · ${e}`));
  };
  const openRow = (c: Coa) => { setView("table"); setSel(c.fileId); };
  const clearAll = () => { setQ(""); table.clearFilters(); };
  const unposted = rows.filter((c) => c.postedStatus === "unposted");
  const wizardDone = (msg: string) => { setWizard(null); toast(msg); void loadCoas(true); };

  // Parsing: parse_coas runs the PDFs through OpenRouter (10–40 s each, 4 at a time), then the list is re-pulled so the rows pick up the new fields.
  const hasKey = !!or?.hasKey;
  const need = all.filter((c) => !c.parsed || c.parseStale);
  const staleCount = all.filter((c) => c.parseStale).length;
  const runParse = (targets: Coa[], via: string, force = false) => {
    setParsing({ n: targets.length, via });
    parseCoas(targets.map(({ fileId, fileUrl }) => ({ fileId, fileUrl })), prefs.get(OPENROUTER_MODEL_PREF, ""), force)
      .then((r) => { toast(`Parsed ${r.parsed} · ${r.failed} failed · ${Math.round(r.elapsedMs / 1000)} s${r.failed && r.errors[0] ? ` · ${r.errors[0]}` : ""}`); return loadCoas(true); })
      .catch((e) => toast(`Parse failed · ${e}`))
      .finally(() => setParsing(null));
  };
  const parseBtn = (via: string, label: string, targets: Coa[], force = false, cls = "btn btn-control") => (
    <button className={cls} disabled={!!parsing || targets.length === 0 || !hasKey} onClick={() => runParse(targets, via, force)}
      title={hasKey ? `Parse ${targets.length} PDF${targets.length === 1 ? "" : "s"} with OpenRouter (~10–40 s each, 4 at a time)` : "Add an OpenRouter key in Settings"}>
      {parsing?.via === via && <Spinner size={12} />}{label}
    </button>
  );

  const counts = { valid: 0, expiring: 0, expired: 0, unposted: 0, page: 0, product: 0 };
  for (const c of all) { counts[c.state] += 1; if (c.postedStatus === "unposted") counts.unposted += 1; if (c.postedSource === "page" || c.postedSource === "product") counts[c.postedSource] += 1; }
  const avgDays = counts.valid ? Math.round(all.filter((c) => c.state === "valid").reduce((a, c) => a + c.daysToExpire, 0) / counts.valid) : null;
  const pp = st.data?.postedPage;
  const status = !st.data ? "" : `${st.data.count} COAs · ${counts.valid} valid · ${counts.expiring} expiring · ${counts.expired} expired · ` +
    (pp?.error ? `could not check ${pp.url.replace(/^https?:\/\//, "")} (${pp.error})` : `cross-checked ${pp?.url.replace(/^https?:\/\//, "") ?? "/pages/coa"} · found ${pp?.urlsFound ?? 0} CDN URLs`);

  const loading = st.status === "loading";
  let body: ReactNode;
  if (st.status === "idle" || (loading && !st.data)) body = <LoadingState label="Loading COAs from Shopify… (files, metaobjects and products — a few seconds)" />;
  else if (st.status === "error") {
    const scope = isScopeError(st.error, "read_files") ? "read_files" : isScopeError(st.error, "read_metaobjects") ? "read_metaobjects" : null;
    body = (
      <ErrorState
        title={scope === "read_files" ? "Missing files access" : scope ? "Missing metaobject access" : "Couldn’t reach Shopify"}
        why={scope ? `Grant the ${scope} scope to the Flow Command app on Retail (${storeById("retail").domain}), then retry.` : (st.error ?? "Unknown error").slice(0, 160)}
        actions={<>
          <button className="btn btn-primary" onClick={() => void loadCoas(true)}>Retry</button>
          <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
        </>}
      />
    );
  } else if (all.length === 0) body = <EmptyState title="No COAs in the Files library" why="Upload a lab PDF to the retail store's Files and pull again." />;
  else if (view === "calendar") body = <CalendarView coas={all} onOpen={openRow} />;
  else if (view === "labs") body = <LabsView coas={all} onPick={(lab) => { setQ(lab); table.clearFilters(); setView("table"); }} />;
  else if (view === "link") body = <LinkView coas={all} />;
  else body = (
    <div className="orders" style={{ height: "auto", flex: 1, minHeight: 0, ...(selected ? {} : { gridTemplateColumns: "minmax(0, 1fr)" }) }}>
      <div className="orders-list" style={selected ? undefined : { borderRight: 0 }}>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          <input className="input" style={{ width: 240 }} placeholder="Search batch, product, lab, file, owner" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg-sm" role="radiogroup" aria-label="State">
            {[["all", "All"], ...STATE_OPTIONS.map((o) => [o.value, o.label])].map(([v, l]) => (
              <button key={v} role="radio" aria-checked={segValue(table.filters.state) === v} className={`seg-sm-item${segValue(table.filters.state) === v ? " active" : ""}`} onClick={() => seg("state", v)}>{l}</button>
            ))}
          </div>
          <div className="seg-sm" role="radiogroup" aria-label="Posted" title="Whether customers can see the COA (on /pages/coa, a published product's metafield, or an active coa_record)">
            {[["all", "Any"], ...POSTED_OPTIONS.map((o) => [o.value, o.label])].map(([v, l]) => (
              <button key={v} role="radio" aria-checked={segValue(table.filters.posted) === v} className={`seg-sm-item${segValue(table.filters.posted) === v ? " active" : ""}`} onClick={() => seg("posted", v)}>{l}</button>
            ))}
          </div>
          <FilterButton table={table} column="owner" />
          <FilterChips table={table} exclude={["state", "posted", "owner"]} />
          <div className="spacer" />
          <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{rows.length} COAs</span>
          <ColumnsMenu table={table} />
        </div>
        <div className={`scroll${loading ? " rows-dim" : ""}`} aria-busy={loading}>
          <TableHead table={table} sticky style={TABLE_MIN} />
          {rows.length === 0 ? (
            <EmptyState title="No COAs match" why="Try another batch, product, lab or owner, or clear the filters." action={<button className="btn btn-secondary" onClick={clearAll}>Clear filters</button>} />
          ) : rows.map((c) => <TableRow key={c.fileId} table={table} row={c} style={TABLE_MIN} className={`tall${c.fileId === sel ? " selected" : ""}`} onClick={() => setSel(c.fileId === sel ? null : c.fileId)} />)}
        </div>
      </div>
      {selected && <CoaDetail key={selected.fileId} c={selected} onRelink={() => setLinkFor(selected)} onImport={() => setWizard({ mode: "library", prefill: [selected] })} reparse={parseBtn("one", "Re-parse", [selected], true, "btn btn-control btn-sm")} />}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, padding: "12px 16px 0" }}>
        {kpi("Valid", counts.valid, avgDays != null ? `avg ${avgDays}d remaining` : "—", "var(--green)")}
        {kpi("Expiring < 30d", counts.expiring, "needs re-testing", "var(--amber)")}
        {kpi("Expired", counts.expired, "remove from storefront", "var(--red)")}
        {kpi("Not posted", counts.unposted, <>
          {pp && !pp.error && <span className="ellip" title={`${counts.page} posted via /pages/coa · ${counts.product} via a product metafield`}>{counts.page} page · {counts.product} product</span>}
          <button className="btn btn-ghost btn-sm" style={{ height: 20, padding: "0 5px" }} title="Only COAs customers can't see — cleanup candidates" onClick={() => { setView("table"); table.setFilter("posted", ["unposted"]); }}>Filter →</button>
          <button className="btn btn-ghost btn-sm" style={{ height: 20, padding: "0 5px" }} title="Manually link unlinked COAs to products" onClick={() => setView("link")}>Link →</button>
        </>, "var(--sub)")}
      </div>
      <div className="toolbar">
        <div className="seg-sm" role="tablist" aria-label="View">
          {VIEWS.map((v) => <button key={v} role="tab" aria-selected={view === v} className={`seg-sm-item${view === v ? " active" : ""}`} onClick={() => setView(v)}>{VIEW_LABEL[v]}</button>)}
        </div>
        <span className="mute ellip" style={{ fontSize: 12, minWidth: 0, flex: 1 }} title={status}>{status}</span>
        {st.status === "data" && <Pill kind="green" sm>Live</Pill>}
        {st.data && (
          <span className="mute mono num" style={{ fontSize: 11, whiteSpace: "nowrap" }} title="COAs with AI-parsed fields · stale = parsed with an older prompt">
            {all.length - need.length + staleCount}/{all.length} parsed
            {staleCount > 0 && <span style={{ color: "var(--amber)" }}> · {staleCount} stale</span>}
            {or && !or.hasKey && " · no OpenRouter key"}
          </span>
        )}
        {parsing && <span className="mute" style={{ fontSize: 12, whiteSpace: "nowrap" }}>Parsing {parsing.n} PDF{parsing.n === 1 ? "" : "s"}…</span>}
        {parseBtn("five", "Parse 5", need.slice(0, 5))}
        {parseBtn("all", `Parse all (${need.length})`, need)}
        <button className="btn btn-control" onClick={sync} disabled={loading} title="Re-pull the Files library, coa_record metaobjects and products from Shopify">{loading && st.data ? "Pulling…" : "Pull from Shopify"}</button>
        <button className="btn btn-control" onClick={exportCsv} disabled={rows.length === 0} title={`Export ${rows.length} COAs to ~/Downloads`}>Export CSV</button>
        <button className="btn btn-control" disabled={unposted.length === 0} onClick={() => setWizard({ mode: "library", prefill: unposted.slice(0, BULK_MAX) })}
          title={`Import the unposted COAs in the current table through the wizard, ${BULK_MAX} at a time${unposted.length > BULK_MAX ? ` (${unposted.length} unposted — run it again for the rest)` : ""}`}>
          Bulk import{unposted.length > 0 && ` (${Math.min(unposted.length, BULK_MAX)})`}
        </button>
        <button className="btn btn-primary" onClick={() => setWizard({ mode: "upload" })}>Import COA</button>
      </div>
      {body}
      {linkFor && <LinkDialog coa={linkFor} onClose={() => setLinkFor(null)} />}
      {wizard && <CoaWizard mode={wizard.mode} prefill={wizard.prefill} onClose={() => setWizard(null)} onDone={wizardDone} />}
    </section>
  );
}

/** Compact KPI cell (~56px): coloured label, value, one-line sub. */
const kpi = (label: string, value: number, sub: ReactNode, color: string) => (
  <div className="card" style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
    <span className="label" style={{ color }}>{label}</span>
    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>{value}</span>
      <span className="mute ellip" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>{sub}</span>
    </span>
  </div>
);

// ---------- Detail pane ----------
/** Text / date / numeric input that commits on blur or Enter (Escape reverts); the row updates once save_coa_fields resolves. */
function Edit({ c, field, save, num, type = "text", mono }: { c: Coa; field: keyof Coa; save: (f: Partial<Coa>) => void; num?: boolean; type?: string; mono?: boolean }) {
  const value = c[field] as string | number | null;
  const show = (v: string | number | null) => (v == null ? "" : type === "date" ? String(v).slice(0, 10) : String(v));
  const [v, setV] = useState(show(value));
  useEffect(() => setV(show(value)), [value]);
  const commit = () => {
    const next = v.trim() === "" ? null : num ? Number(v) : v.trim();
    if (typeof next === "number" && Number.isNaN(next)) { setV(show(value)); return; }
    if (next !== (value ?? null)) save({ [field]: next } as Partial<Coa>);
  };
  return (
    <input className={`input input-dark${mono ? " mono" : ""}${num ? " num" : ""}`} type={type} value={v} placeholder="—" style={{ height: 26, fontSize: 12, width: "100%", textAlign: num ? "right" : undefined }}
      onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setV(show(value)); }} />
  );
}

/** "updated (deduped)" / "row 335 updated", or the leg's skip reason / error. */
const legText = (l: MirrorLeg, ok: string) => (l.error ? `failed · ${l.error}` : l.skipped ? `skipped · ${l.skipped}` : ok);

function CoaDetail({ c, onRelink, onImport, reparse }: { c: Coa; onRelink: () => void; onImport: () => void; reparse: ReactNode }) {
  const { toast } = useApp();
  const [reposting, setReposting] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  const gCfg = googleConfig();
  const state = coaStateLabel(c);
  // Drive PDF + Sheet row for this COA as it is in the library (no import); the toast carries both legs.
  const mirror = () => {
    setMirroring(true);
    googleMirrorCoa(gCfg, { fileUrl: c.fileUrl, pdfName: pdfNameFor(c), row: mirrorRowFromCoa(c) })
      .then((r) => toast(`Drive: ${legText(r.drive, r.drive.deduped ? "updated (deduped)" : "uploaded")} · Sheet: ${legText(r.sheet, `row ${r.sheet.rowNumber ?? "?"} ${r.sheet.action ?? "written"}`)}`))
      .catch((e) => toast(`Mirror failed · ${e}`))
      .finally(() => setMirroring(false));
  };
  const save = (fields: Partial<Coa>) =>
    saveCoaFields(c.fileId, fields).then(() => patchCoaLocal(c.fileId, fields)).catch((e) => toast(`Save failed · ${e}`));
  const clear = () =>
    saveCoaFields(c.fileId, undefined, true).then(() => { toast("Edits cleared · pulling from Shopify"); void loadCoas(true); }).catch((e) => toast(`Clear failed · ${e}`));
  // Re-writes this file's block on /pages/coa (adds it if missing) without touching the metaobject or product link.
  const repost = () => {
    setReposting(true);
    repostCoas([{ fileId: c.fileId, fileUrl: c.fileUrl, name: c.productName || null }])
      .then((r) => { const x = r.results[0]; toast(x?.ok ? `Reposted · ${x.action ?? "ok"}` : `Repost failed · ${x?.error ?? "unknown error"}`); return loadCoas(true); })
      .catch((e) => toast(`Repost failed · ${e}`))
      .finally(() => setReposting(false));
  };
  const field = (label: string, input: ReactNode) => <label className="field">{label}{input}</label>;
  return (
    <div className="detail">
      <div className="detail-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="h-heading ellip" style={{ minWidth: 0 }}>{c.batch || c.productName}</span>
          <Pill kind={state.kind}>{state.label}</Pill>
          {postedPill(c)}
        </div>
        <div className="mute mono ellip" style={{ fontSize: 11.5, marginTop: 4 }} title={c.fileName}>{c.fileName}</div>
        <div className="mute ellip" style={{ fontSize: 11.5, marginTop: 2 }}>
          {c.parsed ? `Parsed by ${c.parsedModel ?? "AI"}${c.parsedAt ? ` · ${fmtDate(c.parsedAt)}` : ""}` : "Not parsed"}
          {c.parseStale && <span style={{ color: "var(--amber)" }}> · stale — older prompt</span>}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn btn-secondary btn-sm" onClick={() => void openUrl(c.fileUrl)}>Open PDF</button>
          {reparse}
          <button className="btn btn-control btn-sm" disabled={!c.productId} onClick={() => c.productId && void openUrl(adminUrl("retail", c.productId))}>Open product in Shopify</button>
          <button className="btn btn-control btn-sm" onClick={onRelink}>{c.productId ? "Re-link" : "Link product"}</button>
          <button className="btn btn-control btn-sm" disabled={!c.edited} title="Drop the local field edits and re-read the parsed values" onClick={clear}>Clear edits</button>
          <button className="btn btn-control btn-sm" title="Review the fields, link a product and write the coa_record / product metafield / /pages/coa block" onClick={onImport}>Import…</button>
          <button className="btn btn-control btn-sm" disabled={reposting} title="Re-write this COA's block on flowgardens.com/pages/coa (a theme backup is saved first)" onClick={repost}>{reposting ? "Reposting…" : "Repost to /pages/coa"}</button>
          {googleConfigured(gCfg) && <button className="btn btn-control btn-sm" disabled={mirroring} title="Upload the PDF to the Drive folder (same name = updated in place) and add or update the Sheet row for this batch" onClick={mirror}>{mirroring ? "Mirroring…" : "Mirror to Google"}</button>}
        </div>
      </div>
      <div className="detail-section">
        <iframe src={c.fileUrl} title={c.fileName} style={{ width: "100%", height: 420, border: 0, borderRadius: 8, background: "#111" }} />
      </div>
      <div className="detail-section">
        <span className="label">Cannabinoids · editable</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          {field("THCa %", <Edit c={c} field="thca" num save={save} />)}
          {field("CBDa %", <Edit c={c} field="cbd" num save={save} />)}
          {field("CBGa %", <Edit c={c} field="cbg" num save={save} />)}
          {field("Total %", <Edit c={c} field="totalCannabinoids" num save={save} />)}
        </div>
      </div>
      <div className="detail-section">
        <span className="label">Metadata · editable</span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {field("Batch", <Edit c={c} field="batch" mono save={save} />)}
          {field("Product name", <Edit c={c} field="productName" save={save} />)}
          {field("Owner", <Edit c={c} field="producer" save={save} />)}
          {field("Strain", <Edit c={c} field="strain" save={save} />)}
          {field("Type", <Edit c={c} field="type" save={save} />)}
          {field("Lab", <Edit c={c} field="lab" save={save} />)}
          {field("Issued", <Edit c={c} field="issued" type="date" mono save={save} />)}
          {field("Expires", <Edit c={c} field="expires" type="date" mono save={save} />)}
        </div>
      </div>
      <div className="detail-section">
        <span className="label">Posted</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {postedPill(c)}
          {c.hasCoaRecord && <span className="tag" title={c.coaRecordId ?? undefined}>coa_record · {c.coaRecordStatus ?? "?"}</span>}
          {c.productOnlineStoreUrl && <button className="btn btn-ghost btn-sm" style={{ height: 22 }} onClick={() => void openUrl(c.productOnlineStoreUrl!)}>view live ↗</button>}
        </div>
        <div className="mute" style={{ fontSize: 12, marginTop: 6 }}>{c.postedReason}</div>
      </div>
      <div className="detail-section">
        <span className="label">Terpenes</span>
        {c.terpenes.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>None parsed</div> : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {c.terpenes.map((t) => <span key={t.name} className="tag num">{t.name} · {t.pct != null ? `${t.pct.toFixed(2)}%` : "—"}</span>)}
          </div>
        )}
        {/* ponytail: display only; the terpene editor comes with the import slice that writes overrides back to Shopify. */}
      </div>
      <div className="detail-section">
        <span className="label">Notes</span>
        <Notes c={c} save={save} />
      </div>
    </div>
  );
}
function Notes({ c, save }: { c: Coa; save: (f: Partial<Coa>) => void }) {
  const [v, setV] = useState(c.notes ?? "");
  useEffect(() => setV(c.notes ?? ""), [c.notes]);
  return (
    <textarea className="input input-dark" value={v} placeholder="Internal notes (kept with the local edits)" style={{ width: "100%", height: 72, padding: 8, resize: "vertical", fontFamily: "inherit" }}
      onChange={(e) => setV(e.target.value)} onBlur={() => { if ((v.trim() || null) !== (c.notes ?? null)) save({ notes: v.trim() || null }); }} />
  );
}

// ---------- Product search (Re-link dialog + Link view + the wizard's Map step) ----------
/** Debounced retail title search; `pickLabel` renders a button per hit, otherwise hits are radio-style (check + selectedId). */
export function ProductSearch({ selectedId, onPick, pickLabel, autoFocus = true }: { selectedId?: string | null; onPick: (p: ProductHit) => void; pickLabel?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [hits, setHits] = useState<ProductHit[] | null>(null); // null = nothing searched yet
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dq.trim()) { setHits(null); return; }
    let alive = true;
    setBusy(true);
    searchProducts(dq).then((r) => alive && setHits(r)).catch(() => alive && setHits([])).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [dq]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input autoFocus={autoFocus} className="input input-dark" placeholder="Search retail products by title" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 320, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {busy && <div className="mute" style={{ padding: "6px 8px", fontSize: 12 }}>Searching…</div>}
        {!busy && hits?.length === 0 && <div className="mute" style={{ padding: "6px 8px", fontSize: 12 }}>No products match</div>}
        {hits?.map((p) => {
          const stt = productStatus(p.status), on = p.id === selectedId;
          return (
            <button key={p.id} type="button" className="menu-item" style={{ height: 40, background: on ? "var(--accent-soft)" : undefined }} onClick={() => onPick(p)}>
              {!pickLabel && <span className={`check${on ? " on" : ""}`} />}
              <span className="two-line grow"><span className="ellip" style={{ fontWeight: 500 }}>{p.title}</span><span className="second mono ellip">{p.handle}</span></span>
              <Pill kind={stt.kind} sm dot={false}>{stt.label}</Pill>
              {pickLabel && <span className="btn btn-secondary btn-sm">{pickLabel}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Small dialog (ReceiveSheet chrome): pick a product to link, or clear the link. */
function LinkDialog({ coa, onClose }: { coa: Coa; onClose: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const link = (p: ProductHit | null) => {
    setBusy(true);
    saveCoaLink(coa.fileId, p?.id ?? null, p?.title ?? null)
      .then(() => { relinkCoaLocal(coa.fileId, p?.id ?? null, p?.title ?? null); toast(p ? `Linked ${baseName(coa.fileName)} → ${p.title}` : `Unlinked ${baseName(coa.fileName)}`); onClose(); })
      .catch((e) => { toast(`Link failed · ${e}`); setBusy(false); });
  };
  return (
    <div className="overlay center" onClick={onClose}>
      <div className="dialog sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Link product">
        <div className="sheet-head">
          <div className="title">Link product</div>
          <div className="why ellip">{baseName(coa.fileName)}{coa.productId && ` · currently ${coa.productName}`}</div>
        </div>
        <div style={{ padding: "12px 18px" }}><ProductSearch pickLabel="Link" onPick={(p) => !busy && link(p)} /></div>
        <div className="sheet-foot">
          {coa.productId && <button className="btn btn-control" disabled={busy} onClick={() => link(null)}>Unlink</button>}
          <div className="spacer" />
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Calendar view ----------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthStartUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonthsUTC = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
/** 6 × 7 cells from the Sunday on/before the 1st — always 42 so the grid never shifts between months (UTC, like the expiry dates). */
function buildCalendarGrid(monthStart: Date): Date[] {
  const start = new Date(monthStart);
  start.setUTCDate(start.getUTCDate() - monthStart.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d; });
}
const chipColor = (c: Coa) => (c.state === "expired" ? "var(--mute)" : c.daysToExpire < 7 ? "var(--red)" : c.daysToExpire < 30 ? "var(--amber)" : "var(--green)");

function CalendarView({ coas, onOpen }: { coas: Coa[]; onOpen: (c: Coa) => void }) {
  const [month, setMonth] = useState(() => monthStartUTC(new Date()));
  const [lab, setLab] = useState("all");
  const labs = useMemo(() => [...new Set(coas.map((c) => c.lab).filter((l): l is string => !!l))].sort(), [coas]);
  const shown = lab === "all" ? coas : coas.filter((c) => c.lab === lab);
  const byDay = new Map<string, Coa[]>();
  for (const c of shown) { const k = c.expires.slice(0, 10); byDay.set(k, [...(byDay.get(k) ?? []), c]); }
  const next = addMonthsUTC(month, 1);
  const inMonth = shown.filter((c) => { const t = new Date(c.expires); return t >= month && t < next; });
  const urgent = inMonth.filter((c) => c.state !== "expired" && c.daysToExpire < 7).length;
  const soon = inMonth.filter((c) => c.state !== "expired" && c.daysToExpire >= 7 && c.daysToExpire < 30).length;
  const late = inMonth.filter((c) => c.state === "expired").length;
  const todayKey = new Date().toISOString().slice(0, 10);
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 12 }}>
        <button className="btn btn-control btn-sm" aria-label="Previous month" onClick={() => setMonth(addMonthsUTC(month, -1))}>‹</button>
        <span className="strong" style={{ minWidth: 150, textAlign: "center" }}>{MONTH.format(month)}</span>
        <button className="btn btn-control btn-sm" aria-label="Next month" onClick={() => setMonth(addMonthsUTC(month, 1))}>›</button>
        <button className="btn btn-control btn-sm" onClick={() => setMonth(monthStartUTC(new Date()))}>Today</button>
        <span className="mute num" style={{ fontSize: 12 }}>
          {inMonth.length} this month
          {urgent > 0 && <span style={{ color: "var(--red)" }}> · {urgent} &lt; 7d</span>}
          {soon > 0 && <span style={{ color: "var(--amber)" }}> · {soon} &lt; 30d</span>}
          {late > 0 && <span> · {late} expired</span>}
        </span>
        <div className="spacer" />
        <select className="input" style={{ height: 28 }} value={lab} onChange={(e) => setLab(e.target.value)} aria-label="Lab">
          <option value="all">All labs</option>
          {labs.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div className="cal">
        {DOW.map((d) => <div key={d} className="label" style={{ textAlign: "center", padding: "2px 0 4px" }}>{d}</div>)}
        {buildCalendarGrid(month).map((d) => {
          const key = d.toISOString().slice(0, 10), items = byDay.get(key) ?? [], today = key === todayKey;
          return (
            <div key={key} className={`cal-cell${d.getUTCMonth() !== month.getUTCMonth() ? " out" : ""}${today ? " today" : ""}`}>
              <div className="cal-day" style={today ? { color: "var(--accent)", fontWeight: 600 } : undefined}>{d.getUTCDate()}</div>
              {items.slice(0, 3).map((c) => (
                <button key={c.fileId} type="button" className="cal-chip" style={{ background: `color-mix(in srgb, ${chipColor(c)} 18%, transparent)`, color: chipColor(c) }}
                  title={`${baseName(c.fileName)} · ${c.state} · ${c.daysToExpire}d`} onClick={() => onOpen(c)}>{c.productName || baseName(c.fileName)}</button>
              ))}
              {items.length > 3 && (
                <button type="button" className="cal-chip mute" style={{ background: "transparent" }} title={items.slice(3).map((c) => baseName(c.fileName)).join("\n")} onClick={() => onOpen(items[3])}>+{items.length - 3} more</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Labs view ----------
const LABS_COLS = "minmax(0, 1.4fr) 70px 90px 90px 130px 130px 110px 32px";
function Spark({ data }: { data: number[] }) {
  const w = 90, h = 20, max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`);
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill="var(--accent-soft)" />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.2" />
    </svg>
  );
}
function LabsView({ coas, onPick }: { coas: Coa[]; onPick: (lab: string) => void }) {
  const labs = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7));
    const by = new Map<string, Coa[]>();
    for (const c of coas) { const k = c.lab ?? ""; by.set(k, [...(by.get(k) ?? []), c]); }
    return [...by].map(([name, list]) => {
      const issued = list.map((c) => c.issued).filter(Boolean).sort();
      const thca = list.filter((c) => c.thca != null);
      return {
        name, total: list.length, parsed: Math.round((list.filter((c) => c.parsed).length / list.length) * 100),
        avgThca: thca.length ? thca.reduce((a, c) => a + (c.thca ?? 0), 0) / thca.length : null,
        earliest: issued[0] ?? null, latest: issued[issued.length - 1] ?? null,
        spark: months.map((m) => list.filter((c) => c.issued.slice(0, 7) === m).length),
      };
    }).sort((a, b) => b.total - a.total);
  }, [coas]);
  return (
    <>
      <div className="thead" style={{ gridTemplateColumns: LABS_COLS }}>
        <span>Lab</span><span className="r">COAs</span><span className="r">% parsed</span><span className="r">Avg THCa</span><span>Earliest issued</span><span>Latest issued</span><span>12-month volume</span><span />
      </div>
      <div className="scroll">
        {labs.map((l) => (
          <div key={l.name} className="row tall" style={{ gridTemplateColumns: LABS_COLS, cursor: "pointer" }} title="Filter the Table view to this lab" onClick={() => onPick(l.name)}>
            <span className="ellip" style={{ fontWeight: 500, color: l.name ? "var(--text)" : "var(--mute)" }}>{l.name || "— unattributed —"}</span>
            <span className="r">{l.total}</span>
            <span className="r" style={{ color: l.parsed >= 80 ? "var(--green)" : l.parsed >= 50 ? "var(--amber)" : "var(--mute)" }}>{l.parsed}%</span>
            <span className="r">{l.avgThca != null ? `${l.avgThca.toFixed(2)}%` : "—"}</span>
            <span className="sub">{l.earliest ? fmtDate(l.earliest) : "—"}</span>
            <span className="sub">{l.latest ? fmtDate(l.latest) : "—"}</span>
            <span><Spark data={l.spark} /></span>
            <span className="mute" style={{ textAlign: "right" }}>›</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Link view ----------
function LinkView({ coas }: { coas: Coa[] }) {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [coaId, setCoaId] = useState<string | null>(null);
  const [prod, setProd] = useState<ProductHit | null>(null);
  const [busy, setBusy] = useState(false);
  const s = q.trim().toLowerCase();
  const unlinked = coas
    .filter((c) => !c.productId && c.state !== "expired" && (!s || `${c.fileName} ${c.batch ?? ""} ${c.lab ?? ""}`.toLowerCase().includes(s)))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const coa = coaId ? coas.find((c) => c.fileId === coaId) ?? null : null;
  const link = () => {
    if (!coa || !prod) return;
    setBusy(true);
    saveCoaLink(coa.fileId, prod.id, prod.title)
      .then(() => { relinkCoaLocal(coa.fileId, prod.id, prod.title); toast(`Linked ${baseName(coa.fileName)} → ${prod.title}`); setCoaId(null); setProd(null); })
      .catch((e) => toast(`Link failed · ${e}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className="scroll" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="grid-2">
        <div className="card clip">
          <div className="card-head"><span>Unlinked COAs</span><span className="meta">{unlinked.length} · valid or expiring</span></div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <input className="input input-dark" placeholder="Filter by file, batch or lab" value={q} onChange={(e) => setQ(e.target.value)} />
            {unlinked.length === 0 ? <div className="mute" style={{ padding: "16px 8px", fontSize: 12, textAlign: "center" }}>Nothing unlinked — every non-expired COA has a product.</div> : (
              <div style={{ maxHeight: 360, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {unlinked.map((c) => {
                  const on = c.fileId === coaId, stt = coaStateLabel(c);
                  return (
                    <button key={c.fileId} type="button" className="menu-item" style={{ height: 44, background: on ? "var(--accent-soft)" : undefined }} onClick={() => setCoaId(on ? null : c.fileId)}>
                      <span className={`check${on ? " on" : ""}`} />
                      <span className="two-line grow">
                        <span className="ellip" style={{ fontWeight: 500 }}>{baseName(c.fileName)}</span>
                        <span className="second ellip">{c.lab ?? "—"} · issued {fmtDate(c.issued)}{c.thca != null && ` · THCa ${c.thca.toFixed(2)}%`}</span>
                      </span>
                      <Pill kind={stt.kind} sm>{stt.label}</Pill>
                      <span className="icon-btn" role="button" title="Open PDF" onClick={(e) => { e.stopPropagation(); void openUrl(c.fileUrl); }}>{"↗"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="card clip">
          <div className="card-head"><span>Products</span><span className="meta">Retail · search by title</span></div>
          <div style={{ padding: 8 }}><ProductSearch selectedId={prod?.id} onPick={(p) => setProd(p.id === prod?.id ? null : p)} /></div>
        </div>
      </div>
      <div className="card card-pad" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
        <span className="label">COA</span>
        <span className="ellip" style={{ minWidth: 0, flex: 1 }}>{coa ? baseName(coa.fileName) : <span className="mute">none selected</span>}</span>
        <span className="mute">→</span>
        <span className="label">Product</span>
        <span className="ellip" style={{ minWidth: 0, flex: 1 }}>{prod ? prod.title : <span className="mute">none selected</span>}</span>
        <button className="btn btn-control" disabled={!coa && !prod} onClick={() => { setCoaId(null); setProd(null); }}>Clear</button>
        <button className="btn btn-primary" disabled={!coa || !prod || busy} onClick={link}>{busy ? "Linking…" : "Link COA"}</button>
      </div>
    </div>
  );
}

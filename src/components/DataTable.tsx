// Table chrome built on useTable(): sortable / filterable / drag-reorderable header, column-visibility menu,
// active-filter chips, page-size picker and a row renderer. Styling: ".thead .th", ".popover", ".menu-item",
// ".chip" etc. in App.css — same dark shell vocabulary as the rest of the app.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { type ColumnDef, type Table, isFilterSet } from "../lib/table";

// ---------- Popover ----------
/** Anchored panel: render inside a `position: relative` parent (`.th`, `.pop-anchor`). Closes on outside click / Escape. */
export function Popover({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key, true); };
  }, [onClose]);

  // Right-align when the panel would run off the window's right edge (last columns, toolbar buttons).
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.right > window.innerWidth - 12) setFlip(true);
  }, []);

  return (
    <div ref={ref} className={`popover${flip ? " right" : ""}`} role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

// ---------- Filter editor (shared by header funnel + toolbar button) ----------
function FilterEditor<Row>({ table, col, onDone }: { table: Table<Row>; col: ColumnDef<Row>; onDone: () => void }) {
  const f = col.filter!;
  const v = table.filters[col.id];
  if (f.kind === "text") {
    return (
      <div style={{ padding: 4, display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="popover-title" style={{ padding: "2px 4px 0" }}>{col.label} contains</div>
        <input
          autoFocus
          className="input input-dark"
          style={{ width: 220 }}
          placeholder={f.placeholder ?? "Type to filter…"}
          value={typeof v === "string" ? v : ""}
          onChange={(e) => table.setFilter(col.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onDone(); }}
        />
        <div className="menu-foot">
          <button type="button" className="btn btn-control btn-sm" disabled={!isFilterSet(v)} onClick={() => { table.setFilter(col.id, null); onDone(); }}>Clear</button>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }
  const selected = Array.isArray(v) ? v : [];
  const options = table.options(col);
  const toggle = (value: string) =>
    table.setFilter(col.id, selected.includes(value) ? selected.filter((x) => x !== value) : [...selected, value]);
  return (
    <div style={{ minWidth: 200 }}>
      <div className="popover-title">{col.label}</div>
      {options.length === 0 && <div className="mute" style={{ padding: "6px 8px", fontSize: 12 }}>No values</div>}
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button key={o.value} type="button" role="menuitemcheckbox" aria-checked={on} className="menu-item" onClick={() => toggle(o.value)}>
            <span className={`check${on ? " on" : ""}`} />
            <span className="grow">{o.label}</span>
          </button>
        );
      })}
      <div className="menu-sep" />
      <div className="menu-foot">
        <button type="button" className="btn btn-control btn-sm" disabled={selected.length === 0} onClick={() => table.setFilter(col.id, null)}>Clear</button>
        <div className="spacer" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

const Funnel = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
    <path d="M1.5 2h9L7.2 6.4V10L4.8 8.8V6.4z" />
  </svg>
);

/** Toolbar button that opens a column's filter (e.g. "Status · Draft"). */
export function FilterButton<Row>({ table, column, label }: { table: Table<Row>; column: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const col = table.all.find((c) => c.id === column);
  if (!col?.filter) return null;
  const active = table.activeFilters.find((f) => f.column.id === column);
  return (
    <span className="pop-anchor">
      <button type="button" className={`btn btn-control${active ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label ?? col.label} <span className="muted">{active ? active.label : "All"}</span>
      </button>
      {open && <Popover label={`Filter ${col.label}`} onClose={() => setOpen(false)}><FilterEditor table={table} col={col} onDone={() => setOpen(false)} /></Popover>}
    </span>
  );
}

// ---------- Header ----------
// Column reordering uses Pointer Events rather than HTML5 drag-and-drop: the latter is intercepted by Tauri's
// native drag-drop handler inside WKWebView and is flaky under automation.
interface Drag { id: string | null; over: string | null; after: boolean }
const NO_DRAG: Drag = { id: null, over: null, after: false };
const DRAG_THRESHOLD = 5;

export function TableHead<Row>({ table, sticky, className, style }: { table: Table<Row>; sticky?: boolean; className?: string; style?: CSSProperties }) {
  const [drag, setDrag] = useState<Drag>(NO_DRAG);
  const dragRef = useRef<Drag>(NO_DRAG);
  const headRef = useRef<HTMLDivElement>(null);
  const moveTo = useRef(table.moveTo);
  moveTo.current = table.moveTo;
  // Set when a press turned into a drag, so a sort click landing on the same header afterwards is swallowed.
  const swallowClick = useRef(false);
  const update = (d: Drag) => { dragRef.current = d; setDrag(d); };

  // No pointer capture: capturing retargets the follow-up `click` to the header cell and would break the sort
  // buttons. Move/up are tracked on the document for the duration of the press instead.
  const onPointerDown = (col: ColumnDef<Row>) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (col.fixed || e.button !== 0 || (e.target as HTMLElement).closest(".th-filter, .popover")) return;
    swallowClick.current = false;
    const press = { id: col.id, x: e.clientX, active: false };
    const onMove = (ev: PointerEvent) => {
      if (!press.active) {
        if (Math.abs(ev.clientX - press.x) < DRAG_THRESHOLD) return;
        press.active = true;
      }
      let over: string | null = null, after = false;
      headRef.current?.querySelectorAll<HTMLElement>("[data-col]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && el.dataset.col !== press.id && el.dataset.fixed !== "true") {
          over = el.dataset.col ?? null;
          after = ev.clientX > r.left + r.width / 2;
        }
      });
      const cur = dragRef.current;
      if (cur.id !== press.id || cur.over !== over || cur.after !== after) update({ id: press.id, over, after });
    };
    const finish = (drop: boolean) => () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      if (press.active) {
        swallowClick.current = true;
        const d = dragRef.current;
        if (drop && d.over && d.over !== press.id) moveTo.current(press.id, d.over, d.after);
        update(NO_DRAG);
      }
    };
    const onUp = finish(true), onCancel = finish(false);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  };

  return (
    <div ref={headRef} className={`thead${sticky ? " sticky" : ""}${drag.id ? " dragging" : ""}${className ? ` ${className}` : ""}`} role="row" style={{ ...style, gridTemplateColumns: table.gridTemplate }}>
      {table.columns.map((col) => <Th key={col.id} table={table} col={col} drag={drag} swallowClick={swallowClick} onPointerDown={onPointerDown(col)} />)}
    </div>
  );
}

function Th<Row>({ table, col, drag, swallowClick, onPointerDown }: {
  table: Table<Row>; col: ColumnDef<Row>; drag: Drag; swallowClick: { current: boolean }; onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const dir = table.sort?.id === col.id ? table.sort.dir : null;
  const sortable = table.isSortable(col);
  const filterOn = isFilterSet(table.filters[col.id]);
  const over = drag.over === col.id && drag.id !== col.id;

  const cls = ["th", col.align === "right" ? "r" : "", dir ? "sorted" : "", col.fixed ? "" : "movable", drag.id === col.id ? "dragging" : "", over ? (drag.after ? "drop-after" : "drop-before") : ""]
    .filter(Boolean).join(" ");
  const ariaSort = dir === "asc" ? "ascending" : dir === "desc" ? "descending" : sortable ? "none" : undefined;
  const onSort = () => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    table.toggleSort(col.id);
  };

  return (
    <div className={cls} role="columnheader" aria-sort={ariaSort} title={col.title} data-col={col.id} data-fixed={col.fixed ? "true" : undefined} onPointerDown={onPointerDown}>
      {col.header ?? (sortable ? (
        <button type="button" className="th-sort" onClick={onSort} aria-label={`Sort by ${col.label}${dir === "asc" ? " (descending)" : dir === "desc" ? " (ascending)" : ""}`}>
          <span className="lbl">{col.label}</span>
          {dir && <span className="th-arrow" aria-hidden="true">{dir === "asc" ? "↑" : "↓"}</span>}
        </button>
      ) : (
        <span className="lbl ellip">{col.label}</span>
      ))}
      {col.filter && (
        <>
          <button
            type="button"
            className={`th-filter${filterOn ? " on" : ""}`}
            aria-label={`Filter ${col.label}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={(e: MouseEvent) => { e.stopPropagation(); setOpen((o) => !o); }}
          >
            <Funnel />
          </button>
          {open && <Popover label={`Filter ${col.label}`} onClose={() => setOpen(false)}><FilterEditor table={table} col={col} onDone={() => setOpen(false)} /></Popover>}
        </>
      )}
    </div>
  );
}

// ---------- Column visibility / order menu ----------
export function ColumnsMenu<Row>({ table }: { table: Table<Row> }) {
  const [open, setOpen] = useState(false);
  const movable = table.all.filter((c) => !c.fixed);
  return (
    <span className="pop-anchor">
      <button type="button" className={`btn btn-control${table.hiddenCount ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open} title="Show, hide and reorder columns" onClick={() => setOpen((o) => !o)}>
        Columns{table.hiddenCount > 0 && <span className="muted">{movable.length - table.hiddenCount}/{movable.length}</span>}
      </button>
      {open && (
        <Popover label="Columns" onClose={() => setOpen(false)}>
          <div className="popover-title">Columns</div>
          {movable.map((c, i) => {
            const shown = !table.isHidden(c.id);
            const name = c.label || c.title || c.id;
            return (
              <div key={c.id} className="menu-row">
                <button type="button" role="menuitemcheckbox" aria-checked={shown} className="menu-item grow" disabled={c.hideable === false} onClick={() => table.setHidden(c.id, shown)}>
                  <span className={`check${shown ? " on" : ""}`} />
                  <span className="grow">{name}</span>
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${name} left`} disabled={i === 0} onClick={() => table.moveBy(c.id, -1)}>‹</button>
                <button type="button" className="icon-btn" aria-label={`Move ${name} right`} disabled={i === movable.length - 1} onClick={() => table.moveBy(c.id, 1)}>›</button>
              </div>
            );
          })}
          <div className="menu-sep" />
          <div className="menu-foot">
            <span className="mute" style={{ fontSize: 11.5, alignSelf: "center" }}>Drag headers to reorder</span>
            <div className="spacer" />
            <button type="button" className="btn btn-control btn-sm" onClick={() => { table.reset(); setOpen(false); }}>Reset</button>
          </div>
        </Popover>
      )}
    </span>
  );
}

// ---------- Active filter chips ----------
export function FilterChips<Row>({ table, exclude = [] }: { table: Table<Row>; exclude?: string[] }) {
  const chips = table.activeFilters.filter((f) => !exclude.includes(f.column.id));
  if (!chips.length) return null;
  return (
    <>
      {chips.map((f) => (
        <span key={f.column.id} className="chip">
          <span className="k">{f.column.label}</span>
          <span className="ellip" style={{ maxWidth: 160 }}>{f.label}</span>
          <button type="button" className="x" aria-label={`Clear ${f.column.label} filter`} onClick={() => table.setFilter(f.column.id, null)}>×</button>
        </span>
      ))}
      {chips.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={table.clearFilters}>Clear all</button>}
    </>
  );
}

// ---------- Page size ----------
export function PageSizePicker<Row>({ table }: { table: Table<Row> }) {
  return (
    <div className="seg-sm" role="radiogroup" aria-label="Rows per page">
      {table.pageSizes.map((n) => (
        <button key={n} type="button" role="radio" aria-checked={table.pageSize === n} className={`seg-sm-item${table.pageSize === n ? " active" : ""}`} onClick={() => table.setPageSize(n)}>{n}</button>
      ))}
    </div>
  );
}

// ---------- Row ----------
export function TableRow<Row>({ table, row, className, style, onClick }: {
  table: Table<Row>; row: Row; className?: string; style?: CSSProperties; onClick?: () => void;
}) {
  return (
    <div className={`row${className ? ` ${className}` : ""}`} role="row" style={{ ...style, gridTemplateColumns: table.gridTemplate }} onClick={onClick}>
      {table.columns.map((c) => (
        <span key={c.id} role="cell" className={table.cellClass(c, row) || undefined} style={c.cellStyle?.(row)}>{c.cell(row)}</span>
      ))}
    </div>
  );
}

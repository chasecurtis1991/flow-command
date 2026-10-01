// Headless table state shared by the Orders, Catalog and Inventory tables: column order, visibility,
// sort, per-column filters and (optionally) page size. Column order / visibility / sort / page size persist
// in localStorage under `fc.table.<id>`; filters are per-session. Client-side tables pass `rows` and read
// `rowsOut`; server-side tables (Orders) read `sort` / `filters` and ask Shopify instead.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type SortDir = "asc" | "desc";
export interface Sort { id: string; dir: SortDir }
/** Text filters are a string; enum filters are the selected values. */
export type FilterValue = string | string[];
export interface EnumOption { value: string; label: string }

export type ColumnFilter<Row> =
  | { kind: "text"; value: (row: Row) => string; placeholder?: string }
  | { kind: "enum"; value: (row: Row) => string | null; options?: EnumOption[] };

export interface ColumnDef<Row> {
  id: string;
  label: string;
  /** CSS grid track, e.g. "110px" or "minmax(0, 1fr)". */
  width: string;
  align?: "left" | "right";
  /** Header tooltip. */
  title?: string;
  /** Custom header content (replaces the label; the column is then not sortable). */
  header?: ReactNode;
  cell: (row: Row) => ReactNode;
  cellClass?: string | ((row: Row) => string | undefined);
  cellStyle?: (row: Row) => CSSProperties | undefined;
  /** Client-side sort accessor. Omit for server-side tables and set `sortable: true` instead. */
  sortValue?: (row: Row) => string | number | null | undefined;
  sortable?: boolean;
  /** Direction used on the first click (default asc). */
  sortDir?: SortDir;
  filter?: ColumnFilter<Row>;
  hideable?: boolean;
  /** Pinned to the front; not draggable or hideable. */
  fixed?: boolean;
  defaultHidden?: boolean;
}

export interface UseTableOptions<Row> {
  /** Persistence key (fc.table.<id>). */
  id: string;
  columns: ColumnDef<Row>[];
  /** Client-side data; drives `rowsOut` and derived enum options. */
  rows?: Row[];
  defaultSort?: Sort | null;
  initialFilters?: Record<string, FilterValue>;
  /** When set, the table also manages (and persists) a page size. */
  pageSizes?: readonly number[];
  defaultPageSize?: number;
}

export interface ActiveFilter<Row> { column: ColumnDef<Row>; value: FilterValue; label: string }

export interface Table<Row> {
  id: string;
  /** Every column in the current order, hidden ones included. */
  all: ColumnDef<Row>[];
  /** Visible columns in order — what the header and rows render. */
  columns: ColumnDef<Row>[];
  gridTemplate: string;
  sort: Sort | null;
  isSortable: (col: ColumnDef<Row>) => boolean;
  toggleSort: (id: string) => void;
  filters: Record<string, FilterValue>;
  activeFilters: ActiveFilter<Row>[];
  setFilter: (id: string, value: FilterValue | null) => void;
  clearFilters: () => void;
  options: (col: ColumnDef<Row>) => EnumOption[];
  isHidden: (id: string) => boolean;
  setHidden: (id: string, hidden: boolean) => void;
  hiddenCount: number;
  /** Drop `id` before/after `targetId`. */
  moveTo: (id: string, targetId: string, after: boolean) => void;
  /** Nudge `id` by `delta` positions among the movable columns. */
  moveBy: (id: string, delta: number) => void;
  /** Order, visibility, sort and page size back to defaults. */
  reset: () => void;
  /** Filtered + sorted `rows` (client-side tables). */
  rowsOut: Row[];
  pageSize: number;
  pageSizes: readonly number[];
  setPageSize: (n: number) => void;
  cellClass: (col: ColumnDef<Row>, row: Row) => string;
}

// ---- persistence ----
interface Saved { order?: string[]; hidden?: string[]; sort?: Sort | null; pageSize?: number }
const key = (id: string) => `fc.table.${id}`;
function loadSaved(id: string): Saved {
  try {
    const raw = localStorage.getItem(key(id));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Saved) : {};
  } catch { return {}; }
}
function persist(id: string, s: Saved) {
  try { localStorage.setItem(key(id), JSON.stringify(s)); } catch { /* private mode etc. */ }
}

// ---- helpers ----
const ids = <R,>(cols: ColumnDef<R>[]) => cols.map((c) => c.id);
/** Saved order, dropping unknown ids and appending new columns; fixed columns stay pinned at the front. */
function reconcileOrder<R>(cols: ColumnDef<R>[], saved?: string[]): string[] {
  const known = new Set(ids(cols));
  const kept = (saved ?? []).filter((id) => known.has(id));
  const seen = new Set(kept);
  const merged = [...kept, ...ids(cols).filter((id) => !seen.has(id))];
  const fixed = cols.filter((c) => c.fixed).map((c) => c.id);
  return [...fixed, ...merged.filter((id) => !fixed.includes(id))];
}
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const empty = (v: unknown) => v == null || v === "";
function compare(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  // Blanks sink to the bottom in either direction.
  if (empty(a) || empty(b)) return empty(a) && empty(b) ? 0 : empty(a) ? 1 : -1;
  const r = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return dir === "asc" ? r : -r;
}

export function applyFilters<R>(rows: R[], cols: ColumnDef<R>[], filters: Record<string, FilterValue>): R[] {
  const active = cols.filter((c) => c.filter && filters[c.id] != null);
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((c) => {
      const f = c.filter!, v = filters[c.id];
      if (f.kind === "text") return typeof v === "string" ? f.value(row).toLowerCase().includes(v.trim().toLowerCase()) : true;
      return Array.isArray(v) ? v.includes(f.value(row) ?? "") : true;
    }));
}
export function applySort<R>(rows: R[], col: ColumnDef<R> | undefined, dir: SortDir): R[] {
  if (!col?.sortValue) return rows;
  const get = col.sortValue;
  return rows.map((row, i) => ({ row, i, v: get(row) })).sort((a, b) => compare(a.v, b.v, dir) || a.i - b.i).map((x) => x.row);
}

export const isFilterSet = (v: FilterValue | null | undefined) => (typeof v === "string" ? v.trim().length > 0 : Array.isArray(v) && v.length > 0);
export const sameSet = (a: FilterValue | undefined, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

/** Trailing-edge debounce for values that drive network requests (search text, filter strings). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

// ---- the hook ----
export function useTable<Row>(opts: UseTableOptions<Row>): Table<Row> {
  const { id, columns, rows, defaultSort = null, pageSizes = [], defaultPageSize } = opts;
  const saved = useRef<Saved | null>(null);
  if (saved.current === null) saved.current = loadSaved(id);
  const [order, setOrder] = useState<string[]>(() => reconcileOrder(columns, saved.current?.order));
  const [hidden, setHidden] = useState<string[]>(() =>
    saved.current?.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id));
  const [sort, setSort] = useState<Sort | null>(() => (saved.current?.sort === undefined ? defaultSort : saved.current.sort));
  const [filters, setFilters] = useState<Record<string, FilterValue>>(opts.initialFilters ?? {});
  const [pageSize, setPageSizeState] = useState<number>(() => {
    const fallback = defaultPageSize ?? pageSizes[0] ?? 50;
    const s = saved.current?.pageSize;
    return s != null && (pageSizes.length === 0 || pageSizes.includes(s)) ? s : fallback;
  });

  // Columns can be redefined (e.g. a cell closes over page state); keep the order in step without clobbering the user's.
  const colIds = ids(columns).join("|");
  useEffect(() => {
    setOrder((o) => { const next = reconcileOrder(columns, o); return sameOrder(o, next) ? o : next; });
  }, [colIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    persist(id, { order, hidden, sort, ...(pageSizes.length ? { pageSize } : {}) });
  }, [id, order, hidden, sort, pageSize, pageSizes.length]);

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const all = useMemo(() => order.map((oid) => byId.get(oid)).filter((c): c is ColumnDef<Row> => !!c), [order, byId]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = useMemo(() => all.filter((c) => c.fixed || !hiddenSet.has(c.id)), [all, hiddenSet]);
  const gridTemplate = useMemo(() => visible.map((c) => c.width).join(" "), [visible]);

  const isSortable = useCallback((col: ColumnDef<Row>) => !col.header && (col.sortable ?? !!col.sortValue), []);
  const toggleSort = useCallback((cid: string) => {
    const col = byId.get(cid);
    if (!col) return;
    setSort((s) => (s?.id === cid ? { id: cid, dir: s.dir === "asc" ? "desc" : "asc" } : { id: cid, dir: col.sortDir ?? "asc" }));
  }, [byId]);

  const setFilter = useCallback((cid: string, value: FilterValue | null) => {
    setFilters((f) => {
      if (!isFilterSet(value)) { if (!(cid in f)) return f; const { [cid]: _drop, ...rest } = f; return rest; }
      return { ...f, [cid]: value as FilterValue };
    });
  }, []);
  const clearFilters = useCallback(() => setFilters({}), []);

  const options = useCallback((col: ColumnDef<Row>): EnumOption[] => {
    if (col.filter?.kind !== "enum") return [];
    if (col.filter.options) return col.filter.options;
    const get = col.filter.value;
    const vals = [...new Set((rows ?? []).map((r) => get(r) ?? ""))].sort((a, b) => collator.compare(a, b));
    return vals.map((v) => ({ value: v, label: v || "(blank)" }));
  }, [rows]);

  const activeFilters = useMemo<ActiveFilter<Row>[]>(() =>
    all.flatMap((col): ActiveFilter<Row>[] => {
      const v = filters[col.id];
      if (!col.filter || !isFilterSet(v)) return [];
      if (typeof v === "string") return [{ column: col, value: v, label: `“${v.trim()}”` }];
      const labels = options(col).filter((o) => v.includes(o.value)).map((o) => o.label);
      return [{ column: col, value: v, label: labels.length > 2 ? `${labels.length} selected` : labels.join(", ") || `${v.length} selected` }];
    }), [all, filters, options]);

  const isHidden = useCallback((cid: string) => hiddenSet.has(cid), [hiddenSet]);
  const setHiddenFor = useCallback((cid: string, h: boolean) => {
    const col = byId.get(cid);
    if (!col || col.fixed || col.hideable === false) return;
    setHidden((hs) => (h ? (hs.includes(cid) ? hs : [...hs, cid]) : hs.filter((x) => x !== cid)));
  }, [byId]);

  const moveTo = useCallback((cid: string, targetId: string, after: boolean) => {
    setOrder((o) => {
      const col = byId.get(cid), target = byId.get(targetId);
      if (!col || !target || col.fixed || target.fixed || cid === targetId) return o;
      const without = o.filter((x) => x !== cid);
      const at = without.indexOf(targetId) + (after ? 1 : 0);
      return [...without.slice(0, at), cid, ...without.slice(at)];
    });
  }, [byId]);
  const moveBy = useCallback((cid: string, delta: number) => {
    setOrder((o) => {
      const movable = o.filter((x) => !byId.get(x)?.fixed);
      const i = movable.indexOf(cid);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= movable.length) return o;
      const next = [...movable];
      next.splice(i, 1);
      next.splice(j, 0, cid);
      return [...o.filter((x) => byId.get(x)?.fixed), ...next];
    });
  }, [byId]);

  const reset = useCallback(() => {
    setOrder(reconcileOrder(columns));
    setHidden(columns.filter((c) => c.defaultHidden).map((c) => c.id));
    setSort(defaultSort);
    setPageSizeState(defaultPageSize ?? pageSizes[0] ?? 50);
  }, [columns, defaultSort, defaultPageSize, pageSizes]);

  const setPageSize = useCallback((n: number) => { if (!pageSizes.length || pageSizes.includes(n)) setPageSizeState(n); }, [pageSizes]);

  const rowsOut = useMemo(() => {
    if (!rows) return [];
    const filtered = applyFilters(rows, all, filters);
    return sort ? applySort(filtered, byId.get(sort.id), sort.dir) : filtered;
  }, [rows, all, filters, sort, byId]);

  const cellClass = useCallback((col: ColumnDef<Row>, row: Row) => {
    const own = typeof col.cellClass === "function" ? col.cellClass(row) : col.cellClass;
    return [col.align === "right" ? "r" : "", own ?? ""].filter(Boolean).join(" ");
  }, []);

  return {
    id, all, columns: visible, gridTemplate, sort, isSortable, toggleSort, filters, activeFilters, setFilter, clearFilters, options,
    isHidden, setHidden: setHiddenFor, hiddenCount: all.filter((c) => !c.fixed && hiddenSet.has(c.id)).length, moveTo, moveBy, reset,
    rowsOut, pageSize, pageSizes, setPageSize, cellClass,
  };
}

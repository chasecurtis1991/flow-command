import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import {
  FINANCIAL_FILTER_VALUES, FULFILLMENT_FILTER_VALUES, OPEN_WORK_STATUSES, ORDER_DEFAULT_PAGE_SIZE, ORDER_PAGE_SIZES,
  type LineItem, type Order, type OrderDetail, type OrderSortKey, type OrdersRequest, type StoreId,
  buildOrdersQuery, channelLabel, ensureOrdersPage, fmtCreated, fulStatus, getOrder, goToOrdersPage, isOpenFulfillment, loadOrdersPage, money, moneyNum,
  adminUrl, payStatus, storeById, useOrders, useOrdersTable,
} from "../lib/shopify";
import { type ColumnDef, sameSet, useDebounced, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";
import { ColumnsMenu, FilterChips, PageSizePicker, TableHead, TableRow } from "../components/DataTable";
import { OrderNotes } from "./OrderNotes";

const lineTotal = (li: LineItem) => money(`${(moneyNum(li.price) * li.quantity).toFixed(2)} ${li.price.split(/\s+/)[1] ?? "USD"}`);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const nf = new Intl.NumberFormat("en-US");

// Sorting and filtering happen in Shopify (the table is one page of many), so columns declare `sortable`
// and map to OrderSortKeys instead of providing client-side accessors.
const SORT_KEYS: Record<string, OrderSortKey> = {
  order: "ORDER_NUMBER", created: "CREATED_AT", customer: "CUSTOMER_NAME", total: "TOTAL_PRICE", payment: "FINANCIAL_STATUS", fulfillment: "FULFILLMENT_STATUS",
};
const DEFAULT_SORT = { id: "created", dir: "desc" as const };

function orderColumns(selectedId: string | null): ColumnDef<Order>[] {
  return [
    { id: "sel", label: "", width: "28px", fixed: true, header: <span className="check" />, cell: (o) => <span className={`check${o.id === selectedId ? " on" : ""}`} /> },
    {
      id: "order", label: "Order", width: "110px", sortable: true, cellStyle: () => ({ fontWeight: 500 }),
      filter: { kind: "text", value: (o) => o.name, placeholder: "Order number" }, cell: (o) => o.name,
    },
    { id: "created", label: "Created", width: "130px", sortable: true, sortDir: "desc", cellClass: "sub", cell: (o) => fmtCreated(o.createdAt) },
    {
      id: "customer", label: "Customer", width: "minmax(0, 1fr)", sortable: true, cellClass: "ellip",
      filter: { kind: "text", value: (o) => `${o.customerName ?? ""} ${o.customerEmail ?? ""}`, placeholder: "Name or email" },
      cell: (o) => o.customerName ?? o.customerEmail ?? "—",
    },
    { id: "total", label: "Total", width: "100px", align: "right", sortable: true, sortDir: "desc", cell: (o) => money(o.totalPrice) },
    {
      id: "payment", label: "Payment", width: "110px", sortable: true,
      filter: { kind: "enum", value: (o) => o.displayFinancialStatus, options: FINANCIAL_FILTER_VALUES.map((v) => ({ value: v, label: payStatus(v).label })) },
      cell: (o) => { const p = payStatus(o.displayFinancialStatus); return <Pill kind={p.kind}>{p.label}</Pill>; },
    },
    {
      id: "fulfillment", label: "Fulfillment", width: "120px", sortable: true,
      filter: { kind: "enum", value: (o) => o.displayFulfillmentStatus, options: FULFILLMENT_FILTER_VALUES.map((v) => ({ value: v, label: fulStatus(v).label })) },
      cell: (o) => { const f = fulStatus(o.displayFulfillmentStatus); return <Pill kind={f.kind}>{f.label}</Pill>; },
    },
  ];
}

export function Orders() {
  const navigate = useNavigate();
  const { store, storeReady, refresh } = useApp();
  const recent = useOrders(); // 50 most recent (Layout warms it) — used to resolve ⌘K deep links
  const tbl = useOrdersTable();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");

  // Selection lives in ?sel=<gid> so the ⌘K palette can deep-link; default to the first row of the page.
  const selParam = params.get("sel");
  const inPage = !!selParam && tbl.orders.some((o) => o.id === selParam);
  const recentSel = selParam ? recent.orders.find((o) => o.id === selParam) : undefined;
  const selectedId = selParam && (inPage || recentSel) ? selParam : tbl.orders[0]?.id ?? null;
  const select = (id: string) => setParams({ sel: id }, { replace: true });

  const columns = useMemo(() => orderColumns(selectedId), [selectedId]);
  const table = useTable<Order>({
    id: "orders", columns, defaultSort: DEFAULT_SORT, pageSizes: ORDER_PAGE_SIZES, defaultPageSize: ORDER_DEFAULT_PAGE_SIZE,
    initialFilters: { fulfillment: [...OPEN_WORK_STATUSES] },
  });
  const unfulfilledOnly = sameSet(table.filters.fulfillment, OPEN_WORK_STATUSES);
  const toggleUnfulfilled = () => table.setFilter("fulfillment", unfulfilledOnly ? null : [...OPEN_WORK_STATUSES]);
  // A deep link to a fulfilled/closed order widens the view so its row can show.
  useEffect(() => { if (recentSel && !isOpenFulfillment(recentSel) && unfulfilledOnly) table.setFilter("fulfillment", null); }, [recentSel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything Shopify needs for the page; text is debounced so typing doesn't fire a request per keystroke.
  const query = useDebounced(buildOrdersQuery({
    text: q, name: str(table.filters.order), customer: str(table.filters.customer),
    financial: arr(table.filters.payment), fulfillment: arr(table.filters.fulfillment), openOnly: unfulfilledOnly,
  }), 300);
  const sort = table.sort ?? DEFAULT_SORT;
  const request = useMemo<OrdersRequest>(() => ({
    pageSize: table.pageSize, sortKey: SORT_KEYS[sort.id] ?? "CREATED_AT", reverse: sort.dir === "desc", query,
  }), [table.pageSize, sort.id, sort.dir, query]);

  // Store / sort / filter / page-size changes go back to page 1; invalidation (⌘R) refetches the current page.
  useEffect(() => { if (storeReady) ensureOrdersPage(store, request); }, [storeReady, store, request, tbl.status]);

  const [detail, setDetail] = useState<{ id: string; data?: OrderDetail; error?: string }>({ id: "" });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!selectedId) { setDetail({ id: "" }); return; }
    let alive = true;
    setDetail({ id: selectedId });
    getOrder(selectedId)
      .then((d) => alive && setDetail({ id: selectedId, data: d }))
      .catch((e) => alive && setDetail({ id: selectedId, error: String(e) }));
    return () => { alive = false; };
  }, [selectedId, reload]);

  const loading = tbl.status === "loading";
  const canPrev = tbl.page > 1 && !loading;
  const canNext = tbl.hasNextPage && !loading;
  const prev = useCallback(() => { if (canPrev) goToOrdersPage(tbl.page - 1); }, [canPrev, tbl.page]);
  const next = useCallback(() => { if (canNext) goToOrdersPage(tbl.page + 1); }, [canNext, tbl.page]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); next(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = tbl.orders;
    const i = rows.findIndex((o) => o.id === selectedId);
    const to = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (to) select(to.id);
  };

  // Honest counts: Shopify's ordersCount for this exact query (AT_LEAST past 10,000), else just "more available".
  const size = request.pageSize;
  const first = (tbl.page - 1) * size + 1, last = (tbl.page - 1) * size + tbl.orders.length;
  const total = tbl.total;
  const totalLabel = total ? `${nf.format(total.count)}${total.precision === "AT_LEAST" ? "+" : ""}` : null;
  const pageCount = total ? Math.max(tbl.page, Math.ceil(total.count / size)) : null;
  const rangeLabel = tbl.status !== "data" && tbl.orders.length === 0 ? "" :
    totalLabel ? `${nf.format(first)}–${nf.format(last)} of ${totalLabel}` : `${nf.format(first)}–${nf.format(last)}${tbl.hasNextPage ? " · more available" : ""}`;

  const clearAll = () => { setQ(""); table.clearFilters(); };

  let body;
  if (tbl.status === "idle" || (loading && (tbl.orders.length === 0 || tbl.store !== store))) body = <LoadingState label="Loading orders from Shopify…" />;
  else if (tbl.status === "error") body = (
    <ErrorState title="Couldn’t reach Shopify" why={(tbl.error ?? "Unknown error").slice(0, 160)} actions={<>
      <button className="btn btn-primary" onClick={() => void loadOrdersPage(store, request, tbl.page)}>Retry</button>
      <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
    </>} />
  );
  else if (tbl.orders.length === 0) body = (
    <EmptyState title="No orders match" why={request.query ? "Try a broader search or clear the filters." : `${storeById(store).label} has no orders yet.`}
      action={request.query ? <button className="btn btn-secondary" onClick={clearAll}>Clear filters</button> : undefined} />
  );
  else body = (
    <div className={`scroll${loading ? " rows-dim" : ""}`} tabIndex={0} onKeyDown={onKey} aria-busy={loading}>
      {tbl.orders.map((o, i) => (
        <TableRow key={o.id} table={table} row={o} className={`stagger${o.id === selectedId ? " selected" : ""}`}
          style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }} onClick={() => select(o.id)} />
      ))}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className="orders">
        <div className="orders-list">
          <div className="toolbar" style={{ flexWrap: "wrap" }}>
            <input className="input" style={{ width: 240 }} placeholder="Search orders and customers" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className={`btn btn-control${unfulfilledOnly ? " on" : ""}`} title="Open orders that still need fulfillment (unfulfilled, partial, on hold, scheduled)" onClick={toggleUnfulfilled}>
              Unfulfilled {unfulfilledOnly && <span className="sub">×</span>}
            </button>
            <FilterChips table={table} exclude={unfulfilledOnly ? ["fulfillment"] : []} />
            <div className="spacer" />
            <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {totalLabel ? `${totalLabel} orders` : tbl.status === "data" ? `${tbl.orders.length} on this page` : ""}
            </span>
            <ColumnsMenu table={table} />
            <button className="btn btn-control" onClick={refresh}>Refresh</button>
          </div>
          <TableHead table={table} sticky />
          {body}
          <div className="table-foot">
            <span className="num">{rangeLabel}</span>
            <div className="spacer" />
            <span className="mute">Rows</span>
            <PageSizePicker table={table} />
            <button className="btn btn-control btn-sm" disabled={!canPrev} onClick={prev} aria-label="Previous page">‹ Prev</button>
            <span className="page num">Page {nf.format(tbl.page)}{pageCount ? ` of ${nf.format(pageCount)}${total?.precision === "AT_LEAST" ? "+" : ""}` : ""}</span>
            <button className="btn btn-control btn-sm" disabled={!canNext} onClick={next} aria-label="Next page">Next ›</button>
          </div>
        </div>
        <Detail store={store} id={detail.id} data={detail.data} error={detail.error} onReload={() => setReload((n) => n + 1)}
          onSaved={(v) => setDetail((d) => (d.data ? { ...d, data: { ...d.data, ...v } } : d))} />
      </div>
    </section>
  );
}

function Detail({ store, id, data, error, onSaved, onReload }: {
  store: StoreId; id: string; data?: OrderDetail; error?: string; onSaved: (v: { note: string | null; tags: string[] }) => void; onReload: () => void;
}) {
  if (!id) return <div className="detail"><div className="state mute">Select an order</div></div>;
  if (!data) {
    return <div className="detail" key={id}>{error ? <ErrorState title="Couldn’t load order" why={error.slice(0, 160)} /> : <LoadingState label="Loading order…" />}</div>;
  }
  const pay = payStatus(data.displayFinancialStatus), ful = fulStatus(data.displayFulfillmentStatus);
  return (
    <div className="detail" key={id}>
      <div className="detail-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="h-heading">{data.name}</span>
          <Pill kind={pay.kind} dot={false}>{pay.label}</Pill>
          <Pill kind={ful.kind} dot={false}>{ful.label}</Pill>
        </div>
        <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>{fmtCreated(data.createdAt)} · {storeById(store).label} · {channelLabel(data.channel)}</div>
      </div>
      <div className="detail-section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <span className="label">Customer</span>
          <div style={{ fontWeight: 500 }}>{data.customerName ?? "—"}</div>
          {data.customerEmail && <div className="sub" style={{ fontSize: 12 }}>{data.customerEmail}</div>}
          {data.customerOrdersCount != null && <div className="sub" style={{ fontSize: 12 }}>{data.customerOrdersCount} orders</div>}
        </div>
        <div>
          <span className="label">Ship to</span>
          <div className="soft" style={{ fontSize: 12.5, whiteSpace: "pre-line" }}>{data.shippingAddress ?? "—"}</div>
        </div>
      </div>
      <div className="detail-section">
        <span className="label" style={{ marginBottom: 8 }}>Line items</span>
        <div className="cols-items" style={{ display: "grid", gap: 8, fontSize: 11.5, color: "var(--mute)", paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <span>Item</span><span className="r">Qty</span><span className="r">Price</span>
        </div>
        {data.lineItems.map((li, i) => (
          <div key={i} className="cols-items num" style={{ display: "grid", gap: 8, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div className="ellip">{li.title}</div>
              {li.sku && <div className="mute mono" style={{ fontSize: 11.5 }}>{li.sku}</div>}
            </div>
            <span className="r soft">{li.quantity}</span>
            <span className="r">{lineTotal(li)}</span>
          </div>
        ))}
        <div className="totals">
          <span>Subtotal</span><span className="r">{money(data.subtotalPrice)}</span>
          <span>Shipping</span><span className="r">{data.totalShipping ? money(data.totalShipping) : "—"}</span>
          {moneyNum(data.totalTax) > 0 && <><span>Tax</span><span className="r">{money(data.totalTax)}</span></>}
          <span className="total">Total</span><span className="total r">{money(data.totalPrice)}</span>
        </div>
      </div>
      <OrderNotes store={store} data={data} onSaved={onSaved} onReload={onReload} />
      <div className="detail-section" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="label" style={{ marginBottom: 0 }}>Actions</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-control grow" disabled>Fulfill</button>
          <button className="btn btn-control grow" disabled>Refund</button>
          <button className="btn btn-secondary" onClick={() => void openUrl(adminUrl(store, data.id))}>Open in Shopify</button>
        </div>
        <div className="mute" style={{ fontSize: 11.5 }}>Fulfill and refund ship in a later release.</div>
      </div>
    </div>
  );
}

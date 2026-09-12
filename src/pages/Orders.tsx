import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import {
  type LineItem, type OrderDetail, type StoreId, channelLabel, fmtCreated, fulStatus, getOrder, isOpenFulfillment, loadOrders, money, moneyNum,
  orderAdminUrl, payStatus, storeById, useOrders,
} from "../lib/shopify";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";

const lineTotal = (li: LineItem) => money(`${(moneyNum(li.price) * li.quantity).toFixed(2)} ${li.price.split(/\s+/)[1] ?? "USD"}`);

export function Orders() {
  const navigate = useNavigate();
  const { store, storeReady, refresh } = useApp();
  const cache = useOrders();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [unfulfilledOnly, setUnfulfilledOnly] = useState(true);
  const [detail, setDetail] = useState<{ id: string; data?: OrderDetail; error?: string }>({ id: "" });

  useEffect(() => {
    if (storeReady && (cache.status === "idle" || (cache.store !== store && cache.status !== "loading"))) void loadOrders(store);
  }, [storeReady, store, cache.status, cache.store]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return cache.orders.filter((o) =>
      (!unfulfilledOnly || isOpenFulfillment(o)) && (!s || `${o.name} ${o.customerName ?? ""} ${o.customerEmail ?? ""}`.toLowerCase().includes(s)));
  }, [cache.orders, q, unfulfilledOnly]);

  // Selection lives in ?sel=<gid> so the ⌘K palette can deep-link; default to the first visible row.
  const selParam = params.get("sel");
  const selOrder = selParam ? cache.orders.find((o) => o.id === selParam) : undefined;
  const selectedId = selOrder?.id ?? filtered[0]?.id ?? null;
  const select = (id: string) => setParams({ sel: id }, { replace: true });
  useEffect(() => { if (selOrder && !isOpenFulfillment(selOrder)) setUnfulfilledOnly(false); }, [selOrder]);

  useEffect(() => {
    if (!selectedId) { setDetail({ id: "" }); return; }
    let alive = true;
    setDetail({ id: selectedId });
    getOrder(selectedId)
      .then((d) => alive && setDetail({ id: selectedId, data: d }))
      .catch((e) => alive && setDetail({ id: selectedId, error: String(e) }));
    return () => { alive = false; };
  }, [selectedId]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = filtered.findIndex((o) => o.id === selectedId);
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next.id);
  };

  let body;
  if (cache.status === "loading" || cache.status === "idle") body = <LoadingState label="Loading orders from Shopify…" />;
  else if (cache.status === "error") body = (
    <ErrorState title="Couldn’t reach Shopify" why={(cache.error ?? "Unknown error").slice(0, 160)} actions={<>
      <button className="btn btn-primary" onClick={() => void loadOrders(store, true)}>Retry</button>
      <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
    </>} />
  );
  else if (filtered.length === 0) body = (
    <EmptyState title="No orders match" why="Try widening the date range or clearing the Unfulfilled filter."
      action={<button className="btn btn-secondary" onClick={() => { setQ(""); setUnfulfilledOnly(false); }}>Clear filters</button>} />
  );
  else body = (
    <div className="scroll" tabIndex={0} onKeyDown={onKey}>
      {filtered.map((o, i) => {
        const pay = payStatus(o.displayFinancialStatus), ful = fulStatus(o.displayFulfillmentStatus), on = o.id === selectedId;
        return (
          <div key={o.id} className={`row stagger cols-orders${on ? " selected" : ""}`} style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }} onClick={() => select(o.id)}>
            <span><span className={`check${on ? " on" : ""}`} /></span>
            <span style={{ fontWeight: 500 }}>{o.name}</span>
            <span className="sub">{fmtCreated(o.createdAt)}</span>
            <span className="ellip">{o.customerName ?? o.customerEmail ?? "—"}</span>
            <span className="r">{money(o.totalPrice)}</span>
            <span><Pill kind={pay.kind}>{pay.label}</Pill></span>
            <span><Pill kind={ful.kind}>{ful.label}</Pill></span>
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className="orders">
        <div className="orders-list">
          <div className="toolbar">
            <input className="input" style={{ width: 280 }} placeholder="Search orders, customers, SKUs" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-control">Status <span className="muted">All</span></button>
            <button className="btn btn-control">Date <span className="muted">Last 30 days</span></button>
            <button className={`btn btn-control${unfulfilledOnly ? " on" : ""}`} onClick={() => setUnfulfilledOnly((v) => !v)}>
              Unfulfilled {unfulfilledOnly && <span className="sub">×</span>}
            </button>
            <div className="spacer" />
            <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{filtered.length} orders</span>
            <button className="btn btn-control" onClick={refresh}>Refresh</button>
          </div>
          <div className="thead sticky cols-orders">
            <span><span className="check" /></span><span>Order</span><span>Created</span><span>Customer</span><span className="r">Total</span><span>Payment</span><span>Fulfillment</span>
          </div>
          {body}
        </div>
        <Detail store={store} id={detail.id} data={detail.data} error={detail.error} />
      </div>
    </section>
  );
}

function Detail({ store, id, data, error }: { store: StoreId; id: string; data?: OrderDetail; error?: string }) {
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
      <div className="detail-section">
        <span className="label">Notes</span>
        <div className="note-box">{data.note ?? "—"}</div>
      </div>
      <div className="detail-section" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="label" style={{ marginBottom: 0 }}>Actions</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-control grow" disabled>Fulfill</button>
          <button className="btn btn-control grow" disabled>Refund</button>
          <button className="btn btn-secondary" onClick={() => void openUrl(orderAdminUrl(store, data.id))}>Open in Shopify</button>
        </div>
        <div className="mute" style={{ fontSize: 11.5 }}>Write actions ship in a later release. Read-only mirror of Shopify today.</div>
      </div>
    </div>
  );
}

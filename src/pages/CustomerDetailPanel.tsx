import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type CustomerDetail, type StoreId, adminUrl, fmtCreated, fulStatus, getCustomer, money, payStatus, useOrders } from "../lib/shopify";
import { ErrorState, LoadingState, Pill } from "../components/ui";

const nice = (s: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "—");
const since = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(iso));

/** Right-hand panel on Customers: who they are, how to reach them, and their latest orders. */
export function CustomerDetailPanel({ store, id, onClose }: { store: StoreId; id: string; onClose: () => void }) {
  const navigate = useNavigate();
  const recent = useOrders(); // orders the Orders page can deep-link to; older ones open in Shopify
  const [c, setC] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setC(null); setError(null);
    getCustomer(store, id).then((d) => alive && setC(d)).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [store, id, attempt]);

  const openOrder = (orderId: string) => {
    if (recent.store === store && recent.orders.some((o) => o.id === orderId)) navigate(`/orders?sel=${encodeURIComponent(orderId)}`);
    else void openUrl(adminUrl(store, orderId));
  };
  const head = (
    <div className="panel-close"><button className="icon-btn" aria-label="Close customer" title="Close (Esc)" onClick={onClose}>×</button></div>
  );

  if (error) return <div className="detail">{head}<ErrorState title="Couldn’t load customer" why={error.slice(0, 200)} actions={<button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>Retry</button>} /></div>;
  if (!c) return <div className="detail">{head}<LoadingState label="Loading customer…" /></div>;
  const aov = c.ordersCount ? money(`${(parseFloat(c.amountSpent) / c.ordersCount).toFixed(2)} ${c.amountSpent.split(" ")[1] ?? "USD"}`) : "—";

  return (
    <div className="detail" key={c.id}>
      {head}
      <div className="detail-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="h-heading">{c.displayName}</span>
          {c.state === "ENABLED" && <Pill kind="green" dot={false}>Has account</Pill>}
          {c.taxExempt && <Pill kind="neutral" dot={false}>Tax exempt</Pill>}
        </div>
        <div className="mute" style={{ fontSize: 12, marginTop: 4 }}>Customer since {since(c.createdAt)}{c.companies.length ? ` · ${c.companies.join(", ")}` : ""}</div>
      </div>
      <div className="detail-section">
        <div className="cust-stats">
          <div><span className="label">Orders</span><strong>{c.ordersCount}</strong></div>
          <div><span className="label">Lifetime</span><strong>{c.amountSpent ? money(c.amountSpent) : "—"}</strong></div>
          <div><span className="label">Avg order</span><strong>{aov}</strong></div>
        </div>
      </div>
      <div className="detail-section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <span className="label">Contact</span>
          {c.email ? <button className="link-btn" style={{ display: "block", textAlign: "left" }} onClick={() => void openUrl(`mailto:${c.email}`)}>{c.email}</button> : <div className="mute">No email</div>}
          {c.phone && <div className="soft" style={{ fontSize: 12.5 }}>{c.phone}</div>}
          <div className="mute" style={{ fontSize: 11.5, marginTop: 4 }}>
            Email: {nice(c.emailMarketing)}{c.email && !c.verifiedEmail ? " · unverified" : ""}{c.smsMarketing ? ` · SMS: ${nice(c.smsMarketing)}` : ""}
          </div>
        </div>
        <div>
          <span className="label">Default address</span>
          <div className="soft" style={{ fontSize: 12.5, whiteSpace: "pre-line" }}>{c.address ?? "—"}</div>
        </div>
      </div>
      {(c.tags.length > 0 || c.note) && (
        <div className="detail-section">
          <span className="label">Notes &amp; tags</span>
          {c.tags.length > 0 && <div className="tag-row">{c.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</div>}
          {c.note && <div className="note-box">{c.note}</div>}
        </div>
      )}
      <div className="detail-section">
        <span className="label">Recent orders</span>
        {c.recentOrders.length === 0 ? <div className="mute" style={{ fontSize: 12 }}>No orders yet.</div> : c.recentOrders.map((o) => {
          const pay = payStatus(o.financialStatus), ful = fulStatus(o.fulfillmentStatus);
          return (
            <button key={o.id} type="button" className="cust-order" onClick={() => openOrder(o.id)} title="Open order">
              <span className="two-line"><span className="mono" style={{ fontWeight: 500 }}>{o.name}</span><span className="second">{fmtCreated(o.createdAt)}</span></span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{o.cancelled ? <Pill kind="red" sm>Cancelled</Pill> : <><Pill kind={pay.kind} sm>{pay.label}</Pill><Pill kind={ful.kind} sm>{ful.label}</Pill></>}</span>
              <span className="num r">{o.total ? money(o.total) : "—"}</span>
            </button>
          );
        })}
        {c.ordersCount > c.recentOrders.length && <div className="mute" style={{ fontSize: 11.5, marginTop: 6 }}>Showing the latest {c.recentOrders.length} of {c.ordersCount}.</div>}
      </div>
      <div className="detail-section" style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-secondary" onClick={() => void openUrl(adminUrl(store, c.id))}>Open in Shopify</button>
      </div>
    </div>
  );
}

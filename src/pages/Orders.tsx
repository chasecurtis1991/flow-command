import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Order {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPrice: string;
  customerName: string | null;
  customerEmail: string | null;
}

interface OrderDetail {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPrice: string;
  subtotalPrice: string;
  totalTax: string;
  customerName: string | null;
  customerEmail: string | null;
  lineItems: LineItem[];
}

interface LineItem {
  title: string;
  sku: string | null;
  quantity: number;
  price: string;
}

export function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOrders();

    const handleStoreChange = () => {
      setSelectedOrder(null);
      loadOrders();
    };
    window.addEventListener("storeChanged", handleStoreChange);
    return () => window.removeEventListener("storeChanged", handleStoreChange);
  }, []);

  async function loadOrders() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<Order[]>("list_orders", { first: 50 });
      setOrders(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadOrderDetail(orderId: string) {
    setDetailLoading(true);
    setError(null);
    try {
      const detail = await invoke<OrderDetail>("get_order", { orderId });
      setSelectedOrder(detail);
    } catch (err) {
      setError(String(err));
      setSelectedOrder(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function formatDate(isoDate: string): string {
    try {
      const date = new Date(isoDate);
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch {
      return isoDate;
    }
  }

  function getStatusClass(status: string | null): string {
    if (!status) return "";
    const lower = status.toLowerCase();
    if (lower.includes('paid')) return 'paid';
    if (lower.includes('fulfilled')) return 'fulfilled';
    if (lower.includes('pending') || lower.includes('unfulfilled')) return 'pending';
    return '';
  }

  return (
    <div className="page-container" style={{ paddingRight: selectedOrder ? '460px' : '40px', position: 'relative', transition: 'padding-right 0.2s ease' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="Search orders..."
            style={{
              flex: 1,
              padding: '0 12px',
              height: '32px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              fontSize: '13px'
            }}
          />
          <button className="btn btn-secondary">Filter</button>
        </div>
        <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
          {orders.length} orders
        </span>
        <button 
          className="btn btn-secondary" 
          onClick={loadOrders}
          disabled={loading}
        >
          {loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Orders Table */}
      <div className="card" style={{ padding: 0 }}>
        {loading && <div className="loading-state">Loading orders...</div>}

        {!loading && orders.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">📦</div>
            <div>No orders found</div>
          </div>
        )}

        {!loading && orders.length > 0 && (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ORDER</th>
                  <th>DATE</th>
                  <th>CUSTOMER</th>
                  <th>TOTAL</th>
                  <th>PAYMENT</th>
                  <th>FULFILLMENT</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    onClick={() => loadOrderDetail(order.id)}
                    className={selectedOrder?.id === order.id ? "selected" : ""}
                  >
                    <td style={{ color: 'var(--accent-primary)', fontWeight: 500 }}>
                      {order.name}
                    </td>
                    <td style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>
                      {formatDate(order.createdAt)}
                    </td>
                    <td>{order.customerName || order.customerEmail || "—"}</td>
                    <td style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {order.totalPrice}
                    </td>
                    <td>
                      {order.displayFinancialStatus && (
                        <span className={`status-pill ${getStatusClass(order.displayFinancialStatus)}`}>
                          <span className="dot"></span>
                          {order.displayFinancialStatus}
                        </span>
                      )}
                    </td>
                    <td>
                      {order.displayFulfillmentStatus && (
                        <span className={`status-pill ${getStatusClass(order.displayFulfillmentStatus)}`}>
                          <span className="dot"></span>
                          {order.displayFulfillmentStatus}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {(selectedOrder || detailLoading) && (
        <div style={{
          position: 'fixed',
          right: 0,
          top: 'var(--topbar-height)',
          bottom: 0,
          width: '420px',
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          overflowY: 'auto',
          padding: '24px',
          zIndex: 100
        }}>
          {detailLoading && (
            <div className="loading-state">Loading order details...</div>
          )}

          {selectedOrder && !detailLoading && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                <div>
                  <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '4px' }}>
                    {selectedOrder.name}
                  </h2>
                  <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    {formatDate(selectedOrder.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedOrder(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-tertiary)',
                    fontSize: '20px',
                    cursor: 'pointer',
                    padding: '4px 8px'
                  }}
                >
                  ✕
                </button>
              </div>

              <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
                  Customer
                </div>
                <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>
                  {selectedOrder.customerName || "No name"}
                </div>
                {selectedOrder.customerEmail && (
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    {selectedOrder.customerEmail}
                  </div>
                )}
              </div>

              <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
                  Status
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Payment</span>
                    {selectedOrder.displayFinancialStatus && (
                      <span className={`status-pill ${getStatusClass(selectedOrder.displayFinancialStatus)}`}>
                        <span className="dot"></span>
                        {selectedOrder.displayFinancialStatus}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Fulfillment</span>
                    {selectedOrder.displayFulfillmentStatus && (
                      <span className={`status-pill ${getStatusClass(selectedOrder.displayFulfillmentStatus)}`}>
                        <span className="dot"></span>
                        {selectedOrder.displayFulfillmentStatus}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
                  Line Items ({selectedOrder.lineItems.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {selectedOrder.lineItems.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '10px', borderBottom: idx < selectedOrder.lineItems.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '13px', marginBottom: '2px' }}>
                          {item.title}
                        </div>
                        {item.sku && (
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'Monaco, monospace' }}>
                            SKU: {item.sku}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '13px' }}>×{item.quantity}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                          {item.price}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Subtotal</span>
                    <span>{selectedOrder.subtotalPrice}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Tax</span>
                    <span>{selectedOrder.totalTax}</span>
                  </div>
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    fontSize: '15px', 
                    fontWeight: 600, 
                    paddingTop: '8px', 
                    borderTop: '1px solid var(--border-subtle)',
                    marginTop: '4px'
                  }}>
                    <span>Total</span>
                    <span>{selectedOrder.totalPrice}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

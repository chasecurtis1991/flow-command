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

    // Listen for store changes
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
      return new Date(isoDate).toLocaleString();
    } catch {
      return isoDate;
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h2>Orders</h2>
            <p className="page-subtitle">Recent orders from Shopify</p>
          </div>
          <button 
            className="btn btn-primary" 
            onClick={loadOrders}
            disabled={loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="page-content orders-layout">
        {/* Orders List */}
        <div className="orders-list-panel">
          <div className="card">
            <h3>Orders ({orders.length})</h3>
            
            {loading && <div className="loading-state">Loading orders...</div>}

            {!loading && orders.length === 0 && (
              <div className="empty-state">No orders found</div>
            )}

            {!loading && orders.length > 0 && (
              <div className="orders-table">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>Total</th>
                      <th>Payment</th>
                      <th>Fulfillment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr
                        key={order.id}
                        onClick={() => loadOrderDetail(order.id)}
                        className={selectedOrder?.id === order.id ? "selected" : ""}
                      >
                        <td className="order-name">{order.name}</td>
                        <td className="order-date">{formatDate(order.createdAt)}</td>
                        <td>
                          {order.customerName || order.customerEmail || "—"}
                        </td>
                        <td className="order-price">{order.totalPrice}</td>
                        <td>
                          <span className={`status-badge status-${order.displayFinancialStatus?.toLowerCase()}`}>
                            {order.displayFinancialStatus || "—"}
                          </span>
                        </td>
                        <td>
                          <span className={`status-badge status-${order.displayFulfillmentStatus?.toLowerCase()}`}>
                            {order.displayFulfillmentStatus || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Order Detail Panel */}
        <div className="orders-detail-panel">
          {!selectedOrder && !detailLoading && (
            <div className="card empty-detail">
              <p>Select an order to view details</p>
            </div>
          )}

          {detailLoading && (
            <div className="card">
              <div className="loading-state">Loading order details...</div>
            </div>
          )}

          {selectedOrder && !detailLoading && (
            <div className="card">
              <div className="order-detail-header">
                <div>
                  <h3>{selectedOrder.name}</h3>
                  <p className="order-detail-date">{formatDate(selectedOrder.createdAt)}</p>
                </div>
                <button 
                  className="btn-close"
                  onClick={() => setSelectedOrder(null)}
                  title="Close"
                >
                  ✕
                </button>
              </div>

              <div className="order-detail-section">
                <h4>Customer</h4>
                <p>{selectedOrder.customerName || "No name"}</p>
                {selectedOrder.customerEmail && (
                  <p className="detail-muted">{selectedOrder.customerEmail}</p>
                )}
              </div>

              <div className="order-detail-section">
                <h4>Status</h4>
                <div className="status-row">
                  <span className="status-label">Payment:</span>
                  <span className={`status-badge status-${selectedOrder.displayFinancialStatus?.toLowerCase()}`}>
                    {selectedOrder.displayFinancialStatus || "—"}
                  </span>
                </div>
                <div className="status-row">
                  <span className="status-label">Fulfillment:</span>
                  <span className={`status-badge status-${selectedOrder.displayFulfillmentStatus?.toLowerCase()}`}>
                    {selectedOrder.displayFulfillmentStatus || "—"}
                  </span>
                </div>
              </div>

              <div className="order-detail-section">
                <h4>Line Items ({selectedOrder.lineItems.length})</h4>
                <div className="line-items-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>SKU</th>
                        <th>Qty</th>
                        <th>Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedOrder.lineItems.map((item, idx) => (
                        <tr key={idx}>
                          <td>{item.title}</td>
                          <td className="detail-muted">{item.sku || "—"}</td>
                          <td>{item.quantity}</td>
                          <td>{item.price}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="order-detail-section order-totals">
                <div className="total-row">
                  <span>Subtotal:</span>
                  <span>{selectedOrder.subtotalPrice}</span>
                </div>
                <div className="total-row">
                  <span>Tax:</span>
                  <span>{selectedOrder.totalTax}</span>
                </div>
                <div className="total-row total-final">
                  <span>Total:</span>
                  <span>{selectedOrder.totalPrice}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

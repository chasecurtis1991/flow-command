import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function Home() {
  const [shopifyStatus, setShopifyStatus] = useState<string>("checking...");
  const [shopInfo, setShopInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkHealth();
  }, []);

  async function checkHealth() {
    try {
      const result = await invoke<string>("ping");
      setShopifyStatus(result);
    } catch (error) {
      setShopifyStatus(`Error: ${error}`);
    }
  }

  async function fetchShopInfo() {
    setLoading(true);
    try {
      const info = await invoke<any>("fetch_shop_info");
      setShopInfo(info);
    } catch (error) {
      console.error("Failed to fetch shop info:", error);
      setShopInfo({ error: String(error) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Home</h2>
        <p className="page-subtitle">Flow Gardens Operations Dashboard</p>
      </div>

      <div className="page-content">
        <div className="card">
          <h3>System Status</h3>
          <div className="status-item">
            <span className="status-label">Health:</span>
            <span className="status-value">{shopifyStatus}</span>
          </div>
        </div>

        <div className="card">
          <h3>Shopify Connection</h3>
          <p className="card-text">
            Test connection to Shopify Admin API using client credentials from Keychain.
          </p>
          <button 
            className="btn btn-primary" 
            onClick={fetchShopInfo}
            disabled={loading}
          >
            {loading ? "Loading..." : "Fetch Shop Info"}
          </button>
          
          {shopInfo && (
            <div className="result-box">
              <pre>{JSON.stringify(shopInfo, null, 2)}</pre>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Quick Stats</h3>
          <div className="stats-grid">
            <div className="stat">
              <div className="stat-value">—</div>
              <div className="stat-label">Orders (24h)</div>
            </div>
            <div className="stat">
              <div className="stat-value">—</div>
              <div className="stat-label">Products</div>
            </div>
            <div className="stat">
              <div className="stat-value">—</div>
              <div className="stat-label">Customers</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

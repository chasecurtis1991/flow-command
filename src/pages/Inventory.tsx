import { useState } from "react";

export function Inventory() {
  const [activeTab, setActiveTab] = useState<"shopify" | "fginv">("shopify");

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Inventory</h1>
        <p className="page-subtitle">Product and variant inventory across platforms</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <button
          className={`btn ${activeTab === "shopify" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("shopify")}
        >
          <span>🛍️</span>
          Shopify
        </button>
        <button
          className={`btn ${activeTab === "fginv" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("fginv")}
        >
          <span>📦</span>
          FGINV
        </button>
      </div>

      {activeTab === "shopify" && (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <div className="empty-state-icon">📊</div>
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
            Shopify Inventory Sync
          </h3>
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 20px' }}>
            Product and variant inventory levels from Shopify Admin API.
            Integration coming in Phase 2.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button className="btn btn-primary">Configure sync</button>
            <button className="btn btn-secondary">View documentation</button>
          </div>
        </div>
      )}

      {activeTab === "fginv" && (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <div className="empty-state-icon">🌿</div>
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
            FGINV System
          </h3>
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 20px' }}>
            Internal inventory management features will be built directly into Flow Command.
            Not an iframe to the hosted Next.js app.
          </p>
          <button className="btn btn-primary">Start planning</button>
        </div>
      )}
    </div>
  );
}

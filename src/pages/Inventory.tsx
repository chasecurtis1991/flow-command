import { useState } from "react";

export function Inventory() {
  const [activeTab, setActiveTab] = useState<"shopify" | "fginv">("shopify");

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Inventory</h2>
        <p className="page-subtitle">Product inventory management</p>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "shopify" ? "active" : ""}`}
          onClick={() => setActiveTab("shopify")}
        >
          Shopify
        </button>
        <button
          className={`tab ${activeTab === "fginv" ? "active" : ""}`}
          onClick={() => setActiveTab("fginv")}
        >
          FGINV
        </button>
      </div>

      <div className="page-content">
        {activeTab === "shopify" && (
          <div className="card">
            <h3>Shopify Inventory</h3>
            <p className="card-text">
              Shopify product and variant inventory levels. Integration coming in Phase 2.
            </p>
          </div>
        )}

        {activeTab === "fginv" && (
          <div className="card">
            <h3>FGINV System</h3>
            <p className="card-text">
              Internal inventory management features. Will be built in-app (not iframe to hosted FGINV).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

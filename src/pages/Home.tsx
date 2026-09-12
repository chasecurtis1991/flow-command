import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function Home() {
  const [shopInfo, setShopInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchShopInfo();
  }, []);

  async function fetchShopInfo() {
    setLoading(true);
    try {
      const info = await invoke<any>("fetch_shop_info");
      setShopInfo(info);
    } catch (error) {
      console.error("Failed to fetch shop info:", error);
    } finally {
      setLoading(false);
    }
  }

  function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  const kpis = [
    { label: "Orders (24h)", value: "47", change: "+32%", positive: true },
    { label: "Open fulfillments", value: "12", change: "+25%", positive: true },
    { label: "Low stock", value: "8", change: "1 new", positive: false },
    { label: "Alerts", value: "3", change: "3 unread", positive: false },
  ];

  const activities = [
    { time: "10:41", text: "Order #W-10443 paid · Warren Ortega", status: "paid", amount: "$108.00" },
    { time: "9:47", text: "Order #W-3591 fulfilled · Sarah Rose backordered", status: "fulfilled" },
    { time: "8:52", text: "Order #R-10441 fulfilled · tracking sent", status: "fulfilled" },
    { time: "8:12", text: "Draft returned FC-SPS-L56 · FGNV 131 on Shopify #02", status: "note" },
    { time: "7:45", text: "COA-02-56-0919 imported · needs review before posting", status: "note" },
    { time: "7:32", text: "Token rotated for my-craft-flower.myshopify.co", status: "note" },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">{getGreeting()}, Chase</h1>
        <p className="page-subtitle">
          Thursday, Sep 11, 2026 · Active store: <strong>Retail</strong> · Shopify
        </p>
      </div>

      {/* Primary Actions */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '28px' }}>
        <button className="btn btn-primary" onClick={fetchShopInfo}>
          {loading ? "Loading..." : "View orders"}
        </button>
        <button className="btn btn-secondary">Receive inventory</button>
      </div>

      {/* KPI Grid */}
      <div className="kpi-grid">
        {kpis.map((kpi, idx) => (
          <div key={idx} className="card kpi-card">
            <div className="kpi-label">{kpi.label}</div>
            <div className="kpi-value">{kpi.value}</div>
            <div className={`kpi-change ${kpi.positive ? 'positive' : 'negative'}`}>
              <span>{kpi.positive ? '↑' : '→'}</span>
              <span>{kpi.change}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
        {/* Recent Activity */}
        <div className="card">
          <div className="card-title">Recent Activity</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {activities.map((activity, idx) => (
              <div 
                key={idx}
                style={{ 
                  display: 'flex', 
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '10px 0',
                  borderBottom: idx < activities.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none'
                }}
              >
                <span style={{ 
                  fontSize: '11px', 
                  color: 'var(--text-tertiary)',
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: '36px'
                }}>
                  {activity.time}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '2px' }}>
                    {activity.text}
                  </div>
                  {activity.amount && (
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      {activity.amount}
                    </div>
                  )}
                </div>
                {activity.status === 'paid' && (
                  <span className="status-pill paid">
                    <span className="dot"></span>
                    Paid
                  </span>
                )}
                {activity.status === 'fulfilled' && (
                  <span className="status-pill fulfilled">
                    <span className="dot"></span>
                    Fulfilled
                  </span>
                )}
                {activity.status === 'note' && (
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Note</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar Cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Connection Health */}
          <div className="card">
            <div className="card-title">Connection Health</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Retail · Admin API</span>
                <span className="status-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <span className="dot" style={{ background: 'var(--success)' }}></span>
                  Healthy · 641 ms
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>B2B · Admin API</span>
                <span className="status-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <span className="dot" style={{ background: 'var(--success)' }}></span>
                  Healthy
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Bulk · Admin API</span>
                <span className="status-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <span className="dot" style={{ background: 'var(--success)' }}></span>
                  Healthy
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>FGINV · Database</span>
                <span className="status-pill" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-tertiary)' }}>
                  <span className="dot" style={{ background: 'var(--text-tertiary)' }}></span>
                  Offline
                </span>
              </div>
            </div>
          </div>

          {/* Shortcuts */}
          <div className="card">
            <div className="card-title">Shortcuts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', width: '100%' }}>
                <span>📊</span>
                <span>Live stock</span>
              </button>
              <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', width: '100%' }}>
                <span>✍️</span>
                <span>Draft products</span>
              </button>
              <button className="btn btn-secondary" style={{ justifyContent: 'flex-start', width: '100%' }}>
                <span>⚙️</span>
                <span>Store settings</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {shopInfo && (
        <div style={{ marginTop: '20px', padding: '12px', background: 'var(--accent-glow)', borderRadius: 'var(--radius-md)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          Connected to <strong>{shopInfo.shop_name || shopInfo.shop_domain}</strong> · {shopInfo.status}
        </div>
      )}
    </div>
  );
}

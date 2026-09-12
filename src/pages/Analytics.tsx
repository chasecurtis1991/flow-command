export function Analytics() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Analytics</h1>
        <p className="page-subtitle">Sales and operational metrics across all stores</p>
      </div>

      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <div className="empty-state-icon">📈</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          Performance Dashboard
        </h3>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '440px', margin: '0 auto 20px' }}>
          Sales analytics, inventory turns, and operational KPIs.
          Charts, graphs, and aggregated metrics coming soon.
        </p>
        <button className="btn btn-primary">Configure metrics</button>
      </div>

      {/* Metric Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginTop: '24px' }}>
        {[
          { label: "Revenue (30d)", value: "—", change: "vs. last period", icon: "💰" },
          { label: "Orders (30d)", value: "—", change: "vs. last period", icon: "📦" },
          { label: "Avg Order Value", value: "—", change: "vs. last period", icon: "🎯" },
          { label: "Conversion Rate", value: "—", change: "vs. last period", icon: "✓" },
        ].map((metric, idx) => (
          <div key={idx} className="card" style={{ padding: '20px' }}>
            <div style={{ fontSize: '24px', marginBottom: '12px' }}>{metric.icon}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {metric.label}
            </div>
            <div style={{ fontSize: '28px', fontWeight: 700, marginBottom: '4px' }}>{metric.value}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{metric.change}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

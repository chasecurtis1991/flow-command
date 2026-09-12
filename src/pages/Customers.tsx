export function Customers() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Customers</h1>
        <p className="page-subtitle">Customer relationship management across all stores</p>
      </div>

      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <div className="empty-state-icon">👥</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          Customer Directory
        </h3>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto 20px' }}>
          View and manage customer information from Shopify.
          Search, filter, and view order history, tags, and notes.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button className="btn btn-primary">Browse customers</button>
          <button className="btn btn-secondary">Export list</button>
        </div>
      </div>

      {/* Quick Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginTop: '24px' }}>
        <div className="card kpi-card">
          <div className="kpi-label">Total Customers</div>
          <div className="kpi-value">—</div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-label">Active (30d)</div>
          <div className="kpi-value">—</div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-label">Repeat Rate</div>
          <div className="kpi-value">—</div>
        </div>
      </div>
    </div>
  );
}

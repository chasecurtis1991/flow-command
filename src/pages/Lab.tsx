export function Lab() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Lab / COAs</h1>
        <p className="page-subtitle">Lab results and Certificates of Analysis management</p>
      </div>

      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <div className="empty-state-icon">🧪</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          Lab Testing & COAs
        </h3>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto 20px' }}>
          Certificate of Analysis management, lab result tracking, and compliance documentation.
          Import, review, and publish COAs for product batches.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button className="btn btn-primary">Import COA</button>
          <button className="btn btn-secondary">View pending</button>
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '24px' }}>
        <div className="card" style={{ padding: '18px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Needs Review
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--warning)' }}>—</div>
        </div>
        <div className="card" style={{ padding: '18px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Published
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--success)' }}>—</div>
        </div>
        <div className="card" style={{ padding: '18px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Expired
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--danger)' }}>—</div>
        </div>
      </div>
    </div>
  );
}

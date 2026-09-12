export function Catalog() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Catalog</h1>
        <p className="page-subtitle">Product catalog management across all stores</p>
      </div>

      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <div className="empty-state-icon">📚</div>
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          Product Catalog
        </h3>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 20px' }}>
          Browse and manage products across Retail, B2B, and Bulk stores.
          GraphQL queries, bulk editing, and cross-store synchronization coming soon.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button className="btn btn-primary">Browse products</button>
          <button className="btn btn-secondary">Import catalog</button>
        </div>
      </div>

      {/* Preview Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginTop: '24px' }}>
        {[
          { title: "Active Products", value: "—", icon: "✓" },
          { title: "Draft Products", value: "—", icon: "✍️" },
          { title: "Archived", value: "—", icon: "📦" },
        ].map((stat, idx) => (
          <div key={idx} className="card" style={{ padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>{stat.icon}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              {stat.title}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 700 }}>{stat.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

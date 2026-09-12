import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function Settings() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveCredentials() {
    setSaving(true);
    setSaveStatus("");
    try {
      await invoke("save_shopify_credentials", {
        clientId,
        clientSecret,
      });
      setSaveStatus("✅ Credentials saved to Keychain");
      setClientId("");
      setClientSecret("");
    } catch (error) {
      setSaveStatus(`❌ Error: ${error}`);
    } finally {
      setSaving(false);
    }
  }

  const stores = [
    { id: "retail", label: "Retail", domain: "3wvfyr-1i.myshopify.com", dot: "retail" },
    { id: "b2b", label: "B2B / Wholesale", domain: "b8h8vg-ij.myshopify.com", dot: "b2b" },
    { id: "bulk", label: "Bulk / Craft Flower", domain: "fg-craft-flower.myshopify.com", dot: "bulk" },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-greeting">Settings</h1>
        <p className="page-subtitle">Manage credentials, stores, and app configuration</p>
      </div>

      <div style={{ maxWidth: '680px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Shopify Credentials */}
        <div className="card" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            Shopify Credentials
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
            Client credentials are stored securely in macOS Keychain.
            These are shared across all three stores.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: 500, 
                color: 'var(--text-secondary)', 
                marginBottom: '6px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                Client ID
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Enter Shopify client ID"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '13px'
                }}
              />
            </div>

            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: 500, 
                color: 'var(--text-secondary)', 
                marginBottom: '6px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                Client Secret
              </label>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Enter Shopify client secret"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '13px'
                }}
              />
            </div>

            <button
              className="btn btn-primary"
              onClick={saveCredentials}
              disabled={!clientId || !clientSecret || saving}
              style={{ alignSelf: 'flex-start' }}
            >
              {saving ? "Saving..." : "Save to Keychain"}
            </button>

            {saveStatus && (
              <div style={{ 
                padding: '12px', 
                background: saveStatus.includes('✅') ? 'var(--success-soft)' : 'var(--danger-soft)', 
                border: `1px solid ${saveStatus.includes('✅') ? 'rgba(63,185,122,0.2)' : 'rgba(229,97,92,0.2)'}`,
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                color: saveStatus.includes('✅') ? 'var(--success)' : 'var(--danger)'
              }}>
                {saveStatus}
              </div>
            )}
          </div>
        </div>

        {/* Store Domains */}
        <div className="card" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            Store Domains
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
            Flow Command connects to these Shopify Plus stores using the admin API.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {stores.map((store) => (
              <div 
                key={store.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className={`store-dot ${store.dot}`} style={{ width: '8px', height: '8px', borderRadius: '50%' }}></span>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 500 }}>{store.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontFamily: 'Monaco, monospace' }}>
                      {store.domain}
                    </div>
                  </div>
                </div>
                <span className="status-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                  <span className="dot" style={{ background: 'var(--success)' }}></span>
                  Connected
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* App Info */}
        <div className="card" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            Application
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
            Flow Command v0.1.0 · Internal proprietary tool
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Platform</span>
              <span>macOS (Tauri 2)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>API Version</span>
              <span>2026-01</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Auth Method</span>
              <span>Client Credentials (OAuth)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

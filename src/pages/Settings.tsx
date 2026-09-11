import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type StoreInfo = {
  id: string;
  label: string;
  domain: string;
};

export function Settings() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [stores, setStores] = useState<StoreInfo[]>([]);

  useEffect(() => {
    invoke<StoreInfo[]>("list_stores")
      .then(setStores)
      .catch(console.error);
  }, []);

  async function saveCredentials() {
    setSaving(true);
    setSaveStatus("");
    try {
      const message = await invoke<string>("save_shopify_credentials", {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      await invoke("get_shopify_credentials");
      setSaveStatus(`✅ ${message}`);
      setClientId("");
      setClientSecret("");
    } catch (error) {
      setSaveStatus(`❌ ${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Settings</h2>
        <p className="page-subtitle">Application configuration</p>
      </div>

      <div className="page-content">
        <div className="card">
          <h3>Shopify Credentials</h3>
          <p className="card-text">
            Store the Hemp Dashboard / Shopify managed-app client ID and secret
            in macOS Keychain (service <code>com.flowgardens.command</code>).
          </p>

          <div className="form-group">
            <label>Client ID</label>
            <input
              type="text"
              className="form-input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Your Shopify client ID"
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label>Client Secret</label>
            <input
              type="password"
              className="form-input"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Your Shopify client secret"
              autoComplete="off"
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={saveCredentials}
            disabled={saving || !clientId.trim() || !clientSecret.trim()}
          >
            {saving ? "Saving…" : "Save to Keychain"}
          </button>

          {saveStatus && <div className="status-message">{saveStatus}</div>}
        </div>

        <div className="card">
          <h3>Store Domains</h3>
          <p className="card-text">
            Real <code>.myshopify.com</code> domains used for Admin API calls.
            Switch stores from the header dropdown.
          </p>
          <ul className="store-list">
            {stores.map((s) => (
              <li key={s.id}>
                <strong>{s.label}</strong>
                <code>{s.domain}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

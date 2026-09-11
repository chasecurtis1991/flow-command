import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function Settings() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  async function saveCredentials() {
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
            Store Shopify client ID and secret securely in macOS Keychain.
          </p>

          <div className="form-group">
            <label>Client ID</label>
            <input
              type="text"
              className="form-input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Your Shopify client ID"
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
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={saveCredentials}
            disabled={!clientId || !clientSecret}
          >
            Save to Keychain
          </button>

          {saveStatus && (
            <div className="status-message">{saveStatus}</div>
          )}
        </div>

        <div className="card">
          <h3>Store Configuration</h3>
          <p className="card-text">
            Configure store domains and other settings. Coming soon.
          </p>
        </div>
      </div>
    </div>
  );
}

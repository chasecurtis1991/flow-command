import { useState } from "react";
import "./App.css";

type NavItem = {
  id: string;
  label: string;
  icon: string;
};

const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "orders", label: "Orders", icon: "📦" },
  { id: "inventory", label: "Inventory", icon: "📊" },
  { id: "catalog", label: "Catalog", icon: "📚" },
  { id: "lab", label: "Lab / COAs", icon: "🧪" },
  { id: "customers", label: "Customers", icon: "👥" },
  { id: "analytics", label: "Analytics", icon: "📈" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

function App() {
  const [activeNav, setActiveNav] = useState("home");
  const [showInventoryTabs, setShowInventoryTabs] = useState(false);
  const [dashboardUrl] = useState("http://localhost:5173");

  return (
    <div className="app-shell">
      {/* Global Chrome */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Flow Command</h1>
          <select className="store-switcher" defaultValue="main">
            <option value="main">Main Store</option>
            <option value="wholesale">Wholesale</option>
          </select>
        </div>
        <div className="header-right">
          <button className="cmd-k-trigger" title="Search (⌘K)">
            <span>⌘K</span>
          </button>
          <button className="alerts-trigger" title="Alerts">
            <span>🔔</span>
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar Navigation */}
        <aside className="app-sidebar">
          <nav className="nav-menu">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activeNav === item.id ? "active" : ""}`}
                onClick={() => {
                  setActiveNav(item.id);
                  if (item.id === "inventory") {
                    setShowInventoryTabs(true);
                  } else {
                    setShowInventoryTabs(false);
                  }
                }}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="app-content">
          {showInventoryTabs && (
            <div className="content-tabs">
              <button className="tab active">Shopify</button>
              <button className="tab">FGINV</button>
            </div>
          )}

          {/* Dashboard Embed Area */}
          <div className="dashboard-container">
            <div className="dashboard-embed-notice">
              <h2>Flow Gardens Dashboard</h2>
              <p className="dashboard-url">
                Loading from: <code>{dashboardUrl}</code>
              </p>
              <p className="dashboard-instructions">
                In dev mode, run the dashboard separately:
                <br />
                <code>cd ../flow-gardens-dashboard && npm run dev</code>
              </p>
              <div className="iframe-wrapper">
                <iframe
                  src={dashboardUrl}
                  title="Flow Gardens Dashboard"
                  className="dashboard-iframe"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;

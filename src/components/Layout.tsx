import { Outlet, NavLink } from "react-router-dom";
import { useState } from "react";

type NavItem = {
  id: string;
  path: string;
  label: string;
  icon: string;
};

const navItems: NavItem[] = [
  { id: "home", path: "/home", label: "Home", icon: "🏠" },
  { id: "orders", path: "/orders", label: "Orders", icon: "📦" },
  { id: "inventory", path: "/inventory", label: "Inventory", icon: "📊" },
  { id: "catalog", path: "/catalog", label: "Catalog", icon: "📚" },
  { id: "lab", path: "/lab", label: "Lab / COAs", icon: "🧪" },
  { id: "customers", path: "/customers", label: "Customers", icon: "👥" },
  { id: "analytics", path: "/analytics", label: "Analytics", icon: "📈" },
  { id: "settings", path: "/settings", label: "Settings", icon: "⚙️" },
];

export function Layout() {
  const [currentStore, setCurrentStore] = useState("retail");

  return (
    <div className="app-shell">
      {/* Global Chrome */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Flow Command</h1>
          <select 
            className="store-switcher" 
            value={currentStore}
            onChange={(e) => setCurrentStore(e.target.value)}
          >
            <option value="retail">Flow Gardens (Retail)</option>
            <option value="b2b">Flow Gardens B2B</option>
            <option value="bulk">Flow Gardens Bulk</option>
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
              <NavLink
                key={item.id}
                to={item.path}
                className={({ isActive }) => 
                  `nav-item ${isActive ? "active" : ""}`
                }
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

import { Outlet, NavLink } from "react-router-dom";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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

const storeOptions = [
  { id: "retail", label: "Retail", dot: "retail" },
  { id: "b2b", label: "B2B · Wholesale", dot: "b2b" },
  { id: "bulk", label: "Bulk · Craft", dot: "bulk" },
];

export function Layout() {
  const [currentStore, setCurrentStore] = useState("retail");
  const [currentPage, setCurrentPage] = useState("Home");

  useEffect(() => {
    // Load active store on mount
    invoke<any>("get_active_store")
      .then((store) => setCurrentStore(store.id))
      .catch(console.error);
  }, []);

  const handleStoreChange = async (newStore: string) => {
    try {
      await invoke("set_active_store", { storeId: newStore });
      setCurrentStore(newStore);
      // Trigger event for pages to react
      window.dispatchEvent(new CustomEvent("storeChanged", { detail: newStore }));
    } catch (error) {
      console.error("Failed to set active store:", error);
    }
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">FC</div>
          <div className="brand-text">
            <div className="brand-title">Flow Command</div>
            <div className="brand-subtitle">Flow Gardens</div>
          </div>
        </div>

        <nav className="nav-menu">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              className={({ isActive }) => 
                `nav-item ${isActive ? "active" : ""}`
              }
              onClick={() => setCurrentPage(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-status">
            <span className="status-dot"></span>
            <span>Connected · 3 stores</span>
          </div>
        </div>
      </aside>

      {/* Topbar */}
      <header className="app-topbar">
        <div className="topbar-title">
          <div className="title-accent"></div>
          {currentPage}
        </div>

        <div className="topbar-spacer"></div>

        <div className="store-switcher">
          {storeOptions.map((store) => (
            <button
              key={store.id}
              className={`store-option ${currentStore === store.id ? "active" : ""}`}
              onClick={() => handleStoreChange(store.id)}
            >
              <span className={`store-dot ${store.dot}`}></span>
              {store.label}
            </button>
          ))}
        </div>

        <button className="search-trigger">
          <span className="icon">🔍</span>
          <span>Search...</span>
          <span className="shortcut">⌘K</span>
        </button>

        <button className="alerts-button">
          <span>🔔</span>
          <span className="alerts-badge">3</span>
        </button>
      </header>

      {/* Content */}
      <main className="app-content">
        <Outlet context={{ currentPage, setCurrentPage }} />
      </main>
    </div>
  );
}

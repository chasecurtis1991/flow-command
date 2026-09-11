import { Outlet, NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type NavItem = {
  id: string;
  path: string;
  label: string;
  icon: string;
};

type StoreInfo = {
  id: string;
  label: string;
  domain: string;
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
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [activeId, setActiveId] = useState("retail");

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<StoreInfo[]>("list_stores");
        setStores(list);
        const active = await invoke<StoreInfo>("get_active_store");
        setActiveId(active.id);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  async function onStoreChange(id: string) {
    setActiveId(id);
    try {
      await invoke("set_active_store", { storeId: id });
    } catch (e) {
      console.error(e);
    }
  }

  const activeDomain = stores.find((s) => s.id === activeId)?.domain;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Flow Command</h1>
          <select
            className="store-switcher"
            value={activeId}
            onChange={(e) => onStoreChange(e.target.value)}
            title={activeDomain}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="header-right">
          <button className="cmd-k-trigger" title="Search (⌘K)" type="button">
            <span>⌘K</span>
          </button>
          <button className="alerts-trigger" title="Alerts" type="button">
            <span>🔔</span>
          </button>
        </div>
      </header>

      <div className="app-body">
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

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

type StoreInfo = {
  id: string;
  label: string;
  domain: string;
};

const navItems = [
  { to: "/", label: "Home", end: true },
  { to: "/orders", label: "Orders" },
  { to: "/inventory", label: "Inventory" },
  { to: "/catalog", label: "Catalog" },
  { to: "/lab", label: "Lab / COAs" },
  { to: "/customers", label: "Customers" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "Settings" },
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FC</div>
          <div>
            <div className="brand-title">Flow Command</div>
            <div className="brand-sub">Flow Gardens</div>
          </div>
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "nav-item active" : "nav-item"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <select
            className="store-switcher"
            value={activeId}
            onChange={(e) => onStoreChange(e.target.value)}
            title={stores.find((s) => s.id === activeId)?.domain}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="chrome-btn" type="button" title="Command palette">
            ⌘K
          </button>
          <button className="chrome-btn" type="button" title="Alerts">
            🔔
          </button>
        </header>
        <Outlet />
      </div>
    </div>
  );
}

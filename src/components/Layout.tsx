import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppContext, prefs, type Accent, type AppCtx, type Density } from "../lib/app";
import {
  STORES, type StoreId, type OrdersState, getActiveStore, setActiveStore, loadOrders, useOrders, isOpenFulfillment, money, storeById, invalidateInventory,
  invalidateCatalog, invalidateOrdersTable, invalidateCustomers, invalidatePresence, invalidateAnalytics, invalidateCoas, loadCatalog, useCatalog, useCoas,
} from "../lib/shopify";
import { customers, addLot } from "../lib/mock";
import { Icon, type IconName } from "./icons";

const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: "/home", label: "Home", icon: "home" },
  { path: "/orders", label: "Orders", icon: "orders" },
  { path: "/inventory", label: "Inventory", icon: "inventory" },
  { path: "/catalog", label: "Catalog", icon: "catalog" },
  { path: "/lab", label: "Lab / COAs", icon: "lab" },
  { path: "/customers", label: "Customers", icon: "customers" },
  { path: "/analytics", label: "Analytics", icon: "analytics" },
  { path: "/settings", label: "Settings", icon: "settings" },
];
const TITLES: Record<string, string> = { ...Object.fromEntries(NAV.map((n) => [n.path, n.label])), "/system": "Design system" };

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const orders = useOrders();
  const coas = useCoas(); // badge only; the Lab page loads it

  const [store, setStoreState] = useState<StoreId>("retail");
  const [storeReady, setStoreReady] = useState(false);
  const [collapsed, setCollapsed] = useState(() => prefs.get("sidebar", "open", ["open", "collapsed"] as const) === "collapsed");
  useEffect(() => { prefs.set("sidebar", collapsed ? "collapsed" : "open"); }, [collapsed]);
  const [accent, setAccent] = useState<Accent>(() => prefs.get("accent", "blue", ["blue", "green"] as const));
  const [density, setDensity] = useState<Density>(() => prefs.get("density", "comfortable", ["compact", "comfortable"] as const));
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef(0);

  const toast = useCallback((msg: string) => {
    window.clearTimeout(toastTimer.current);
    setToastMsg(msg);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3200);
  }, []);

  useEffect(() => { document.documentElement.dataset.accent = accent; prefs.set("accent", accent); }, [accent]);
  useEffect(() => { document.documentElement.dataset.density = density; prefs.set("density", density); }, [density]);

  // Launch: read the Keychain-persisted active store, then warm the orders cache (badge, Home KPIs, palette search).
  useEffect(() => {
    getActiveStore()
      .then((s) => { setStoreState(s.id); void loadOrders(s.id); })
      .catch(() => { void loadOrders("retail"); })
      .finally(() => setStoreReady(true));
  }, []);

  const setStore = useCallback(async (id: StoreId) => {
    try {
      await setActiveStore(id);
      setStoreState(id);
      void loadOrders(id, true);
    } catch (e) {
      toast(`Couldn't switch store · ${e}`);
    }
  }, [toast]);

  const refresh = useCallback(() => {
    const t0 = performance.now();
    const label = storeById(store).label;
    invalidateInventory();
    invalidateCatalog();
    invalidateOrdersTable(); // a mounted Orders page refetches its current page
    invalidateCustomers();
    invalidatePresence();
    invalidateAnalytics();
    invalidateCoas();
    void loadOrders(store, true).then((s) => {
      const ms = Math.round(performance.now() - t0);
      toast(s.status === "data" ? `Synced ${label} · ${s.orders.length} orders · ${ms} ms` : `Refresh failed · ${s.error ?? "unknown error"}`);
    });
  }, [store, toast]);

  // Global shortcuts (see design handoff · Keyboard).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.key === "Escape") { setPalette(false); setSheet(false); return; }
      if (!mod) return;
      if (e.key === "\\") { e.preventDefault(); setCollapsed((c) => !c); return; }
      if (e.key === "1" || e.key === "2" || e.key === "3") { e.preventDefault(); void setStore(STORES[Number(e.key) - 1].id); }
      else if (k === "r" && e.shiftKey) { e.preventDefault(); setSheet(true); }
      else if (k === "r") { e.preventDefault(); refresh(); }
      else if (k === "f") { e.preventDefault(); document.querySelector<HTMLInputElement>(".content input.input")?.focus(); }
      else if (e.key === ",") { e.preventDefault(); navigate("/settings"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setStore, refresh, navigate]);

  const ctx = useMemo<AppCtx>(() => ({
    store, setStore, storeReady, accent, setAccent, density, setDensity, toast,
    openPalette: () => setPalette(true), openSheet: () => setSheet(true), refresh,
  }), [store, setStore, storeReady, accent, density, toast, refresh]);

  const title = TITLES[pathname] ?? "Flow Command";
  const openCount = orders.status === "data" ? orders.orders.filter(isOpenFulfillment).length : 0;
  const unposted = coas.status === "data" ? coas.data!.coas.filter((c) => c.postedStatus === "unposted").length : 0; // no badge until loaded
  const badges: Record<string, number> = { "/orders": openCount, "/lab": unposted };

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app${collapsed ? " collapsed" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-drag" data-tauri-drag-region="" />
          <div className="brand">
            <div className="brand-mark">FC</div>
            <div>
              <div className="brand-title">Flow Command</div>
              <div className="brand-sub">Flow Gardens</div>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink key={n.path} to={n.path} title={collapsed ? (badges[n.path] > 0 ? `${n.label} · ${badges[n.path]}` : n.label) : undefined}
                aria-label={collapsed ? n.label : undefined} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
                <Icon name={n.icon} />
                <span className="nav-label">{n.label}</span>
                {badges[n.path] > 0 && <span className="nav-badge">{badges[n.path]}</span>}
              </NavLink>
            ))}
          </nav>
          <div className="spacer" />
          <div className="sidebar-section">Design</div>
          <NavLink to="/system" title={collapsed ? "Design system & handoff" : undefined} aria-label={collapsed ? "Design system & handoff" : undefined}
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
            <Icon name="design" />
            <span className="nav-label">Design system &amp; handoff</span>
          </NavLink>
          <ConnectionCard orders={orders} store={store} />
        </aside>

        <div className="main">
          <header className="topbar" data-tauri-drag-region="">
            <button className="icon-btn sidebar-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}
              title={`${collapsed ? "Expand" : "Collapse"} sidebar (⌘\\)`} onClick={() => setCollapsed((c) => !c)}>
              <Icon name="sidebar" />
            </button>
            <div className="topbar-title">
              <span className="title-bar" />
              <span key={title} className="title-text">{title}</span>
            </div>
            <div className="spacer" data-tauri-drag-region="" />
            <div className="seg" role="tablist" aria-label="Store">
              {STORES.map((s) => (
                <button key={s.id} role="tab" aria-selected={store === s.id} className={`seg-item${store === s.id ? " active" : ""}`} onClick={() => void setStore(s.id)}>
                  <span className={`dot ${s.id}`} />
                  {s.label}
                </button>
              ))}
            </div>
            <button className="search-btn" onClick={() => setPalette(true)}>
              <span>Search or run a command…</span>
              <span className="kbd">⌘K</span>
            </button>
            <button className="alerts-btn" title="Alerts" onClick={() => toast("3 alerts · COA unposted · drift · wire pending")}>
              !<span className="alerts-badge">3</span>
            </button>
          </header>

          <main className="content">
            <Outlet />
            {toastMsg && (
              <div className="toast" role="status">
                <span className="dot d7 green" />
                <span>{toastMsg}</span>
                <button className="close" aria-label="Dismiss" onClick={() => setToastMsg(null)}>×</button>
              </div>
            )}
          </main>
        </div>

        {palette && (
          <Palette
            store={store}
            orders={orders}
            onClose={() => setPalette(false)}
            actions={{
              refresh,
              openSheet: () => setSheet(true),
              switchB2B: () => void setStore("b2b"),
              go: (path: string) => navigate(path),
            }}
          />
        )}
        {sheet && (
          <ReceiveSheet
            onClose={() => setSheet(false)}
            onDone={(msg) => { setSheet(false); navigate("/inventory?tab=fginv"); toast(msg); }}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}

// ---------- Sidebar connection footer ----------
function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
function ConnectionCard({ orders, store }: { orders: OrdersState; store: StoreId }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = window.setInterval(() => tick((t) => t + 1), 30_000); return () => window.clearInterval(i); }, []);
  const label = storeById(store).short;
  if (orders.status === "error") {
    return (
      <div className="conn" title="Shopify unreachable"><span className="conn-dot warn" /><div><div>Shopify unreachable</div><div className="mute">Check credentials in Settings</div></div></div>
    );
  }
  if (orders.status === "data") {
    return (
      <div className="conn" title={`Connected · ${label}`}><span className="conn-dot" /><div><div>Connected · {label}</div><div className="mute">Synced {ago(orders.loadedAt)}</div></div></div>
    );
  }
  return (
    <div className="conn" title="Connecting…"><span className="conn-dot off" /><div><div>Connecting…</div><div className="mute">{STORES.length} stores</div></div></div>
  );
}

// ---------- ⌘K palette ----------
interface Item { kind: string; label: string; meta: string; key: string; run: () => void }
interface PaletteActions { refresh: () => void; openSheet: () => void; switchB2B: () => void; go: (path: string) => void }

function Palette({ store, orders, onClose, actions }: { store: StoreId; orders: OrdersState; onClose: () => void; actions: PaletteActions }) {
  const catalog = useCatalog();
  const coas = useCoas(); // whatever the Lab page has loaded; not fetched from here
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const s = q.trim().toLowerCase();
  const match = (str: string) => !s || str.toLowerCase().includes(s);
  const mk = (kind: string, label: string, meta: string, key: string, fn: () => void): Item => ({ kind, label, meta, key, run: () => { onClose(); fn(); } });

  // Products are loaded lazily on first palette open (no-op once the Catalog page has warmed the cache).
  useEffect(() => { void loadCatalog(store); }, [store]);

  const groups = useMemo(() => [
    { label: "Pages", items: NAV.filter((n) => match(n.label)).map((n) => mk("Page", n.label, "", "", () => actions.go(n.path))) },
    {
      label: "Orders",
      items: orders.orders
        .filter((o) => match(`${o.name} ${o.customerName ?? ""} ${o.customerEmail ?? ""}`))
        .slice(0, 4)
        .map((o) => mk("Order", o.name, `${o.customerName ?? o.customerEmail ?? "—"} · ${money(o.totalPrice)}`, "", () => actions.go(`/orders?sel=${encodeURIComponent(o.id)}`))),
    },
    {
      label: "Products",
      items: (catalog.data?.products ?? [])
        .filter((p) => match(`${p.title} ${p.productType ?? ""} ${p.tags.join(" ")}`))
        .slice(0, 3)
        .map((p) => mk("Product", p.title, [p.productType, money(p.minPrice)].filter(Boolean).join(" · "), "", () => actions.go(`/catalog?q=${encodeURIComponent(p.title)}`))),
    },
    {
      label: "COAs",
      items: (coas.data?.coas ?? [])
        .filter((c) => match(`${c.batch ?? ""} ${c.productName} ${c.lab ?? ""} ${c.fileName}`))
        .slice(0, 3)
        .map((c) => mk("COA", c.batch ?? c.productName, [c.productName, c.lab].filter(Boolean).join(" · "), "", () => actions.go(`/lab?q=${encodeURIComponent(c.batch ?? c.productName)}`))),
    },
    { label: "Customers", items: customers.filter((c) => match(c.name)).slice(0, 2).map((c) => mk("Customer", c.name, c.store, "", () => actions.go("/customers"))) },
    {
      label: "Actions",
      items: ([
        ["Refresh all stores", "Sync orders + inventory", "⌘R", actions.refresh],
        ["Receive inventory", "New FGINV lot", "⌘⇧R", actions.openSheet],
        ["Switch store → B2B / Wholesale", "", "⌘2", actions.switchB2B],
        ["Import COA", "Parse a lab PDF", "", () => actions.go("/lab")],
      ] as [string, string, string, () => void][]).filter((a) => match(a[0])).map((a) => mk("Action", a[0], a[1], a[2], a[3])),
    },
  ].filter((g) => g.items.length), [s, orders.orders, catalog.data, coas.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = groups.flatMap((g) => g.items);
  const active = Math.min(idx, Math.max(0, flat.length - 1));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % Math.max(1, flat.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (e.key === "Enter") { e.preventDefault(); flat[active]?.run(); }
  };

  let n = -1;
  return (
    <div className="overlay top" onClick={onClose}>
      <div className="dialog palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={onKey}
            placeholder="Search orders, products, customers — or type a command"
          />
          <span className="esc">esc</span>
        </div>
        <div className="palette-body">
          {flat.length === 0 && <div className="palette-empty">No matches for “{q}”</div>}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="palette-group">{g.label}</div>
              {g.items.map((it) => {
                n += 1;
                const i = n;
                return (
                  <button key={`${g.label}-${it.label}-${i}`} className={`palette-item${i === active ? " active" : ""}`} onMouseEnter={() => setIdx(i)} onClick={it.run}>
                    <span className="palette-kind">{it.kind}</span>
                    <span className="ellip">{it.label} <span className="mute">{it.meta}</span></span>
                    <span className="palette-key">{it.key}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><span className="sub">↑↓</span> navigate</span>
          <span><span className="sub">↵</span> open</span>
          <span className="spacer" />
          <span>Searching {storeById(store).label}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Receive inventory sheet ----------
function ReceiveSheet({ onClose, onDone }: { onClose: () => void; onDone: (toast: string) => void }) {
  const today = new Date();
  const lotId = `FG-${String(today.getFullYear()).slice(-2)}-${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const [strain, setStrain] = useState("Suver Haze");
  const [lot, setLot] = useState(lotId);
  const [weight, setWeight] = useState("");
  const [loc, setLoc] = useState("Warehouse");
  const [coa, setCoa] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const w = parseFloat(weight);
    if (!strain.trim()) return setErr("Strain is required");
    if (!lot.trim()) return setErr("Lot ID is required");
    if (!(w > 0)) return setErr("Weight must be greater than 0");
    addLot({
      lot: lot.trim(), strain: strain.trim(),
      received: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(today),
      onhand: `${w.toFixed(1)} lb`, drift: "0", coa: coa.trim() ? "Pending" : "Pending",
    });
    onDone(`Lot ${lot.trim()} received · ${w.toFixed(1)} lb ${strain.trim()}`);
  };

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="dialog sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Receive lot">
        <div className="sheet-head">
          <div className="title">Receive lot</div>
          <div className="why">Creates an FGINV lot. Shopify is updated on the next push.</div>
        </div>
        <div className="sheet-body">
          <label className="field full">Strain / product<input className="input input-dark" value={strain} onChange={(e) => setStrain(e.target.value)} /></label>
          <label className="field">Lot ID<input className="input input-dark mono" value={lot} onChange={(e) => setLot(e.target.value)} /></label>
          <label className="field">Weight (lb)<input className={`input input-dark num${err && !(parseFloat(weight) > 0) ? " error" : ""}`} placeholder="0.0" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></label>
          <label className="field">Location<input className="input input-dark" value={loc} onChange={(e) => setLoc(e.target.value)} /></label>
          <label className="field">COA<input className="input input-dark dashed" placeholder="Link or drop PDF" value={coa} onChange={(e) => setCoa(e.target.value)} /></label>
          {err && <div className="full" style={{ fontSize: 11.5, color: "var(--red)", marginTop: -4 }}>{err}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>Receive lot</button>
        </div>
      </div>
    </div>
  );
}

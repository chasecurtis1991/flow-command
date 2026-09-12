// App-wide context provided by Layout: active store, appearance prefs, toast, palette, sheet.
import { createContext, useContext } from "react";
import type { StoreId } from "./shopify";

export type Accent = "blue" | "green";
export type Density = "compact" | "comfortable";

export interface AppCtx {
  store: StoreId;
  /** Persists via set_active_store (Keychain) then reloads the orders cache. */
  setStore: (id: StoreId) => Promise<void>;
  /** True once get_active_store has resolved (or failed) on launch. */
  storeReady: boolean;
  accent: Accent;
  setAccent: (a: Accent) => void;
  density: Density;
  setDensity: (d: Density) => void;
  toast: (msg: string) => void;
  openPalette: () => void;
  openSheet: () => void;
  /** Reload orders for the active store and toast the result. */
  refresh: () => void;
}

export const AppContext = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp must be used inside <Layout>");
  return c;
}

// UI prefs live in localStorage (not Keychain — nothing sensitive).
const PREFIX = "fc.";
export const prefs = {
  get<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
    try {
      const v = localStorage.getItem(PREFIX + key) as T | null;
      if (v == null) return fallback;
      return allowed && !allowed.includes(v) ? fallback : v;
    } catch { return fallback; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(PREFIX + key, value); } catch { /* private mode etc. */ }
  },
};

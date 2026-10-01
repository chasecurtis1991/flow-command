import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import {
  type Customer, type StoreId, adminUrl, buildCustomersQuery, fmtCreated, isScopeError, loadCustomers, money, moneyNum, storeById, useCustomers,
} from "../lib/shopify";
import { type ColumnDef, useDebounced, useTable } from "../lib/table";
import { EmptyState, ErrorState, LoadingState, Pill } from "../components/ui";
import { ColumnsMenu, FilterChips, TableHead, TableRow } from "../components/DataTable";

const nf = new Intl.NumberFormat("en-US");
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();

function customerColumns(store: StoreId): ColumnDef<Customer>[] {
  return [
    {
      id: "customer", label: "Customer", width: "minmax(0, 1.4fr)", cellClass: "cell-2", sortValue: (c) => c.displayName,
      filter: { kind: "text", value: (c) => `${c.displayName} ${c.email ?? ""} ${c.phone ?? ""}`, placeholder: "Name, email or phone" },
      cell: (c) => <>
        <span className="avatar">{initials(c.displayName)}</span>
        <span className="two-line"><span className="ellip" style={{ fontWeight: 500 }}>{c.displayName}</span><span className="second ellip">{c.email ?? "—"}</span></span>
      </>,
    },
    { id: "company", label: "Company", width: "minmax(0, 1fr)", cellClass: "soft ellip", sortValue: (c) => c.company, filter: { kind: "text", value: (c) => c.company ?? "" }, cell: (c) => c.company ?? "—" },
    { id: "location", label: "Location", width: "130px", cellClass: "sub ellip", sortValue: (c) => c.location, cell: (c) => c.location ?? "—" },
    { id: "orders", label: "Orders", width: "80px", align: "right", sortValue: (c) => c.ordersCount, sortDir: "desc", cell: (c) => c.ordersCount },
    { id: "lifetime", label: "Lifetime", width: "110px", align: "right", sortValue: (c) => moneyNum(c.amountSpent), sortDir: "desc", cell: (c) => money(c.amountSpent) },
    {
      id: "last", label: "Last order", width: "130px", cellClass: "sub", sortValue: (c) => c.lastOrderAt, sortDir: "desc",
      cell: (c) => <span title={c.lastOrderName ?? undefined}>{c.lastOrderAt ? fmtCreated(c.lastOrderAt) : "—"}</span>,
    },
    {
      id: "open", label: "", title: "Open in Shopify", width: "32px", hideable: false,
      cell: (c) => <button className="icon-btn" title="Open in Shopify" aria-label="Open in Shopify" onClick={(e) => { e.stopPropagation(); void openUrl(adminUrl(store, c.id)); }}>{"↗"}</button>,
    },
  ];
}

export function Customers() {
  const navigate = useNavigate();
  const { store, storeReady, toast } = useApp();
  const cust = useCustomers();
  const [q, setQ] = useState("");
  // Search runs in Shopify (the list is the top 100 of possibly thousands); column filters and sort then apply on top.
  const query = buildCustomersQuery(useDebounced(q, 300));

  useEffect(() => {
    if (storeReady && (cust.status === "idle" || ((cust.store !== store || cust.query !== query) && cust.status !== "loading"))) void loadCustomers(store, query);
  }, [storeReady, store, query, cust.status, cust.store, cust.query]);

  const customers = cust.data?.customers ?? [];
  const columns = useMemo(() => customerColumns(store), [store]);
  const table = useTable<Customer>({ id: "customers", columns, rows: customers });
  const rows = table.rowsOut;

  const sync = () => {
    const t0 = performance.now();
    const label = storeById(store).label;
    void loadCustomers(store, query, true).then((st) => {
      const ms = Math.round(performance.now() - t0);
      toast(st.status === "data" ? `Synced ${label} · ${st.data?.customers.length ?? 0} customers · ${ms} ms` : `Sync failed · ${st.error ?? "unknown error"}`);
    });
  };
  const clearAll = () => { setQ(""); table.clearFilters(); };

  // customersCount ignores the search on the live store (verified 2026-09-12), so it is only ever the store total: show it
  // for the unfiltered list; a search shows its own row count and hasNextPage says whether 100 was the cap.
  const total = cust.data?.totalCount ?? null;
  const countLabel = !cust.data ? "" : !query && total != null && total > customers.length
    ? `Showing ${customers.length} of ${cust.data.totalPrecision === "AT_LEAST" ? "10,000+" : nf.format(total)} · search to narrow`
    : `${nf.format(rows.length)} customers${cust.data.hasNextPage ? " · first 100, narrow the search" : ""}`;

  const loading = cust.status === "loading";
  let body;
  if (cust.status === "idle" || (loading && (customers.length === 0 || cust.store !== store))) body = <LoadingState label="Loading customers from Shopify…" />;
  else if (cust.status === "error") {
    const scope = isScopeError(cust.error, "read_customers");
    body = (
      <ErrorState
        title={scope ? "Missing customer access" : "Couldn’t reach Shopify"}
        why={scope ? `Grant the read_customers scope to the Flow Command app on ${storeById(store).label} (${storeById(store).domain}), then retry.` : (cust.error ?? "Unknown error").slice(0, 160)}
        actions={<>
          <button className="btn btn-primary" onClick={() => void loadCustomers(store, query, true)}>Retry</button>
          <button className="btn btn-secondary" onClick={() => navigate("/settings")}>Open settings</button>
        </>}
      />
    );
  } else if (rows.length === 0) body = (
    <EmptyState
      title={customers.length === 0 && !query ? "No customers yet" : "No customers match"}
      why={customers.length === 0 && !query ? `${storeById(store).label} has no customers yet.` : "Try another name, email or company, or clear the filters."}
      action={(query || table.activeFilters.length > 0) && <button className="btn btn-secondary" onClick={clearAll}>Clear filters</button>}
    />
  );
  else body = (
    <div className={`scroll${loading ? " rows-dim" : ""}`} aria-busy={loading}>
      {rows.map((c) => <TableRow key={c.id} table={table} row={c} className="tall" />)}
    </div>
  );

  return (
    <section className="screen screen-full">
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ width: 300 }} placeholder="Search by name, email, company or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <FilterChips table={table} />
        {cust.status === "data" && <Pill kind="green" sm>Live</Pill>}
        <div className="spacer" />
        <span className="mute num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{countLabel}</span>
        <button className="btn btn-control" onClick={sync}>Sync now</button>
        <ColumnsMenu table={table} />
      </div>
      <TableHead table={table} />
      {body}
    </section>
  );
}

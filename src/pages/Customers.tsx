import { useState } from "react";
import { customers } from "../lib/mock";
import { money } from "../lib/shopify";
import { EmptyState, SampleData } from "../components/ui";

export function Customers() {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const rows = customers.filter((c) => !s || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(s));

  return (
    <section className="screen screen-full">
      <div className="toolbar">
        <input className="input" style={{ width: 360 }} placeholder="Look up by name, email, company or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-control">Segment <span className="muted">All</span></button>
        <SampleData />
      </div>
      <div className="thead cols-cust">
        <span>Customer</span><span>Company</span><span>Store</span><span className="r">Orders</span><span className="r">Lifetime</span><span>Last order</span>
      </div>
      {rows.length === 0 ? <EmptyState title="No customers match" why="Try a name, email or company." /> : (
        <div className="scroll">
          {rows.map((c) => (
            <div key={c.email} className="row tall cols-cust">
              <span className="cell-2">
                <span className="avatar">{c.initials}</span>
                <span className="two-line"><span style={{ fontWeight: 500 }}>{c.name}</span><span className="second">{c.email}</span></span>
              </span>
              <span className="soft">{c.company}</span>
              <span className="sub">{c.store}</span>
              <span className="r">{c.orders}</span>
              <span className="r">{money(`${c.ltv} USD`)}</span>
              <span className="sub">{c.last}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

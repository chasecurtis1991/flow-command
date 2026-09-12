import { useState } from "react";
import { useApp } from "../lib/app";
import { coas } from "../lib/mock";
import { EmptyState, Pill, SampleData, Status } from "../components/ui";

export function Lab() {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [notPosted, setNotPosted] = useState(false);
  const s = q.trim().toLowerCase();
  const rows = coas.filter((c) => (!notPosted || !c.isPosted) && (!s || `${c.file} ${c.strain} ${c.batch} ${c.lab}`.toLowerCase().includes(s)));

  return (
    <section className="screen screen-full">
      <div className="toolbar">
        <input className="input" style={{ width: 260 }} placeholder="Search by batch, strain or lab" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-control">Parse status <span className="muted">All</span></button>
        <button className={`btn btn-control${notPosted ? " on" : ""}`} onClick={() => setNotPosted((v) => !v)}>Not posted</button>
        <SampleData />
        <div className="spacer" />
        <span className="mute" style={{ fontSize: 12 }}>Drop PDFs here or</span>
        <button className="btn btn-primary" onClick={() => toast("COA import ships in a later release")}>Import COA</button>
      </div>
      <div className="thead cols-coa">
        <span>Document</span><span>Lab</span><span>Batch</span><span className="r">Total cann.</span><span className="r">Δ9 THC</span><span>Parse</span><span>Linked product</span><span>Storefront</span>
      </div>
      {rows.length === 0 ? <EmptyState title="No COAs match" why="Try another batch, strain or lab." /> : (
        <div className="scroll">
          {rows.map((c) => (
            <div key={c.file} className="row taller cols-coa">
              <span className="cell-2">
                <span className="pdf-icon">PDF</span>
                <span className="two-line"><span className="ellip" style={{ fontWeight: 500 }}>{c.file}</span><span className="second">{c.strain} · {c.date}</span></span>
              </span>
              <span className="sub">{c.lab}</span>
              <span className="mono soft" style={{ fontSize: 12 }}>{c.batch}</span>
              <span className="r">{c.total}</span>
              <span className="r" style={{ color: c.thcHot ? "var(--amber)" : "var(--text)" }}>{c.thc}</span>
              <span><Pill kind={c.parseKind}>{c.parse}</Pill></span>
              <span className="ellip" style={{ color: c.unlinked ? "var(--mute)" : "var(--text)" }}>{c.product}</span>
              <Status kind={c.isPosted ? "green" : "mute"}>{c.posted}</Status>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

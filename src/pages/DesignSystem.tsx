import type { CSSProperties, ReactNode } from "react";
import { handoff, spacing, tokens, typeScale } from "../lib/mock";
import { Pill } from "../components/ui";

const item: CSSProperties = { height: 32, padding: "0 10px", borderRadius: 6, display: "flex", alignItems: "center" };
const segItem: CSSProperties = { height: 24, padding: "0 10px", fontSize: 12 };

function Card({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="label">{label}</div>
      {children}
      {note && <div className="mute" style={{ fontSize: 11.5 }}>{note}</div>}
    </div>
  );
}

export function DesignSystem() {
  return (
    <section className="screen screen-pad" style={{ padding: "24px 28px 48px", gap: 28, maxWidth: 1040 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>Design system &amp; engineering handoff</div>
        <p className="sub" style={{ margin: "8px 0 0", maxWidth: 720, textWrap: "pretty" }}>
          Flow Command borrows iOS Settings’ grouping discipline and the quiet chrome of modern desktop AI tools: one near-black gradient ground, elevation expressed as translucent glass layers with a 1px top highlight instead of drop shadow, a faint accent bloom behind the content, a single restrained accent reserved for the primary action and the active state, and tabular numerals everywhere money or quantity appears. Density is a feature — 32px rows, 13px body — because Chase scans hundreds of rows a day. The multi-store switcher lives in the title bar so the active store is never more than one glance away.
        </p>
      </div>

      <div>
        <div className="strong" style={{ marginBottom: 10 }}>Color tokens</div>
        <div className="token-grid">
          {tokens.map((t) => (
            <div key={t.name} className="token">
              <span className="swatch" style={{ background: t.value }} />
              <span style={{ minWidth: 0 }}><span className="name">{t.name}</span><span className="val">{t.value}</span></span>
            </div>
          ))}
        </div>
        <div className="mute" style={{ marginTop: 10, fontSize: 12 }}>
          Accent options: <span style={{ color: "#7fb0ff" }}>Cool blue #4c8dff</span> (default — reads “system”, pairs with amber/green status) or{" "}
          <span style={{ color: "#3fb97a" }}>Soft green #3fb97a</span> (on-brand for hemp, but competes with the Paid/Fulfilled status color — if chosen, shift status-green to teal #2fb3a0). Toggle in Settings → Appearance.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: 24 }}>
        <div>
          <div className="strong" style={{ marginBottom: 10 }}>Type scale · SF Pro (system stack)</div>
          <div className="card" style={{ padding: "6px 14px" }}>
            {typeScale.map((t) => (
              <div key={t.token} className="type-row">
                <span className="mute mono" style={{ fontSize: 11.5 }}>{t.token}</span>
                <span style={{ fontSize: t.size, fontWeight: t.weight, lineHeight: 1.2, letterSpacing: t.ls }}>{t.sample}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="strong" style={{ marginBottom: 10 }}>Spacing &amp; radius</div>
          <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {spacing.map((s) => (
              <div key={s.token} className="space-row"><span className="mono sub">{s.token}</span><span className="bar-sp" style={{ width: s.px }} /><span className="mute">{s.use}</span></div>
            ))}
            <div className="sub" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10, fontSize: 12, display: "flex", gap: 14, flexWrap: "wrap" }}>
              <span>radius-sm 5</span><span>radius-md 7</span><span>radius-lg 10</span><span>window 11</span><span>hairline rgba(255,255,255,.07)</span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="strong" style={{ marginBottom: 10 }}>Components</div>
        <div className="grid-2">
          <Card label="Buttons · 30/32px" note="Hover: +4% white overlay. Active: −4%. Focus ring: 2px accent at 40%.">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary">Primary</button>
              <button className="btn btn-secondary">Secondary</button>
              <button className="btn btn-ghost">Ghost</button>
              <button className="btn btn-danger">Danger</button>
              <button className="btn btn-control" disabled>Disabled</button>
            </div>
          </Card>
          <Card label="Status pills · 20px" note="Tint = status color at 12% alpha; text = full status color. Never pure saturated fills.">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Pill kind="green">Paid</Pill><Pill kind="green">Fulfilled</Pill><Pill kind="amber">Pending</Pill><Pill kind="amber">Partial</Pill><Pill kind="red">Failed</Pill><Pill kind="neutral">Unfulfilled</Pill>
            </div>
          </Card>
          <Card label="Inputs · 30px">
            <input className="input input-dark" placeholder="Default" readOnly />
            <input className="input input-dark" value="Focused" readOnly style={{ borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent-soft)" }} />
            <input className="input input-dark error" value="flowgardens.com" readOnly />
            <div style={{ fontSize: 11.5, color: "var(--red)", marginTop: -4 }}>Domain must end in .myshopify.com</div>
          </Card>
          <Card label="Sidebar item · 32px" note="Active uses neutral fill, not accent — accent stays reserved for actions.">
            <div style={{ display: "flex", flexDirection: "column", gap: 2, width: 200 }}>
              <div style={{ ...item, color: "var(--sub)" }}>Default</div>
              <div style={{ ...item, color: "var(--text)", background: "rgba(255,255,255,0.05)" }}>Hover</div>
              <div style={{ ...item, justifyContent: "space-between", color: "var(--text)", fontWeight: 600, background: "rgba(255,255,255,0.08)" }}><span>Active</span><span className="nav-badge">12</span></div>
            </div>
          </Card>
          <Card label="Toast · Empty state">
            <div className="toast" style={{ position: "static", width: "max-content", animation: "none" }}>
              <span className="dot d7 green" /><span>Synced 3 stores · 412 orders</span><span style={{ fontSize: 12, color: "var(--accent)", marginLeft: 8, fontWeight: 500 }}>View</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.12)" }}>
              <span style={{ width: 28, height: 28, borderRadius: 7, border: "1px dashed rgba(255,255,255,0.18)", flex: "none" }} />
              <span className="two-line"><span style={{ fontWeight: 500, fontSize: 12.5 }}>No lots received yet</span><span className="second">Empty states always lead with the primary action.</span></span>
            </div>
          </Card>
          <Card label="Tabs · Store switcher · KPI" note="Each store has a fixed identity dot (blue / violet / green) reused everywhere a store is named.">
            <div style={{ display: "flex", gap: 14, borderBottom: "1px solid var(--hairline)" }}>
              <span style={{ padding: "0 2px 8px", borderBottom: "2px solid var(--accent)", fontWeight: 500 }}>Shopify</span>
              <span className="sub" style={{ padding: "0 2px 8px", borderBottom: "2px solid transparent", fontWeight: 500 }}>FGINV</span>
            </div>
            <div className="seg" style={{ width: "max-content", background: "rgba(0,0,0,0.3)", borderColor: "var(--hairline)" }}>
              <span className="seg-item active" style={segItem}><span className="dot retail" />Retail</span>
              <span className="seg-item" style={segItem}><span className="dot b2b" />B2B / Wholesale</span>
              <span className="seg-item" style={segItem}><span className="dot bulk" />Bulk / Craft Flower</span>
            </div>
          </Card>
        </div>
      </div>

      <div>
        <div className="strong" style={{ marginBottom: 10 }}>Engineering handoff</div>
        <div className="grid-2">
          {handoff.map((h) => (
            <div key={h.title} className="card" style={{ padding: 14 }}>
              <div className="strong" style={{ marginBottom: 6 }}>{h.title}</div>
              <div className="sub" style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-line" }}>{h.body}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

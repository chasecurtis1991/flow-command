// Small presentational primitives shared by pages. Styling lives in App.css.
import type { ReactNode } from "react";
import type { Kind } from "../lib/shopify";

export function Pill({ kind, children, dot = true, sm }: { kind: Kind; children: ReactNode; dot?: boolean; sm?: boolean }) {
  return <span className={`pill ${kind}${dot ? "" : " nodot"}${sm ? " sm" : ""}`}>{children}</span>;
}

/** Dot + text status (e.g. "● Healthy · 84 ms"). */
export function Status({ kind, children }: { kind: Kind | "mute"; children: ReactNode }) {
  return (
    <span className={`status ${kind}`}>
      <span className={`dot ${kind}`} />
      {children}
    </span>
  );
}

export const Spinner = ({ size }: { size?: number }) => <div className="spinner" style={size ? { width: size, height: size } : undefined} />;

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state" style={{ gap: 12, color: "var(--sub)" }}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, why, action }: { title: string; why: string; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="state-icon" />
      <div className="strong">{title}</div>
      <div className="why">{why}</div>
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, why, actions }: { title: string; why: string; actions?: ReactNode }) {
  return (
    <div className="state">
      <div className="state-icon error">!</div>
      <div className="strong">{title}</div>
      <div className="why">{why}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Marks surfaces whose data is the design's sample data (no backend yet). */
export const SampleData = () => (
  <span className="pill neutral" title="Sample data from the design — no backend wired yet">Sample data</span>
);

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useConversation } from "@elevenlabs/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../lib/app";
import {
  ADJUST_REASONS, adjustInventory, invalidateInventory, invalidateOrdersTable, storeById, updateOrderNoteTags, voiceSessionToken, voiceStatus, voiceTextSessionUrl,
  type VoiceStatus,
} from "../lib/shopify";
import { Pill } from "../components/ui";
import { type NewProposal, type Proposal, type ToolContext, clearToolCache, makeTools, preloadInventory } from "./tools";

type Msg = { id: string; at: number; role: "user" | "agent"; text: string };
const reasonLabel = (r: string) => ADJUST_REASONS.find(([v]) => v === r)?.[1] ?? r;

/** The assistant drawer. Must render inside <ConversationProvider>; stays mounted (and the session alive) while hidden. */
export function AssistantPanel({ open, onClose, onUi }: { open: boolean; onClose: () => void; onUi: (action: string) => string }) {
  const { store, setStore } = useApp();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [setup, setSetup] = useState<VoiceStatus | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState<"voice" | "text" | null>(null);
  const [session, setSession] = useState<"voice" | "text" | null>(null);
  const pendingText = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open && !setup?.agentId) voiceStatus().then(setSetup).catch((e) => setError(String(e))); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (role: Msg["role"], t: string) => setMessages((ms) => {
    const last = ms[ms.length - 1];
    if (role === "user" && last?.role === "user" && last.text === t) return ms; // typed text echoed back by the SDK
    return [...ms, { id: crypto.randomUUID(), at: Date.now(), role, text: t }];
  });

  const conv = useConversation({
    onMessage: (m) => { if (m.message?.trim()) push(m.role === "user" ? "user" : "agent", m.message); },
    onError: (msg) => setError(typeof msg === "string" ? msg : String(msg)),
    onConnect: () => {
      preloadInventory(ctx.current.store); // the first stock question then answers from memory
      if (pendingText.current) { const t = pendingText.current; pendingText.current = null; window.setTimeout(() => conv.sendUserMessage(t), 150); }
    },
    onDisconnect: () => { setSession(null); setStarting(null); },
  });
  const connected = conv.status === "connected";

  // Tools read the latest store / router through a ref so the session never holds stale closures.
  const propose = useCallback((p: NewProposal): Proposal => {
    const full = { ...p, id: crypto.randomUUID(), createdAt: Date.now(), status: "pending" } as Proposal;
    setProposals((ps) => [...ps, full]);
    return full;
  }, []);
  const live = (): ToolContext => ({ store, go: navigate, propose, setStore, open: (u) => void openUrl(u), ui: onUi });
  const ctx = useRef<ToolContext>(live());
  ctx.current = live();
  const tools = useMemo(() => makeTools(() => ctx.current), []);
  // Dev only: lets the browser preview drive the real tools + router without an ElevenLabs session.
  if (import.meta.env.DEV) (window as unknown as { __assistantTools?: typeof tools }).__assistantTools = tools;

  // Keep the agent told where the user is (screen, store, selected record).
  const sel = new URLSearchParams(search).get("sel");
  useEffect(() => {
    if (connected) conv.sendContextualUpdate(`The app now shows the ${pathname.replace("/", "") || "home"} screen of the ${storeById(store).label} store${sel ? `; selected record ${sel}` : ""}.`);
  }, [connected, pathname, store, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [messages, proposals]);

  async function startVoice() {
    setError(null); setStarting("voice");
    try {
      const conversationToken = await voiceSessionToken();
      conv.startSession({ conversationToken, connectionType: "webrtc", clientTools: tools } as Parameters<typeof conv.startSession>[0]);
      setSession("voice");
    } catch (e) { setError(String(e)); } finally { setStarting(null); }
  }
  async function startText(first: string) {
    setError(null); setStarting("text"); pendingText.current = first;
    try {
      const signedUrl = await voiceTextSessionUrl();
      conv.startSession({ signedUrl, connectionType: "websocket", textOnly: true, overrides: { conversation: { textOnly: true } }, clientTools: tools } as Parameters<typeof conv.startSession>[0]);
      setSession("text");
    } catch (e) { setError(String(e)); pendingText.current = null; } finally { setStarting(null); }
  }
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    push("user", t);
    if (connected) conv.sendUserMessage(t);
    else void startText(t);
  };

  // ---- applying review cards (the only path that writes; same commands and safeguards as the screens) ----
  const patch = (id: string, p: Partial<Proposal>) => setProposals((ps) => ps.map((x) => (x.id === id ? ({ ...x, ...p } as Proposal) : x)));
  const tell = (t: string) => { if (connected) conv.sendContextualUpdate(t); };
  async function apply(p: Proposal) {
    patch(p.id, { status: "applying", error: undefined });
    try {
      if (p.kind === "inventory") {
        const [after] = await adjustInventory({
          storeId: p.storeId, reason: p.reason, idempotencyKey: p.id, kind: "adjust",
          changes: [{ inventoryItemId: p.inventoryItemId, locationId: p.locationId, delta: p.delta, changeFrom: p.available }],
        });
        const result = `Applied: ${p.label} at ${p.location} now ${after.available} available (${after.onHand} on hand).`;
        patch(p.id, { status: "applied", result });
        clearToolCache();
        invalidateInventory();
        tell(`The user applied review card ${p.id.slice(0, 4)}. ${result}`);
      } else {
        const r = await updateOrderNoteTags({ storeId: p.storeId, orderId: p.orderId, note: p.newNote, expectedNote: p.currentNote, addTags: p.addTags, removeTags: p.removeTags });
        const result = `Applied to ${p.orderName}: tags now ${r.tags.length ? r.tags.join(", ") : "none"}${p.newNote ? "; note updated" : ""}.`;
        patch(p.id, { status: "applied", result });
        invalidateOrdersTable();
        tell(`The user applied review card ${p.id.slice(0, 4)}. ${result}`);
      }
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      patch(p.id, { status: "failed", error: msg });
      tell(`Applying review card ${p.id.slice(0, 4)} failed: ${msg}`);
    }
  }
  const dismiss = (p: Proposal) => { patch(p.id, { status: "dismissed" }); tell(`The user dismissed review card ${p.id.slice(0, 4)}; nothing was changed.`); };

  const timeline: { at: number; m?: Msg; p?: Proposal }[] = [...messages.map((m) => ({ at: m.at, m })), ...proposals.map((p) => ({ at: p.createdAt, p }))].sort((a, b) => a.at - b.at);
  const ready = !!setup?.hasKey && !!setup?.agentId;
  const statusPill = connected ? <Pill kind="green" sm>{session === "text" ? "Typing" : conv.isSpeaking ? "Speaking" : conv.isMuted ? "Muted" : "Listening"}</Pill>
    : conv.status === "connecting" || starting ? <Pill kind="amber" sm>Connecting…</Pill> : <Pill kind="neutral" sm>Off</Pill>;

  return (
    <aside className={`assistant${open ? " open" : ""}`} aria-label="Assistant" aria-hidden={!open}>
      <div className="assistant-head">
        <span className="strong">Assistant</span>
        {statusPill}
        <span className="mute" style={{ fontSize: 11.5 }}>{storeById(store).short}</span>
        <div className="spacer" />
        {connected && session === "voice" && <button className="btn btn-control btn-sm" onClick={() => conv.setMuted(!conv.isMuted)}>{conv.isMuted ? "Unmute" : "Mute"}</button>}
        {(connected || conv.status === "connecting") && <button className="btn btn-control btn-sm" onClick={() => conv.endSession()}>End</button>}
        <button className="icon-btn" aria-label="Hide assistant" title="Hide (the conversation keeps going)" onClick={onClose}>×</button>
      </div>
      <div className="assistant-body" ref={scroller}>
        {!setup ? <div className="mute assistant-hint">Checking setup…</div>
          : !ready ? (
            <div className="assistant-hint">
              <p style={{ margin: 0 }}>Add your ElevenLabs key and set up the agent first.</p>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => { navigate("/settings"); onClose(); }}>Open Settings</button>
            </div>
          ) : timeline.length === 0 ? (
            <div className="mute assistant-hint">
              Ask about stock, orders or sales — “How many Lifter 7g do we have?”, “What’s the status of R94244?”, “Net sales this week?”. Changes (“remove two Lifter 7g, damaged”, “tag R94244 check-slip”) show up here as cards for you to Apply.
            </div>
          ) : timeline.map((x) => x.m ? (
            <div key={x.m.id} className={`bubble ${x.m.role}`}>{x.m.text}</div>
          ) : <ProposalCard key={x.p!.id} p={x.p!} onApply={() => void apply(x.p!)} onDismiss={() => dismiss(x.p!)} />)}
        {error && <div className="split-error" role="alert" style={{ margin: "8px 0 0" }}>{error.slice(0, 300)}</div>}
      </div>
      <div className="assistant-foot">
        {ready && !connected && conv.status !== "connecting" && (
          <button className="btn btn-primary talk-btn" disabled={!!starting} onClick={() => void startVoice()}>{starting === "voice" ? "Connecting…" : "🎙 Start talking"}</button>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input input-dark" style={{ flex: 1, minWidth: 0 }} placeholder={ready ? "Type a question…" : "Set up the assistant in Settings"} value={text} disabled={!ready || !!starting}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} aria-label="Message the assistant" />
          <button className="btn btn-secondary" disabled={!ready || !text.trim() || !!starting} onClick={send}>Send</button>
        </div>
      </div>
    </aside>
  );
}

function ProposalCard({ p, onApply, onDismiss }: { p: Proposal; onApply: () => void; onDismiss: () => void }) {
  const store = storeById(p.storeId).label;
  return (
    <div className={`proposal ${p.status}`}>
      <div className="proposal-head">
        <span className="label" style={{ marginBottom: 0 }}>{p.kind === "inventory" ? "Inventory change" : "Order update"} · {store}</span>
        <Pill kind={p.status === "applied" ? "green" : p.status === "failed" ? "red" : p.status === "dismissed" ? "neutral" : "amber"} sm>
          {p.status === "pending" ? "Needs review" : p.status === "applying" ? "Applying…" : p.status[0].toUpperCase() + p.status.slice(1)}
        </Pill>
      </div>
      {p.kind === "inventory" ? (
        <div className="proposal-body">
          <strong>{p.delta > 0 ? `+${p.delta}` : p.delta} × {p.label}</strong>{p.sku && <span className="mono mute"> · {p.sku}</span>}
          <div className="mute" style={{ fontSize: 12 }}>{p.location} · available {p.available} → <b style={{ color: "var(--text)" }}>{p.available + p.delta}</b> · {reasonLabel(p.reason)}</div>
        </div>
      ) : (
        <div className="proposal-body">
          <strong>{p.orderName}</strong>
          {p.newNote != null && <div style={{ fontSize: 12 }}><span className="mute">Note becomes:</span><div className="note-box" style={{ marginTop: 4 }}>{p.newNote}</div></div>}
          {(p.addTags.length > 0 || p.removeTags.length > 0) && <div className="tag-row" style={{ marginTop: 6 }}>
            {p.addTags.map((t) => <span key={`+${t}`} className="tag-chip adding">+ {t}</span>)}
            {p.removeTags.map((t) => <span key={`-${t}`} className="tag-chip removing">{t}</span>)}
          </div>}
        </div>
      )}
      {p.result && <div style={{ fontSize: 12, color: "var(--green)" }}>{p.result}</div>}
      {p.error && <div className="split-error" style={{ marginTop: 0 }}>{p.error}</div>}
      {(p.status === "pending" || p.status === "failed") && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary btn-sm" onClick={onDismiss}>Dismiss</button>
          <button className="btn btn-primary btn-sm" onClick={onApply}>{p.status === "failed" ? "Retry" : "Apply"}</button>
        </div>
      )}
    </div>
  );
}

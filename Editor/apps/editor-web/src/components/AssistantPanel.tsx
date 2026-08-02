import { Ban, Check, Loader2, Send, Sparkles, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import {
  applyAssistantCall,
  sendAssistantMessage,
  setAssistantModel,
  skipAssistantCall
} from "../lib/assistantClient";
import { useAssistant } from "../hooks/useAssistant";
import { type ChatItem, type ToolItem, useAssistantStore } from "../store/assistantStore";

/**
 * The assistant dock: a compact, resizable floating panel anchored bottom-right. It is mounted
 * once and always running the status hook, but renders nothing until opened, so it costs no
 * canvas space collapsed. Mutating tool calls appear as inline rows the operator Applies or
 * Skips; nothing changes the scene until Apply.
 */
export function AssistantPanel() {
  useAssistant();

  const open = useAssistantStore((state) => state.open);
  const setOpen = useAssistantStore((state) => state.setOpen);
  const status = useAssistantStore((state) => state.status);
  const items = useAssistantStore((state) => state.items);
  const sending = useAssistantStore((state) => state.sending);
  const sessionId = useAssistantStore((state) => state.sessionId);
  const dockHeight = useAssistantStore((state) => state.dockHeight);
  const setDockHeight = useAssistantStore((state) => state.setDockHeight);
  const pushUser = useAssistantStore((state) => state.pushUser);
  const setToolStatus = useAssistantStore((state) => state.setToolStatus);
  const ingest = useAssistantStore((state) => state.ingest);

  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items, open]);

  if (!open) return null;

  const canSend = Boolean(sessionId) && !sending && draft.trim().length > 0;

  const send = () => {
    const text = draft.trim();
    if (!text || !sessionId || sending) return;
    pushUser(text);
    setDraft("");
    void sendAssistantMessage(sessionId, text).catch((error: unknown) => {
      ingest({ type: "error", message: requestFailureMessage(error) });
    });
  };

  const apply = (id: string) => {
    if (!sessionId) return;
    setToolStatus(id, "executing");
    void applyAssistantCall(sessionId, id).catch((error: unknown) => {
      setToolStatus(id, "staged");
      ingest({ type: "error", message: requestFailureMessage(error) });
    });
  };

  const skip = (id: string) => {
    if (!sessionId) return;
    setToolStatus(id, "skipped");
    void skipAssistantCall(sessionId, id).catch((error: unknown) => {
      setToolStatus(id, "staged");
      ingest({ type: "error", message: requestFailureMessage(error) });
    });
  };

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const move = (moveEvent: MouseEvent) => setDockHeight(window.innerHeight - moveEvent.clientY);
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  return (
    <section className="assistant-panel" style={{ height: dockHeight }}>
      <div className="assistant-resize" onMouseDown={startResize} title="Drag to resize" />
      <header className="assistant-header">
        <span className="assistant-title">
          <Sparkles size={14} aria-hidden /> Assistant
        </span>
        <ModelPicker />
        <button type="button" className="assistant-icon-button" onClick={() => setOpen(false)} title="Close">
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className="assistant-messages" ref={listRef}>
        {items.length === 0 ? (
          <p className="assistant-empty">
            Ask the assistant to inspect or build the scene. It authors through the Editor's tools and
            {status?.readOnly ? " is read-only on this station." : " stages every change for you to Apply."}
          </p>
        ) : null}
        {items.map((item) => (
          <ChatRow key={item.kind === "tool" ? `tool-${item.id}` : item.id} item={item} onApply={apply} onSkip={skip} />
        ))}
      </div>

      <footer className="assistant-input">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={sessionId ? "Message the assistant…" : "Connecting to the assistant broker…"}
          disabled={!sessionId}
        />
        <button type="button" className="assistant-send" onClick={send} disabled={!canSend} title="Send (Enter)">
          {sending ? <Loader2 size={15} className="assistant-spin" aria-hidden /> : <Send size={15} aria-hidden />}
        </button>
      </footer>
    </section>
  );
}

function ChatRow(props: { item: ChatItem; onApply: (id: string) => void; onSkip: (id: string) => void }) {
  const { item } = props;
  if (item.kind === "tool") {
    return <ToolRow item={item} onApply={props.onApply} onSkip={props.onSkip} />;
  }
  return <div className={`assistant-msg assistant-msg-${item.kind}`}>{item.text}</div>;
}

function ToolRow(props: { item: ToolItem; onApply: (id: string) => void; onSkip: (id: string) => void }) {
  const { item } = props;
  const argsPreview = summariseInput(item.input);
  return (
    <div className={`assistant-tool assistant-tool-${item.status}`}>
      <div className="assistant-tool-head">
        <code className="assistant-tool-name">{item.name.replace(/^grapix_editor_/, "")}</code>
        <span className="assistant-tool-badge">{item.read ? "read" : "change"}</span>
        <span className="assistant-tool-status">{item.status}</span>
      </div>
      {argsPreview ? <div className="assistant-tool-args">{argsPreview}</div> : null}
      {item.result ? <div className={`assistant-tool-result ${item.isError ? "is-error" : ""}`}>{item.result}</div> : null}
      {item.status === "staged" ? (
        <div className="assistant-tool-actions">
          <button type="button" className="assistant-apply" onClick={() => props.onApply(item.id)}>
            <Check size={13} aria-hidden /> Apply
          </button>
          <button type="button" className="assistant-skip" onClick={() => props.onSkip(item.id)}>
            <Ban size={13} aria-hidden /> Skip
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ModelPicker() {
  const status = useAssistantStore((state) => state.status);
  if (!status) return null;
  const active = status.providers.find((provider) => provider.active);

  return (
    <span className="assistant-model-picker">
      <select
        value={status.provider}
        onChange={(event) => void setAssistantModel(event.target.value)}
        title="Model provider"
      >
        {status.providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
            {provider.hasKey ? "" : " (no key)"}
          </option>
        ))}
      </select>
      {active && active.models.length > 1 ? (
        <select
          value={status.model}
          onChange={(event) => void setAssistantModel(status.provider, event.target.value)}
          title="Model"
        >
          {active.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}

/** One-line preview of a tool's arguments, so a change reads at a glance without a JSON dump. */
function summariseInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const text = entries
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function requestFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Assistant request failed";
}

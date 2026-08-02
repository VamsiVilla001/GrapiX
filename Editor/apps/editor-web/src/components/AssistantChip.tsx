import { Sparkles } from "lucide-react";
import { useAssistantStore } from "../store/assistantStore";
import type { AssistantState } from "../lib/assistantClient";

/**
 * The always-visible "which model is connected" chip. It is the collapsed form of the whole
 * feature — one line in the status bar — and clicking it opens the assistant dock. It stays
 * out of the canvas entirely until opened.
 */
export function AssistantChip() {
  const status = useAssistantStore((state) => state.status);
  const open = useAssistantStore((state) => state.open);
  const toggleOpen = useAssistantStore((state) => state.toggleOpen);

  const tone = status ? toneFor(status.state) : "offline";
  const label = status ? `${status.providerLabel} · ${shortModel(status.model)}` : "offline";
  const stateWord = status ? stateLabel(status.state, status.toolsEnabled, status.readOnly) : "no broker";
  const title = status
    ? `${status.providerLabel} ${status.model} — ${status.state}${status.detail ? `: ${status.detail}` : ""}. ` +
      `MCP ${status.mcp}, ${status.toolCount} tools${status.toolsEnabled ? "" : " (advisory)"}. Click to ${open ? "hide" : "open"} the assistant.`
    : "Assistant broker not reachable on 4160. Start it with npm run dev:assistant.";

  return (
    <button
      type="button"
      className={`assistant-chip assistant-tone-${tone} ${open ? "assistant-chip-open" : ""}`}
      onClick={toggleOpen}
      title={title}
      aria-pressed={open}
    >
      <Sparkles size={13} aria-hidden />
      <span className="assistant-chip-dot" />
      <span className="assistant-chip-label">{label}</span>
      <span className="assistant-chip-state">{stateWord}</span>
    </button>
  );
}

function toneFor(state: AssistantState): "healthy" | "degraded" | "fallback" {
  if (state === "connected") return "healthy";
  if (state === "error") return "fallback";
  return "degraded";
}

function stateLabel(state: AssistantState, toolsEnabled: boolean, readOnly: boolean): string {
  if (state === "connected") return readOnly ? "read-only" : toolsEnabled ? "ready" : "advisory";
  if (state === "no-key") return "no key";
  if (state === "rate-limited") return "throttled";
  return state;
}

/** Trim a long model id to something that fits one line. */
function shortModel(model: string): string {
  return model.length > 22 ? `${model.slice(0, 21)}…` : model;
}

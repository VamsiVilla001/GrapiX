/**
 * Client for the Editor AI assistant broker (`@grapix/editor-assistant`, port 4160).
 *
 * The broker holds the model provider connection and the MCP client; the browser only sends
 * prompts and renders the streamed reply. Types mirror the broker's `status.ts` / agent events
 * — redeclared here because the web app must not depend on a service package, the same way
 * `apiClient.ts` mirrors project-api's shapes.
 */

const assistantBaseUrl = "http://127.0.0.1:4160";

export type AssistantState = "connected" | "connecting" | "no-key" | "error" | "rate-limited";

export interface ProviderSummary {
  id: string;
  label: string;
  hasKey: boolean;
  model: string;
  models: string[];
  active: boolean;
}

export interface AssistantStatus {
  provider: string;
  providerLabel: string;
  model: string;
  state: AssistantState;
  detail?: string;
  toolsEnabled: boolean;
  readOnly: boolean;
  mcp: "connecting" | "connected" | "error";
  mcpConnected: boolean;
  toolCount: number;
  providers: ProviderSummary[];
  sessionTokenBudget: number;
  lastUsage?: { inputTokens: number; outputTokens: number };
}

/** One streamed event from a chat turn. Mirrors the broker's `AgentEvent`. */
export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "tool-executing"; id: string; name: string; input: Record<string, unknown>; read: boolean }
  | { type: "tool-result"; id: string; name: string; text: string; isError: boolean }
  | { type: "staged"; call: { id: string; name: string; input: Record<string, unknown>; status: string } }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "done" };

const CHAT_EVENTS = ["text", "tool-executing", "tool-result", "staged", "usage", "error", "done"] as const;

async function postJson(path: string, body: unknown): Promise<void> {
  await fetch(`${assistantBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function getAssistantStatus(): Promise<AssistantStatus> {
  const response = await fetch(`${assistantBaseUrl}/assistant/status`);
  if (!response.ok) throw new Error(`assistant status ${response.status}`);
  return (await response.json()) as AssistantStatus;
}

export function openStatusStream(onStatus: (status: AssistantStatus) => void): EventSource {
  const source = new EventSource(`${assistantBaseUrl}/assistant/status/stream`);
  source.addEventListener("status", (event) => {
    try {
      onStatus(JSON.parse((event as MessageEvent).data) as AssistantStatus);
    } catch {
      // ignore a malformed frame
    }
  });
  return source;
}

export async function createAssistantSession(): Promise<string> {
  const response = await fetch(`${assistantBaseUrl}/assistant/session`, { method: "POST" });
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

export function openChatStream(sessionId: string, onEvent: (event: AssistantEvent) => void): EventSource {
  const source = new EventSource(`${assistantBaseUrl}/assistant/stream?sessionId=${encodeURIComponent(sessionId)}`);
  for (const name of CHAT_EVENTS) {
    source.addEventListener(name, (event) => {
      try {
        onEvent(JSON.parse((event as MessageEvent).data) as AssistantEvent);
      } catch {
        // ignore a malformed frame
      }
    });
  }
  return source;
}

export async function sendAssistantMessage(sessionId: string, text: string): Promise<void> {
  await postJson("/assistant/message", { sessionId, text });
}

export async function applyAssistantCall(sessionId: string, callId: string): Promise<void> {
  await postJson("/assistant/apply", { sessionId, callId });
}

export async function skipAssistantCall(sessionId: string, callId: string): Promise<void> {
  await postJson("/assistant/skip", { sessionId, callId });
}

export async function setAssistantModel(providerId: string, model?: string): Promise<void> {
  await postJson("/assistant/model", { providerId, model });
}

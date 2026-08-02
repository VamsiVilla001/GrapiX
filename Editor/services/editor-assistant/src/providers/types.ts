/**
 * Provider-neutral chat contracts.
 *
 * The agent loop speaks these types; each `ModelProvider` adapter maps them to and from a
 * specific vendor API. A normalized content-block model (text / tool_use / tool_result) is the
 * one shape every current provider can be projected onto, so adding a provider is an adapter,
 * not a change to the loop.
 */

import type { ProviderId } from "../config.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  /** Rendered result text handed back to the model. */
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: ContentBlock[];
}

/** A tool offered to the model. `inputSchema` is JSON Schema, as the MCP server already emits. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "error";

/** One event in a streamed model response. */
export type ProviderStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; message: string };

export interface ModelProvider {
  id: ProviderId;
  label: string;
  model: string;
  supportsTools: boolean;
  /** Stream a completion. Implementations must not throw mid-stream — emit an `error` event instead. */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}

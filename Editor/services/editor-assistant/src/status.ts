/**
 * The status contract the Editor UI renders as its "which model is connected" chip.
 *
 * Named here (not derived via ReturnType at a consumer) so the web client can mirror the exact
 * shape and both sides move together.
 */

import type { ProviderId } from "./config.js";
import type { McpConnectionState } from "./mcpClient.js";

export type AssistantState = "connected" | "connecting" | "no-key" | "error" | "rate-limited";

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  hasKey: boolean;
  model: string;
  models: string[];
  active: boolean;
}

export interface AssistantStatus {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  state: AssistantState;
  detail?: string;
  /** True when the assistant can author: MCP connected and not read-only. */
  toolsEnabled: boolean;
  readOnly: boolean;
  mcp: McpConnectionState;
  mcpConnected: boolean;
  toolCount: number;
  providers: ProviderSummary[];
  sessionTokenBudget: number;
  lastUsage?: { inputTokens: number; outputTokens: number };
}

/**
 * Configuration for the Editor AI assistant broker.
 *
 * Resolved and validated before any transport opens, so a missing provider key surfaces at
 * startup as a `no-key` status rather than a confusing failure on the first message.
 *
 * Provider API keys live here, in a service, never in the browser. `architecture.md` §7
 * requires credentials to be injected into web clients in memory and never persisted in
 * browser storage; session rule 90 keeps secrets in a service, not the web app. The browser
 * panel holds only a short-lived loopback origin, and reaches a model exclusively through this
 * broker.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
// dist/ (built) or src/ (tsx) — either way `../..` is Editor/services, so the MCP entry point
// resolves to the sibling editor-mcp build regardless of how this process was launched.
const repositoryRoot = path.resolve(serviceDirectory, "..", "..", "..", "..");
const defaultMcpEntry = path.resolve(serviceDirectory, "..", "..", "editor-mcp", "dist", "index.js");

export type ProviderId = "anthropic" | "openai" | "google" | "openai-compatible";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** The runtime key sent to the adapter. A local runtime uses a placeholder; hosted providers need a real one. */
  apiKey?: string;
  /**
   * Whether the user actually configured this provider (a real key, or an explicit local
   * endpoint). Distinct from `apiKey`: the local adapter always has a placeholder key so its
   * requests are well-formed, but it is only *configured* when the operator opted into it.
   * Auto-selection and the `no-key` status read this, never the placeholder.
   */
  configured: boolean;
  baseUrl: string;
  /** The model used when this provider is active. */
  model: string;
  /** Known models offered to the picker. Advisory — a deployment may set any model id. */
  models: string[];
  /** Whether the provider's chat API supports tool calling. A model without it can advise but not author. */
  supportsTools: boolean;
}

export interface AssistantConfig {
  host: string;
  port: number;
  /** project-api base, passed to the spawned editor-mcp so its authoring tools work. */
  apiUrl: string;
  apiToken?: string;
  mcp: {
    /** Executable to launch the editor-mcp server. Defaults to this Node. */
    command: string;
    args: string[];
    /**
     * When true the child runs with `--read-only`, so mutating tools are not even present.
     * When false the tools are present but the agent always *stages* a mutation for operator
     * Apply/Skip — it never auto-applies one.
     */
    readOnly: boolean;
    env: Record<string, string>;
  };
  activeProviderId: ProviderId;
  providers: ProviderConfig[];
  /** Soft ceiling on tokens per session before the broker refuses to continue (AA-4). */
  sessionTokenBudget: number;
  /** Where transcripts are persisted (AA-4). Runtime state, gitignored. */
  dataDir: string;
}

export class ConfigurationError extends Error {}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function firstKey(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Build the provider table from the environment. A provider with no key still appears, as `no-key`. */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  return [
    {
      id: "anthropic",
      label: "Claude",
      apiKey: firstKey(env, "ANTHROPIC_API_KEY", "GRAPIX_ANTHROPIC_API_KEY"),
      configured: Boolean(firstKey(env, "ANTHROPIC_API_KEY", "GRAPIX_ANTHROPIC_API_KEY")),
      baseUrl: env.GRAPIX_ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
      model: env.GRAPIX_ANTHROPIC_MODEL?.trim() || "claude-3-5-sonnet-latest",
      models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
      supportsTools: true
    },
    {
      id: "openai",
      label: "GPT",
      apiKey: firstKey(env, "OPENAI_API_KEY", "GRAPIX_OPENAI_API_KEY"),
      configured: Boolean(firstKey(env, "OPENAI_API_KEY", "GRAPIX_OPENAI_API_KEY")),
      baseUrl: env.GRAPIX_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: env.GRAPIX_OPENAI_MODEL?.trim() || "gpt-4o",
      models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
      supportsTools: true
    },
    {
      id: "google",
      label: "Gemini",
      apiKey: firstKey(env, "GOOGLE_API_KEY", "GEMINI_API_KEY", "GRAPIX_GOOGLE_API_KEY"),
      configured: Boolean(firstKey(env, "GOOGLE_API_KEY", "GEMINI_API_KEY", "GRAPIX_GOOGLE_API_KEY")),
      baseUrl: env.GRAPIX_GOOGLE_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta",
      model: env.GRAPIX_GOOGLE_MODEL?.trim() || "gemini-1.5-pro",
      models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
      supportsTools: true
    },
    {
      // A local runtime (Ollama / LM Studio / vLLM) that speaks the OpenAI chat API, so a
      // station can run fully offline. Its adapter key is a placeholder; it is only *configured*
      // when the operator points it at a real endpoint or model, which is what auto-selection reads.
      id: "openai-compatible",
      label: "Local",
      apiKey: firstKey(env, "GRAPIX_LOCAL_API_KEY") ?? "local",
      configured: Boolean(
        env.GRAPIX_LOCAL_API_KEY?.trim() || env.GRAPIX_LOCAL_BASE_URL?.trim() || env.GRAPIX_LOCAL_MODEL?.trim()
      ),
      baseUrl: env.GRAPIX_LOCAL_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
      model: env.GRAPIX_LOCAL_MODEL?.trim() || "llama3.1",
      models: [env.GRAPIX_LOCAL_MODEL?.trim() || "llama3.1"],
      supportsTools: true
    }
  ];
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const providers = resolveProviders(env);

  const requestedProvider = (env.GRAPIX_ASSISTANT_PROVIDER?.trim() as ProviderId | undefined) ?? undefined;
  // Prefer an explicitly requested provider; otherwise the first one that actually has a key;
  // otherwise anthropic, so `status` reports `no-key` against a real provider rather than nothing.
  const activeProviderId: ProviderId =
    (requestedProvider && providers.some((p) => p.id === requestedProvider) && requestedProvider) ||
    providers.find((p) => p.configured)?.id ||
    "anthropic";

  const modelOverride = env.GRAPIX_ASSISTANT_MODEL?.trim();
  if (modelOverride) {
    const active = providers.find((p) => p.id === activeProviderId);
    if (active) active.model = modelOverride;
  }

  const apiUrl = env.GRAPIX_API_URL?.trim() || "http://127.0.0.1:4100";
  const apiToken = env.GRAPIX_API_TOKEN?.trim() || undefined;
  const readOnly = bool(env.GRAPIX_ASSISTANT_READ_ONLY, false);

  const mcpEnv: Record<string, string> = { GRAPIX_API_URL: apiUrl };
  if (apiToken) mcpEnv.GRAPIX_API_TOKEN = apiToken;
  if (env.GRAPIX_REPOSITORY_ROOT?.trim()) mcpEnv.GRAPIX_REPOSITORY_ROOT = env.GRAPIX_REPOSITORY_ROOT.trim();

  const command = env.GRAPIX_ASSISTANT_MCP_COMMAND?.trim() || process.execPath;
  const entry = env.GRAPIX_ASSISTANT_MCP_ENTRY?.trim() || defaultMcpEntry;
  const args = [entry, ...(readOnly ? ["--read-only"] : [])];

  const dataDir = env.GRAPIX_ASSISTANT_DATA_DIR?.trim()
    ? path.resolve(env.GRAPIX_ASSISTANT_DATA_DIR)
    : path.join(repositoryRoot, "data", "assistant");

  return {
    host: env.GRAPIX_ASSISTANT_HOST?.trim() || "127.0.0.1",
    port: num(env.GRAPIX_ASSISTANT_PORT, 4160),
    apiUrl,
    apiToken,
    mcp: { command, args, readOnly, env: mcpEnv },
    activeProviderId,
    providers,
    sessionTokenBudget: num(env.GRAPIX_ASSISTANT_TOKEN_BUDGET, 400_000),
    dataDir
  };
}

export function activeProvider(config: AssistantConfig): ProviderConfig {
  const provider = config.providers.find((p) => p.id === config.activeProviderId);
  if (!provider) {
    throw new ConfigurationError(`active provider '${config.activeProviderId}' is not configured`);
  }
  return provider;
}

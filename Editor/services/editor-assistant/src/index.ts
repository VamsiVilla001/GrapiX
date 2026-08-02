/**
 * GrapiX Editor AI assistant broker.
 *
 * The client half of the Model Context Protocol that the editor-mcp server is the other half
 * of: it spawns and owns an editor-mcp child, connects a model provider, runs the tool-call
 * loop, and streams the conversation to a compact chat panel in the Editor UI. Provider keys
 * live here, in the service, never in the browser.
 *
 * It holds no Program or output authority. Every authoring action flows child → project-api
 * (4100); the editor-mcp authority guard (session rule 89) means no tool it could call names
 * Cue/Take/Continue/Clear/Program or an output verb, and the engine would refuse one by role
 * regardless.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./agent.js";
import { activeProvider, type AssistantConfig, type ProviderConfig, resolveConfig } from "./config.js";
import { EditorMcpClient } from "./mcpClient.js";
import { readAllowedAssistantOrigins } from "./origins.js";
import { createProvider } from "./providers/index.js";
import { AssistantAudit } from "./audit.js";
import { SseBus } from "./sse.js";
import type { AssistantState, AssistantStatus, ProviderSummary } from "./status.js";
import { TranscriptStore } from "./transcripts.js";

const config = resolveConfig();

function log(message: string): void {
  process.stderr.write(`[grapix-editor-assistant] ${message}\n`);
}

const sse = new SseBus();
const audit = new AssistantAudit(config.dataDir);
const transcripts = new TranscriptStore(config.dataDir);
const sessions = new Map<string, Agent>();

let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
let systemPrompt = buildSystemPrompt("", config.mcp.readOnly);

const mcp = new EditorMcpClient(config, {
  onStateChange: (state) => {
    emitStatus();
    if (state === "connected") void refreshSystemPrompt();
  }
});

function currentProviderConfig(): ProviderConfig {
  return activeProvider(config);
}

function buildSystemPrompt(primer: string, readOnly: boolean): string {
  const rules = [
    "You are the GrapiX Editor assistant. You help an author build broadcast graphics scenes",
    "by calling the Editor's authoring tools. You are the Editor and only the Editor.",
    "",
    "Hard rules:",
    "- You cannot Cue, Take, Continue, Clear Program, or configure outputs. Those are Playout's.",
    "  No tool you have can do it; do not claim otherwise.",
    "- Read tools run immediately. A tool that changes a scene is STAGED for the operator to",
    "  Apply or Skip; it does not take effect until they approve it. Explain what you will change",
    "  before you propose it.",
    readOnly
      ? "- This station is READ-ONLY: only read tools are available. Describe changes; do not attempt to author."
      : "- Propose one coherent change at a time and let the operator approve it.",
    "- Ground every answer in tool results, not assumption. Prefer analyze_scene and the primer.",
    "- Several enums are declared but not rendered (some blend modes, texture fit modes,",
    "  non-cut transitions). Never author a value the capability map marks unimplemented."
  ].join("\n");
  return primer ? `${rules}\n\n---\nEditor orientation and capability map:\n\n${primer}` : rules;
}

async function refreshSystemPrompt(): Promise<void> {
  let primer = "";
  if (mcp.isConnected()) {
    const result = await mcp.callTool("grapix_editor_get_primer", { include_capabilities: true });
    if (!result.isError) primer = result.text;
  }
  systemPrompt = buildSystemPrompt(primer, config.mcp.readOnly);
  for (const agent of sessions.values()) agent.setSystem(systemPrompt);
}

function providerSummaries(): ProviderSummary[] {
  return config.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hasKey: provider.configured,
    model: provider.model,
    models: provider.models,
    active: provider.id === config.activeProviderId
  }));
}

function buildStatus(): AssistantStatus {
  const provider = currentProviderConfig();
  const mcpState = mcp.getState();
  let state: AssistantState;
  let detail = mcp.getDetail();
  if (!provider.configured) {
    state = "no-key";
    detail = provider.id === "openai-compatible"
      ? "Local model not configured (set GRAPIX_LOCAL_BASE_URL / GRAPIX_LOCAL_MODEL)."
      : `No API key for ${provider.label}.`;
  } else if (mcpState === "error") {
    state = "error";
  } else if (mcpState === "connecting") {
    state = "connecting";
  } else {
    state = "connected";
  }

  return {
    provider: provider.id,
    providerLabel: provider.label,
    model: provider.model,
    state,
    detail,
    toolsEnabled: mcp.isConnected() && !config.mcp.readOnly,
    readOnly: config.mcp.readOnly,
    mcp: mcpState,
    mcpConnected: mcp.isConnected(),
    toolCount: mcp.listToolInfo().length,
    providers: providerSummaries(),
    sessionTokenBudget: config.sessionTokenBudget,
    lastUsage
  };
}

function emitStatus(): void {
  sse.emit("status", { event: "status", data: buildStatus() });
}

function agentEmitter(sessionId: string): (event: AgentEvent) => void {
  return (event) => {
    sse.emit(`chat:${sessionId}`, { event: event.type, data: event });
    if (event.type === "tool-executing" && !event.read) {
      void audit.record({
        at: new Date().toISOString(),
        actor: `assistant:${currentProviderConfig().model}`,
        sessionId,
        tool: event.name,
        input: event.input
      });
    } else if (event.type === "usage") {
      lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      emitStatus();
    } else if (event.type === "done") {
      const agent = sessions.get(sessionId);
      if (agent) void transcripts.save(agent.transcript());
    }
  };
}

async function getOrCreateAgent(sessionId: string): Promise<Agent> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const agent = new Agent(sessionId, createProvider(currentProviderConfig()), mcp, config, systemPrompt, agentEmitter(sessionId));
  const restored = await transcripts.load(sessionId);
  if (restored) agent.restore(restored);
  sessions.set(sessionId, agent);
  return agent;
}

const startedAtMs = Date.now();
const buildAtMs = await stat(fileURLToPath(import.meta.url))
  .then((info) => info.mtimeMs)
  .catch(() => 0);

const allowedOrigins = readAllowedAssistantOrigins();
const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

await app.register(cors, {
  origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.has(origin))
});

app.get("/assistant/health", async () => ({
  ok: true,
  service: "grapix-editor-assistant",
  startedAt: new Date(startedAtMs).toISOString(),
  buildAt: buildAtMs ? new Date(buildAtMs).toISOString() : null
}));

app.get("/assistant/status", async () => buildStatus());

app.get("/assistant/status/stream", async (_request, reply) => {
  sse.subscribe("status", reply);
  emitStatus();
  return reply;
});

app.get("/assistant/providers", async () => ({ providers: providerSummaries(), active: config.activeProviderId }));

app.post<{ Body: { providerId?: string; model?: string } }>("/assistant/model", async (request, reply) => {
  const { providerId, model } = request.body ?? {};
  const target = config.providers.find((provider) => provider.id === providerId);
  if (!target) {
    return reply.code(400).send({ error: `Unknown provider '${providerId ?? ""}'.` });
  }
  config.activeProviderId = target.id;
  if (model?.trim()) target.model = model.trim();
  const provider = createProvider(target);
  for (const agent of sessions.values()) agent.setProvider(provider);
  emitStatus();
  return buildStatus();
});

app.post("/assistant/session", async () => {
  const sessionId = randomUUID();
  await getOrCreateAgent(sessionId);
  return { sessionId };
});

app.get<{ Querystring: { sessionId?: string } }>("/assistant/stream", async (request, reply) => {
  const sessionId = request.query.sessionId?.trim();
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required" });
  }
  sse.subscribe(`chat:${sessionId}`, reply);
  return reply;
});

app.post<{ Body: { sessionId?: string; text?: string } }>("/assistant/message", async (request, reply) => {
  const sessionId = request.body?.sessionId?.trim();
  const text = request.body?.text?.trim();
  if (!sessionId || !text) {
    return reply.code(400).send({ error: "sessionId and text are required" });
  }
  const agent = await getOrCreateAgent(sessionId);
  agent.setProvider(createProvider(currentProviderConfig()));
  agent.setSystem(systemPrompt);
  // Fire the turn; content streams over the SSE chat channel. Resolves when the turn ends or
  // pauses for a staged mutation, at which point the HTTP call returns.
  void agent.send(text);
  return { ok: true };
});

app.post<{ Body: { sessionId?: string; callId?: string } }>("/assistant/apply", async (request, reply) => {
  const { sessionId, callId } = request.body ?? {};
  const agent = sessionId ? sessions.get(sessionId) : undefined;
  if (!agent || !callId) {
    return reply.code(400).send({ error: "sessionId and callId are required, and the session must exist" });
  }
  void agent.apply(callId);
  return { ok: true };
});

app.post<{ Body: { sessionId?: string; callId?: string } }>("/assistant/skip", async (request, reply) => {
  const { sessionId, callId } = request.body ?? {};
  const agent = sessionId ? sessions.get(sessionId) : undefined;
  if (!agent || !callId) {
    return reply.code(400).send({ error: "sessionId and callId are required, and the session must exist" });
  }
  void agent.skip(callId);
  return { ok: true };
});

app.get<{ Querystring: { sessionId?: string } }>("/assistant/transcript", async (request, reply) => {
  const sessionId = request.query.sessionId?.trim();
  const agent = sessionId ? sessions.get(sessionId) : undefined;
  if (!agent) {
    return reply.code(404).send({ error: "no such session" });
  }
  return agent.transcript();
});

// Connect the MCP child before binding, so the first status a UI sees is real.
await mcp.connect();
await refreshSystemPrompt();

await app.listen({ host: config.host, port: config.port });
log(`listening on http://${config.host}:${config.port} — provider ${config.activeProviderId}, MCP ${mcp.getState()}`);

async function shutdown(): Promise<void> {
  sse.close();
  await mcp.close();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

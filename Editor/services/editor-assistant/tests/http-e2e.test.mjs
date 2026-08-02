/**
 * End-to-end: a stub OpenAI-compatible model drives a spawned broker through one full turn.
 *
 * This exercises the whole live pipeline the unit tests cannot — HTTP, the SSE chat stream, the
 * OpenAI adapter's wire format, and a real editor-mcp child executing a read tool — without a
 * paid model or a network. The stub asks for one read tool (get_primer), then answers with text
 * once it sees the tool result, so a passing run proves broker → model → MCP → model → done.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brokerEntry = path.join(packageRoot, "dist", "index.js");
const mcpEntry = path.resolve(packageRoot, "..", "editor-mcp", "dist", "index.js");
const BROKER_PORT = 4173;

function sseChunk(object) {
  return `data: ${JSON.stringify(object)}\n\n`;
}

/** A minimal OpenAI chat-completions stub: request a read tool, then answer once it is resolved. */
function startStubModel() {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw);
      const sawToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!sawToolResult) {
        response.write(
          sseChunk({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "grapix_editor_get_primer", arguments: "{}" } }
                  ]
                }
              }
            ]
          })
        );
        response.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      } else {
        response.write(sseChunk({ choices: [{ index: 0, delta: { content: "GrapiX has three products." } }] }));
        response.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("broker did not become healthy");
}

/** Read the SSE chat stream, resolving with the collected events once `done` arrives. */
async function collectUntilDone(sessionId, timeoutMs = 15_000) {
  const response = await fetch(`http://127.0.0.1:${BROKER_PORT}/assistant/stream?sessionId=${sessionId}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) events.push({ event, data: JSON.parse(data) });
      boundary = buffer.indexOf("\n\n");
    }
    if (events.some((entry) => entry.event === "done")) break;
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

test("a full chat turn runs the model, executes a read tool, and streams a reply", async (t) => {
  const { server, port: stubPort } = await startStubModel();
  const dataDir = mkdtempSync(path.join(tmpdir(), "grapix-assistant-e2e-"));

  const broker = spawn(process.execPath, [brokerEntry], {
    env: {
      ...process.env,
      GRAPIX_ASSISTANT_PORT: String(BROKER_PORT),
      GRAPIX_ASSISTANT_PROVIDER: "openai-compatible",
      GRAPIX_LOCAL_BASE_URL: `http://127.0.0.1:${stubPort}`,
      GRAPIX_LOCAL_MODEL: "stub-model",
      GRAPIX_ASSISTANT_MCP_ENTRY: mcpEntry,
      GRAPIX_ASSISTANT_DATA_DIR: dataDir
    },
    stdio: "ignore"
  });

  t.after(async () => {
    broker.kill();
    server.close();
  });

  await waitForHealth(`http://127.0.0.1:${BROKER_PORT}/assistant/health`);

  const status = await fetch(`http://127.0.0.1:${BROKER_PORT}/assistant/status`).then((r) => r.json());
  assert.equal(status.provider, "openai-compatible");
  assert.equal(status.mcpConnected, true, "the broker must connect its editor-mcp child");
  assert.ok(status.toolCount > 0, "the child must expose tools");

  const { sessionId } = await fetch(`http://127.0.0.1:${BROKER_PORT}/assistant/session`, { method: "POST" }).then(
    (r) => r.json()
  );

  const collected = collectUntilDone(sessionId);
  // Give the SSE reader a moment to attach before the turn starts.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fetch(`http://127.0.0.1:${BROKER_PORT}/assistant/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text: "what is GrapiX?" })
  });

  const events = await collected;
  const kinds = events.map((entry) => entry.event);

  assert.ok(kinds.includes("tool-executing"), "the read tool should execute");
  const exec = events.find((entry) => entry.event === "tool-executing");
  assert.equal(exec.data.name, "grapix_editor_get_primer");
  assert.equal(exec.data.read, true, "get_primer must be classified as a read (auto-executed)");
  assert.ok(kinds.includes("tool-result"), "the tool result should stream back");
  assert.ok(
    events.some((entry) => entry.event === "text" && entry.data.text.includes("three products")),
    "the model's final answer should stream as text"
  );
  assert.ok(kinds.includes("done"), "the turn should end with done");
});

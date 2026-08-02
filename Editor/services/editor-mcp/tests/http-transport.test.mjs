/**
 * The Streamable HTTP transport, driven by real MCP clients.
 *
 * This exists because the HTTP path shipped broken: it reused a single `Server` instance and
 * connected a fresh transport per request, so a client's *second* call died with "Already
 * connected to a transport". stdio hid it (one server per process), which meant every
 * HTTP-based client — Cursor, a remote Codex, anything attaching to a running server — failed
 * immediately after the handshake. The fix is one server per session, keyed by `mcp-session-id`.
 *
 * A single-call test would have passed against the bug, so these deliberately make several
 * calls per session and open two sessions at once.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(packageRoot, "dist", "index.js");
const PORT = 4157;
const endpoint = new URL(`http://127.0.0.1:${PORT}/mcp`);

let server;

before(async () => {
  server = spawn(process.execPath, [entryPoint, "--http"], {
    env: { ...process.env, GRAPIX_MCP_PORT: String(PORT) },
    stdio: "ignore"
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the HTTP MCP server did not become healthy");
});

after(() => {
  server?.kill();
});

test("health reports the server, its tool count and its live session count", async () => {
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.server, "grapix-editor-mcp-server");
  assert.equal(health.tools, 54);
  assert.equal(typeof health.sessions, "number");
});

test("one HTTP session serves many calls in sequence", async () => {
  const client = new Client({ name: "http-regression-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(endpoint));

  // Call 2 onwards is what the old implementation could not do.
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 54);

  const resources = await client.listResources();
  assert.ok(resources.resources.length > 0);

  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.length > 0);

  const primer = await client.callTool({
    name: "grapix_editor_get_primer",
    arguments: { include_capabilities: false }
  });
  assert.match(primer.content[0].text, /three products/i);

  await client.close();
});

test("two clients hold independent concurrent sessions", async () => {
  const first = new Client({ name: "client-one", version: "1.0.0" });
  const second = new Client({ name: "client-two", version: "1.0.0" });
  await first.connect(new StreamableHTTPClientTransport(endpoint));
  await second.connect(new StreamableHTTPClientTransport(endpoint));

  // Interleaved on purpose: a shared server would cross-talk or refuse one of them.
  const firstTools = await first.listTools();
  const secondTools = await second.listTools();
  const firstAgain = await first.listTools();

  assert.equal(firstTools.tools.length, 54);
  assert.equal(secondTools.tools.length, 54);
  assert.equal(firstAgain.tools.length, 54);

  await first.close();
  await second.close();
});

test("a non-initialize POST without a session is refused, not served", async () => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(JSON.stringify(body), /session/i);
});

test("an unknown path names the MCP endpoint instead of 404-ing blankly", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/nope`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error, /\/mcp/);
});

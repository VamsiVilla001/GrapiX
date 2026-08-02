#!/usr/bin/env node
/**
 * GrapiX Editor MCP server.
 *
 * Connects any MCP client — Claude Code and Claude Desktop, Codex, Gemini CLI,
 * Kimi, or anything else that speaks the protocol — to the GrapiX Editor: its
 * authoring tools, and the ingested architecture, contracts and capability map
 * of the application.
 *
 * Two transports:
 *
 *   stdio  the client launches this process and owns it. The default, and the
 *          right one for a desktop assistant. Nothing may be written to stdout
 *          except protocol frames, so all logging goes to stderr.
 *   http   streamable HTTP on loopback, for clients that attach to a running
 *          server or share one between several assistants. Stateless per
 *          request, with DNS-rebinding protection on by default.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { KnowledgeBase } from "./knowledge/index.js";
import { ProjectApiClient } from "./projectApiClient.js";
import { ConfigurationError, resolveConfig, type EditorMcpConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createEditorMcpServer } from "./server.js";

/** stdout belongs to the protocol on stdio; every diagnostic goes to stderr. */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/** Buffer and JSON-parse a request body; undefined when empty or malformed. */
function readBody(request: IncomingMessage): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    if (!raw) {
      resolve(undefined);
      return;
    }
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve(undefined);
    }
  });
  request.on("error", () => resolve(undefined));
  return promise;
}

async function runStdio(config: EditorMcpConfig): Promise<void> {
  const { server, knowledge, registeredTools } = createEditorMcpServer(config);

  // Warm the corpus before accepting traffic so the first knowledge call is not
  // the one that pays for reading the whole repository.
  const snapshot = await knowledge.load();

  await server.connect(new StdioServerTransport());

  log(
    `ready on stdio — ${registeredTools.length} tools${config.readOnly ? " (read-only)" : ""}, ` +
      `${snapshot.documents.length} documents, ${snapshot.sessionRules.length} session rules, ` +
      `project service ${config.projectApiUrl}`
  );
}

async function runHttp(config: EditorMcpConfig): Promise<void> {
  const allowedHosts = [
    `${config.httpHost}:${config.httpPort}`,
    `127.0.0.1:${config.httpPort}`,
    `localhost:${config.httpPort}`
  ];

  // The corpus and project client are shared across every session, so a new client connection
  // is cheap and never re-ingests the repository. Loaded once, here.
  const knowledge = new KnowledgeBase(config.repositoryRoot);
  const client = new ProjectApiClient(config);
  const snapshot = await knowledge.load();
  const { registeredTools } = createEditorMcpServer(config, { knowledge, client });

  // One MCP server per client session, keyed by the session id the transport assigns on
  // initialize. The previous implementation reused a single server across connections, so a
  // client's second request died with "Already connected to a transport" — which meant every
  // HTTP client (Cursor, a remote Codex, anything not on stdio) broke after the handshake.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          tools: registeredTools.length,
          sessions: sessions.size,
          readOnly: config.readOnly
        })
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "The MCP endpoint is /mcp" }));
      return;
    }

    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;

    try {
      if (request.method === "POST") {
        const body = await readBody(request);
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.handleRequest(request, response, body);
          return;
        }
        // A request without a live session is only valid if it is the initialize handshake.
        if (!isInitializeRequest(body)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "No valid session; send an initialize request first." },
              id: null
            })
          );
          return;
        }
        const built = createEditorMcpServer(config, { knowledge, client });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          void built.server.close();
        };
        await built.server.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }

      // GET opens the server→client notification stream; DELETE ends a session. Both must name
      // an existing session.
      if (request.method === "GET" || request.method === "DELETE") {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Unknown or missing mcp-session-id." }));
          return;
        }
        await transport.handleRequest(request, response);
        return;
      }

      response.writeHead(405, { "content-type": "application/json", allow: "GET, POST, DELETE" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  const { promise: listening, resolve: onListening, reject: onListenFailed } =
    Promise.withResolvers<void>();
  httpServer.once("error", onListenFailed);
  httpServer.listen(config.httpPort, config.httpHost, () => {
    httpServer.off("error", onListenFailed);
    onListening();
  });
  await listening;

  log(
    `ready on http://${config.httpHost}:${config.httpPort}/mcp — ${registeredTools.length} tools` +
      `${config.readOnly ? " (read-only)" : ""}, ${snapshot.documents.length} documents, ` +
      `project service ${config.projectApiUrl}`
  );

  const shutdown = (): void => {
    for (const transport of sessions.values()) void transport.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  const config = resolveConfig();

  if (argv.includes("--http")) config.transport = "http";
  if (argv.includes("--stdio")) config.transport = "stdio";
  if (argv.includes("--read-only")) config.readOnly = true;

  if (config.transport === "http") await runHttp(config);
  else await runStdio(config);
}

function usage(): string {
  return `${SERVER_NAME} ${SERVER_VERSION}

Model Context Protocol server for the GrapiX Editor: authoring tools plus the
ingested architecture, contracts and capability knowledge of the application.

Usage:
  grapix-editor-mcp [--stdio | --http] [--read-only]

Options:
  --stdio        Serve over stdio (default). The client launches this process.
  --http         Serve streamable HTTP on GRAPIX_MCP_HOST:GRAPIX_MCP_PORT.
  --read-only    Register read tools only; omit every tool that mutates state.
  -h, --help     Show this message.
  -v, --version  Show the version.

Environment:
  GRAPIX_REPOSITORY_ROOT   GrapiX checkout to ingest. Auto-detected from this
                           file's location, then from the working directory.
  GRAPIX_API_URL           Project service base URL (default http://127.0.0.1:4100).
  GRAPIX_API_TOKEN         Bearer token, when the project service requires one.
  GRAPIX_MCP_TRANSPORT     "stdio" (default) or "http".
  GRAPIX_MCP_HOST          HTTP bind host (default 127.0.0.1).
  GRAPIX_MCP_PORT          HTTP port (default 4150).
  GRAPIX_MCP_READ_ONLY     "true" to omit every mutating tool.

This server is the Editor. It cannot cue, take, clear Program or configure an
output — those belong to Playout, and the render engine enforces it by role.
`;
}

/**
 * Whether this module is the process entry point.
 *
 * Compared by **real** path, not by string. npm installs a `bin` as a symlink on macOS and
 * Linux, so `process.argv[1]` is the link (`node_modules/.bin/grapix-editor-mcp`) while
 * `import.meta.url` is the file it points at. A string comparison therefore fails for every
 * globally installed or `npx` run, and the server would start nothing at all — silently, which
 * is the worst way for a CLI to fail.
 */
function isDirectRun(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved (deleted, or a virtual entry) falls back to the literal
    // comparison rather than throwing during start-up.
    return import.meta.url === pathToFileURL(entryPath).href;
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      log(`configuration error: ${error.message}`);
      process.exit(2);
    }
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
}

export { createEditorMcpServer } from "./server.js";
export { resolveConfig } from "./config.js";

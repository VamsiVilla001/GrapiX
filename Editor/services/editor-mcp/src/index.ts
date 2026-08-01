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
import { pathToFileURL } from "node:url";
import { ConfigurationError, resolveConfig, type EditorMcpConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createEditorMcpServer } from "./server.js";

/** stdout belongs to the protocol on stdio; every diagnostic goes to stderr. */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
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
  const { server, knowledge, registeredTools } = createEditorMcpServer(config);
  const snapshot = await knowledge.load();

  const allowedHosts = [
    `${config.httpHost}:${config.httpPort}`,
    `127.0.0.1:${config.httpPort}`,
    `localhost:${config.httpPort}`
  ];

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

    // A fresh transport per request: stateless, and it removes any chance of
    // two concurrent clients colliding on a JSON-RPC request id.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts
    });

    response.on("close", () => {
      void transport.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  log(
    `ready on http://${config.httpHost}:${config.httpPort}/mcp — ${registeredTools.length} tools` +
      `${config.readOnly ? " (read-only)" : ""}, ${snapshot.documents.length} documents, ` +
      `project service ${config.projectApiUrl}`
  );

  const shutdown = (): void => {
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

function isDirectRun(): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
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

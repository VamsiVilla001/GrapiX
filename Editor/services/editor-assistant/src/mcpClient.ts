/**
 * The broker's MCP client: it spawns and owns an editor-mcp server over stdio.
 *
 * This is the "desktop assistant" transport the editor-mcp README recommends — the client
 * launches the process and owns its lifecycle — rather than attaching to the HTTP server on
 * 4150. It is deterministic (no dependency on a separately-running server), passes the
 * project-api URL/token to the child so its authoring tools work, and can enforce read-only by
 * launching the child with `--read-only`, where a mutating tool is not even present.
 *
 * Every authoring action therefore still flows child → project-api (4100), under the same
 * origin allow-list, bearer token, audit log, write lock, backups and revision counter a human
 * author works under (session rule 90). The broker adds no path to `data/` and no Program or
 * output verb — the editor-mcp authority guard (rule 89) forbids one at the source.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AssistantConfig } from "./config.js";
import { asArray, asRecord, asString } from "./providers/json.js";

export type McpConnectionState = "connecting" | "connected" | "error";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** From the tool's `readOnlyHint` annotation; false when unannotated. */
  readOnly: boolean;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpClientEvents {
  onStateChange?: (state: McpConnectionState, detail?: string) => void;
}

/**
 * The subset of the client the agent depends on — tool listing and invocation. Naming it lets
 * the agent be driven by a fake in tests, and keeps the loop decoupled from the transport.
 */
export interface McpToolExecutor {
  listToolInfo(): McpToolInfo[];
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export class EditorMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: McpToolInfo[] = [];
  private state: McpConnectionState = "connecting";
  private detail: string | undefined;

  constructor(
    private readonly config: AssistantConfig,
    private readonly events: McpClientEvents = {}
  ) {}

  getState(): McpConnectionState {
    return this.state;
  }

  getDetail(): string | undefined {
    return this.detail;
  }

  listToolInfo(): McpToolInfo[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  private setState(state: McpConnectionState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.events.onStateChange?.(state, detail);
  }

  /** Connect to a freshly spawned editor-mcp and cache its tool list. Never throws. */
  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") childEnv[key] = value;
      }
      Object.assign(childEnv, this.config.mcp.env);

      this.transport = new StdioClientTransport({
        command: this.config.mcp.command,
        args: this.config.mcp.args,
        env: childEnv,
        stderr: "pipe"
      });
      this.client = new Client({ name: "grapix-editor-assistant", version: "0.1.0" });
      await this.client.connect(this.transport);
      await this.refreshTools();
      this.setState("connected");
    } catch (error) {
      this.setState("error", `editor-mcp did not start: ${(error as Error).message}`);
    }
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;
    const listed = await this.client.listTools();
    this.tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: asRecord(tool.inputSchema) ?? { type: "object" },
      readOnly: tool.annotations?.readOnlyHint === true
    }));
  }

  /** Call a tool and flatten its result into text. Never throws — an error is reported in the result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.client || this.state !== "connected") {
      return { text: "The Editor MCP server is not connected.", isError: true };
    }
    try {
      const result = await this.client.callTool({ name, arguments: args });
      return { text: this.flatten(result), isError: result.isError === true };
    } catch (error) {
      return { text: `Tool '${name}' failed: ${(error as Error).message}`, isError: true };
    }
  }

  /** Flatten an MCP CallToolResult's content array to text the model can read. */
  private flatten(result: unknown): string {
    const record = asRecord(result);
    const content = asArray(record?.content) ?? [];
    const parts: string[] = [];
    for (const item of content) {
      const block = asRecord(item);
      if (asString(block?.type) === "text") {
        const text = asString(block?.text);
        if (text) parts.push(text);
      }
    }
    if (parts.length === 0 && record?.structuredContent !== undefined) {
      return JSON.stringify(record.structuredContent);
    }
    return parts.join("\n");
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // already gone
    }
    this.client = null;
    this.transport = null;
  }
}

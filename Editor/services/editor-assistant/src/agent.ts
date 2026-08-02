/**
 * The agent turn: a bounded model ↔ tool loop.
 *
 * Read tools execute immediately. Mutating tools are **staged** and the turn pauses until the
 * operator applies or skips each one — the agent never auto-applies a mutation. When every
 * pending tool in an assistant turn has a result (a read result, an applied result, or a
 * skipped note), the loop feeds them back to the model and continues, up to a hard iteration
 * cap so a misbehaving model cannot spin forever.
 */

import type { AssistantConfig } from "./config.js";
import type { McpCallResult, McpToolExecutor, McpToolInfo } from "./mcpClient.js";
import type { ModelProvider } from "./providers/index.js";
import type { ChatMessage, ContentBlock, ToolSpec, ToolUseBlock } from "./providers/types.js";
import { isReadTool } from "./toolPolicy.js";

const MAX_ITERATIONS = 8;

export type StagedStatus = "pending" | "applied" | "skipped";

export interface StagedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: StagedStatus;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-executing"; id: string; name: string; input: Record<string, unknown>; read: boolean }
  | { type: "tool-result"; id: string; name: string; text: string; isError: boolean }
  | { type: "staged"; call: StagedCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "done" };

export interface Transcript {
  sessionId: string;
  messages: ChatMessage[];
  tokensUsed: number;
}

/** Per-conversation agent. One instance per session id; the broker holds the map. */
export class Agent {
  readonly id: string;
  private readonly messages: ChatMessage[] = [];
  private tokensUsed = 0;
  private running = false;

  /** Tool_use blocks of the current assistant turn awaiting a result. */
  private pending: ToolUseBlock[] = [];
  private readonly results = new Map<string, { name: string; content: string; isError: boolean }>();
  private readonly staged = new Map<string, StagedCall>();
  private iterations = 0;

  constructor(
    id: string,
    private provider: ModelProvider,
    private readonly mcp: McpToolExecutor,
    private readonly config: AssistantConfig,
    private system: string,
    private readonly emit: (event: AgentEvent) => void
  ) {
    this.id = id;
  }

  setProvider(provider: ModelProvider): void {
    this.provider = provider;
  }

  setSystem(system: string): void {
    this.system = system;
  }

  isRunning(): boolean {
    return this.running;
  }

  transcript(): Transcript {
    return { sessionId: this.id, messages: this.messages, tokensUsed: this.tokensUsed };
  }

  restore(transcript: Transcript): void {
    this.messages.push(...transcript.messages);
    this.tokensUsed = transcript.tokensUsed;
  }

  /** Begin a turn from a user prompt. Streams events; resolves when the turn pauses or ends. */
  async send(userText: string): Promise<void> {
    if (this.running) {
      this.emit({ type: "error", message: "A turn is already in progress." });
      return;
    }
    if (this.tokensUsed >= this.config.sessionTokenBudget) {
      this.emit({
        type: "error",
        message: `Session token budget (${this.config.sessionTokenBudget}) reached. Start a new session.`
      });
      return;
    }
    if (!this.provider.supportsTools) {
      // A model without tool calling can still advise; it just cannot author.
      this.emit({ type: "text", text: "" });
    }

    this.messages.push({ role: "user", content: [{ type: "text", text: userText }] });
    this.iterations = 0;
    this.running = true;
    try {
      await this.runLoop();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Apply a staged mutating tool call: execute it through MCP and record its result. */
  async apply(callId: string): Promise<void> {
    const call = this.staged.get(callId);
    if (!call || call.status !== "pending") return;
    call.status = "applied";
    this.emit({ type: "tool-executing", id: call.id, name: call.name, input: call.input, read: false });
    try {
      const result = await this.mcp.callTool(call.name, call.input);
      this.recordResult(call.id, call.name, result);
      await this.continueIfReady();
    } catch (error) {
      this.recordResult(call.id, call.name, {
        text: `Tool execution failed: ${errorMessage(error)}`,
        isError: true
      });
      try {
        await this.continueIfReady();
      } catch (continueError) {
        this.fail(continueError);
      }
    }
  }

  /** Skip a staged mutating tool call: tell the model it was declined and continue. */
  async skip(callId: string): Promise<void> {
    const call = this.staged.get(callId);
    if (!call || call.status !== "pending") return;
    call.status = "skipped";
    this.recordResult(call.id, call.name, {
      text: "The operator skipped this action; it was not performed. Do not retry it without being asked.",
      isError: false
    });
    try {
      await this.continueIfReady();
    } catch (error) {
      this.fail(error);
    }
  }

  pendingStaged(): StagedCall[] {
    return [...this.staged.values()].filter((call) => call.status === "pending");
  }

  private recordResult(id: string, name: string, result: McpCallResult): void {
    this.results.set(id, { name, content: result.text, isError: result.isError });
    this.emit({ type: "tool-result", id, name, text: result.text, isError: result.isError });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.iterations >= MAX_ITERATIONS) {
        this.emit({ type: "error", message: `Stopped after ${MAX_ITERATIONS} tool iterations.` });
        this.finish();
        return;
      }
      this.iterations += 1;

      const turn = await this.streamAssistantTurn();
      if (turn === "error") {
        this.finish();
        return;
      }

      if (this.pending.length === 0) {
        // No tools requested — the assistant answered.
        this.finish();
        return;
      }

      // Execute reads now; stage mutations. If anything is staged, pause the loop.
      for (const call of this.pending) {
        const tool = this.toolByName(call.name);
        const read = tool ? isReadTool(tool) : false;
        if (read) {
          this.emit({ type: "tool-executing", id: call.id, name: call.name, input: call.input, read: true });
          try {
            const result = await this.mcp.callTool(call.name, call.input);
            this.recordResult(call.id, call.name, result);
          } catch (error) {
            this.recordResult(call.id, call.name, {
              text: `Tool execution failed: ${errorMessage(error)}`,
              isError: true
            });
          }
        } else if (!this.results.has(call.id)) {
          const staged: StagedCall = { id: call.id, name: call.name, input: call.input, status: "pending" };
          this.staged.set(call.id, staged);
          this.emit({ type: "staged", call: staged });
        }
      }

      if (this.pendingStaged().length > 0) {
        // Pause: the turn resumes from apply()/skip() once every mutation is resolved.
        return;
      }

      this.feedResultsBack();
    }
  }

  /** True once every tool_use in the current turn has a recorded result. */
  private allResolved(): boolean {
    return this.pending.every((call) => this.results.has(call.id));
  }

  private async continueIfReady(): Promise<void> {
    if (!this.running || !this.allResolved()) return;
    this.feedResultsBack();
    await this.runLoop();
  }

  /** Turn recorded results into a user message of tool_result blocks and clear the turn's pending set. */
  private feedResultsBack(): void {
    const content: ContentBlock[] = this.pending.map((call) => {
      const result = this.results.get(call.id);
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: result?.content ?? "No result.",
        isError: result?.isError ?? false
      };
    });
    this.messages.push({ role: "user", content });
    this.pending = [];
    this.results.clear();
    this.staged.clear();
  }

  /** Stream one assistant turn, appending its message to history. Returns "error" on failure. */
  private async streamAssistantTurn(): Promise<"ok" | "error"> {
    const tools = this.availableTools();
    let text = "";
    const toolUses: ToolUseBlock[] = [];
    let failed = false;

    try {
      for await (const event of this.provider.chat({ system: this.system, messages: this.messages, tools })) {
        if (event.type === "text") {
          text += event.text;
          this.emit({ type: "text", text: event.text });
        } else if (event.type === "tool_use") {
          toolUses.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        } else if (event.type === "usage") {
          this.tokensUsed += event.inputTokens + event.outputTokens;
          this.emit({ type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens });
        } else if (event.type === "error") {
          this.emit({ type: "error", message: event.message });
          failed = true;
        }
      }
    } catch (error) {
      this.emit({ type: "error", message: `Model request failed: ${errorMessage(error)}` });
      return "error";
    }

    if (failed) return "error";

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...toolUses);
    this.messages.push({ role: "assistant", content });
    this.pending = toolUses;
    return "ok";
  }

  private finish(): void {
    this.running = false;
    this.pending = [];
    this.results.clear();
    this.staged.clear();
    this.emit({ type: "done" });
  }

  private fail(error: unknown): void {
    this.emit({ type: "error", message: `Assistant turn failed: ${errorMessage(error)}` });
    this.finish();
  }

  private availableTools(): ToolSpec[] {
    return this.mcp.listToolInfo().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  private toolByName(name: string): McpToolInfo | undefined {
    return this.mcp.listToolInfo().find((tool) => tool.name === name);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

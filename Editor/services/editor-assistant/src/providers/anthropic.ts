/**
 * Anthropic Messages API adapter.
 *
 * Raw `fetch` against the public HTTP API rather than the vendor SDK, so the broker adds no
 * install-time dependency for a provider a deployment may not even use. Streams SSE and maps
 * Anthropic's block/delta events onto the neutral `ProviderStreamEvent` shape.
 */

import type { ProviderConfig } from "../config.js";
import { asNumber, asRecord, asString, parseRecord } from "./json.js";
import { readSseStream } from "./sseRead.js";
import type {
  ChatMessage,
  ChatRequest,
  ContentBlock,
  ModelProvider,
  ProviderStreamEvent,
  StopReason
} from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function toAnthropicContent(blocks: ContentBlock[]): AnthropicBlock[] {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return {
      type: "tool_result",
      tool_use_id: block.toolUseId,
      content: [{ type: "text", text: block.content }],
      is_error: block.isError ?? false
    };
  });
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: string; content: AnthropicBlock[] }> {
  return messages.map((message) => ({ role: message.role, content: toAnthropicContent(message.content) }));
}

function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

export function createAnthropicProvider(config: ProviderConfig): ModelProvider {
  async function* chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    if (!config.apiKey) {
      yield { type: "error", message: "No Anthropic API key configured (set ANTHROPIC_API_KEY)." };
      return;
    }

    const body = {
      model: config.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      })),
      stream: true
    };

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      yield { type: "error", message: `Anthropic request failed: ${(error as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: `Anthropic ${response.status}: ${text.slice(0, 500)}` };
      return;
    }

    // Assemble streamed tool_use input JSON per content-block index.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: StopReason = "end";

    for await (const sse of readSseStream(response.body, signal)) {
      const payload = parseRecord(sse.data);
      if (!payload) continue;

      switch (sse.event) {
        case "message_start": {
          const usage = asRecord(asRecord(payload.message)?.usage);
          const inputTokens = asNumber(usage?.input_tokens);
          if (inputTokens) yield { type: "usage", inputTokens, outputTokens: 0 };
          break;
        }
        case "content_block_start": {
          const index = asNumber(payload.index) ?? 0;
          const block = asRecord(payload.content_block);
          if (asString(block?.type) === "tool_use") {
            toolBlocks.set(index, {
              id: asString(block?.id) ?? "",
              name: asString(block?.name) ?? "",
              json: ""
            });
          }
          break;
        }
        case "content_block_delta": {
          const index = asNumber(payload.index) ?? 0;
          const delta = asRecord(payload.delta);
          const deltaType = asString(delta?.type);
          if (deltaType === "text_delta") {
            const text = asString(delta?.text);
            if (text) yield { type: "text", text };
          } else if (deltaType === "input_json_delta") {
            const entry = toolBlocks.get(index);
            if (entry) entry.json += asString(delta?.partial_json) ?? "";
          }
          break;
        }
        case "content_block_stop": {
          const index = asNumber(payload.index) ?? 0;
          const entry = toolBlocks.get(index);
          if (entry) {
            const input = entry.json ? (parseRecord(entry.json) ?? {}) : {};
            yield { type: "tool_use", id: entry.id, name: entry.name, input };
            toolBlocks.delete(index);
          }
          break;
        }
        case "message_delta": {
          const outputTokens = asNumber(asRecord(payload.usage)?.output_tokens);
          if (outputTokens) yield { type: "usage", inputTokens: 0, outputTokens };
          stopReason = mapStopReason(asString(asRecord(payload.delta)?.stop_reason));
          break;
        }
        case "error": {
          const message = asString(asRecord(payload.error)?.message) ?? "Anthropic stream error";
          yield { type: "error", message };
          return;
        }
        default:
          break;
      }
    }

    yield { type: "done", stopReason };
  }

  return { id: config.id, label: config.label, model: config.model, supportsTools: config.supportsTools, chat };
}

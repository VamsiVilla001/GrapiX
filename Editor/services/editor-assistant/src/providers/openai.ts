/**
 * OpenAI Chat Completions adapter, shared by the hosted OpenAI provider and any
 * OpenAI-compatible local runtime (Ollama / LM Studio / vLLM), which speak the same API and
 * differ only by base URL and key. Raw `fetch` + SSE, same as the Anthropic adapter.
 */

import type { ProviderConfig } from "../config.js";
import { asArray, asNumber, asRecord, asString, parseRecord } from "./json.js";
import { readSseStream } from "./sseRead.js";
import type {
  ChatMessage,
  ChatRequest,
  ModelProvider,
  ProviderStreamEvent,
  StopReason
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

/** Expand the neutral content-block messages into OpenAI's flat role list. */
function toOpenAiMessages(system: string, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      for (const block of message.content) {
        if (block.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
        }
      }
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    // assistant
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const toolCalls = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) =>
        block.type === "tool_use"
          ? {
              id: block.id,
              type: "function" as const,
              function: { name: block.name, arguments: JSON.stringify(block.input) }
            }
          : null
      )
      .filter((call): call is NonNullable<typeof call> => call !== null);
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    });
  }
  return out;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

export function createOpenAiProvider(config: ProviderConfig): ModelProvider {
  async function* chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    if (!config.apiKey) {
      yield { type: "error", message: `No API key configured for ${config.label}.` };
      return;
    }

    const body = {
      model: config.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toOpenAiMessages(request.system, request.messages),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
      })),
      stream: true,
      stream_options: { include_usage: true }
    };

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      yield { type: "error", message: `${config.label} request failed: ${(error as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: `${config.label} ${response.status}: ${text.slice(0, 500)}` };
      return;
    }

    const pending = new Map<number, PendingToolCall>();
    let stopReason: StopReason = "end";

    for await (const sse of readSseStream(response.body, signal)) {
      if (sse.data === "[DONE]") break;
      const payload = parseRecord(sse.data);
      if (!payload) continue;

      const usage = asRecord(payload.usage);
      if (usage) {
        yield {
          type: "usage",
          inputTokens: asNumber(usage.prompt_tokens) ?? 0,
          outputTokens: asNumber(usage.completion_tokens) ?? 0
        };
      }

      const choice = asRecord(asArray(payload.choices)?.[0]);
      if (!choice) continue;

      const delta = asRecord(choice.delta);
      const text = asString(delta?.content);
      if (text) yield { type: "text", text };

      for (const rawCall of asArray(delta?.tool_calls) ?? []) {
        const call = asRecord(rawCall);
        const index = asNumber(call?.index) ?? 0;
        const fn = asRecord(call?.function);
        const entry = pending.get(index) ?? { id: "", name: "", args: "" };
        entry.id = asString(call?.id) ?? entry.id;
        entry.name = asString(fn?.name) ?? entry.name;
        entry.args += asString(fn?.arguments) ?? "";
        pending.set(index, entry);
      }

      const finish = asString(choice.finish_reason);
      if (finish === "tool_calls") stopReason = "tool_use";
      else if (finish === "length") stopReason = "max_tokens";
      else if (finish === "stop") stopReason = "end";
    }

    if (stopReason === "tool_use") {
      for (const entry of pending.values()) {
        const input = entry.args ? (parseRecord(entry.args) ?? {}) : {};
        yield { type: "tool_use", id: entry.id || `call_${entry.name}`, name: entry.name, input };
      }
    }

    yield { type: "done", stopReason };
  }

  return { id: config.id, label: config.label, model: config.model, supportsTools: config.supportsTools, chat };
}

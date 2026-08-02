/**
 * Google Gemini adapter (`generateContent` streaming).
 *
 * Gemini matches tool results to calls by function *name*, not by an id, so the converter
 * resolves each tool_result's name from the tool_use it answers before projecting onto
 * Gemini's `functionResponse` shape. Raw `fetch` + SSE.
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

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Map every tool_use id to its function name, so a later tool_result can name its call. */
function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const names = toolNamesById(messages);
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const parts: GeminiPart[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text) parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else {
        parts.push({
          functionResponse: {
            name: names.get(block.toolUseId) ?? block.toolUseId,
            response: { result: block.content }
          }
        });
      }
    }
    if (parts.length > 0) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

export function createGoogleProvider(config: ProviderConfig): ModelProvider {
  async function* chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    if (!config.apiKey) {
      yield { type: "error", message: "No Google API key configured (set GOOGLE_API_KEY or GEMINI_API_KEY)." };
      return;
    }

    const body = {
      system_instruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.messages),
      tools: [
        {
          function_declarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }))
        }
      ]
    };

    const url = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      yield { type: "error", message: `Gemini request failed: ${(error as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: `Gemini ${response.status}: ${text.slice(0, 500)}` };
      return;
    }

    let sawToolCall = false;
    let toolCounter = 0;

    for await (const sse of readSseStream(response.body, signal)) {
      const payload = parseRecord(sse.data);
      if (!payload) continue;

      const usage = asRecord(payload.usageMetadata);
      if (usage) {
        yield {
          type: "usage",
          inputTokens: asNumber(usage.promptTokenCount) ?? 0,
          outputTokens: asNumber(usage.candidatesTokenCount) ?? 0
        };
      }

      const candidate = asRecord(asArray(payload.candidates)?.[0]);
      const parts = asArray(asRecord(candidate?.content)?.parts) ?? [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        const text = asString(part?.text);
        if (text) {
          yield { type: "text", text };
          continue;
        }
        const call = asRecord(part?.functionCall);
        const name = asString(call?.name);
        if (name) {
          sawToolCall = true;
          yield { type: "tool_use", id: `call_${name}_${toolCounter++}`, name, input: asRecord(call?.args) ?? {} };
        }
      }
    }

    const stopReason: StopReason = sawToolCall ? "tool_use" : "end";
    yield { type: "done", stopReason };
  }

  return { id: config.id, label: config.label, model: config.model, supportsTools: config.supportsTools, chat };
}

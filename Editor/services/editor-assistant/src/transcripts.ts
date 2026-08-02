/**
 * Transcript persistence.
 *
 * A session's message history is saved per project under the runtime data dir so a reopened
 * Editor can resume a conversation. Runtime state, gitignored — never source, and never a
 * scene document. Best-effort: a save or load failure degrades to an ephemeral session rather
 * than taking the broker down.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Transcript } from "./agent.js";
import { asArray, asNumber, asRecord, asString } from "./providers/json.js";
import type { ChatMessage, ContentBlock } from "./providers/types.js";

export class TranscriptStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly dataDir: string) {}

  private async ensureDir(): Promise<void> {
    if (!this.ready) this.ready = mkdir(this.dataDir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  private file(sessionId: string): string {
    // Session ids are broker-generated hex; keep only safe characters as defence in depth.
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(this.dataDir, `session-${safe}.json`);
  }

  async save(transcript: Transcript): Promise<void> {
    try {
      await this.ensureDir();
      await writeFile(this.file(transcript.sessionId), JSON.stringify(transcript), "utf8");
    } catch {
      // ephemeral fallback
    }
  }

  async load(sessionId: string): Promise<Transcript | null> {
    try {
      const raw = await readFile(this.file(sessionId), "utf8");
      const record = asRecord(JSON.parse(raw));
      if (!record) return null;
      const messages = asArray(record.messages) ?? [];
      return {
        sessionId,
        tokensUsed: asNumber(record.tokensUsed) ?? 0,
        messages: messages
          .map((raw): ChatMessage | null => coerceMessage(raw))
          .filter((message): message is ChatMessage => message !== null)
      };
    } catch {
      return null;
    }
  }
}

/** Validate a persisted message back into the neutral shape; drop anything malformed. */
function coerceMessage(raw: unknown): ChatMessage | null {
  const record = asRecord(raw);
  const role = asString(record?.role);
  if (role !== "user" && role !== "assistant") return null;
  const content = (asArray(record?.content) ?? [])
    .map((raw): ContentBlock | null => coerceBlock(raw))
    .filter((block): block is ContentBlock => block !== null);
  return { role, content };
}

function coerceBlock(raw: unknown): ContentBlock | null {
  const record = asRecord(raw);
  const type = asString(record?.type);
  if (type === "text") {
    return { type: "text", text: asString(record?.text) ?? "" };
  }
  if (type === "tool_use") {
    return {
      type: "tool_use",
      id: asString(record?.id) ?? "",
      name: asString(record?.name) ?? "",
      input: asRecord(record?.input) ?? {}
    };
  }
  if (type === "tool_result") {
    return {
      type: "tool_result",
      toolUseId: asString(record?.toolUseId) ?? "",
      content: asString(record?.content) ?? "",
      isError: record?.isError === true
    };
  }
  return null;
}

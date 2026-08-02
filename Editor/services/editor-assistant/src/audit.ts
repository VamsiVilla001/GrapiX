/**
 * Append-only audit of the mutations the assistant applied.
 *
 * A model's edits must be attributable, not anonymous. The authoring itself is already audited
 * by project-api (the MCP child calls it under the operator's token); this is the broker's own
 * record, tagged with the model that proposed each change, so "what did the assistant do" is
 * answerable without cross-referencing two logs. One JSON object per line, under the runtime
 * data dir (gitignored).
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
  at: string;
  actor: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}

export class AssistantAudit {
  private ready: Promise<void> | null = null;

  constructor(private readonly dataDir: string) {}

  private async ensureDir(): Promise<void> {
    if (!this.ready) this.ready = mkdir(this.dataDir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.ensureDir();
      await appendFile(path.join(this.dataDir, "audit.log"), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Auditing must never take the turn down; a failed append is logged by the caller at most.
    }
  }
}

/**
 * The audit record: who did what, from where, and what happened.
 *
 * Two sinks, because they answer different questions and have different retention needs:
 *
 * - `audit.jsonl`  - security. Logins, refusals, permission failures, settings changes. Read
 *                    when answering "who was allowed to do that, and who tried".
 * - `events.jsonl` - operations. Scene loads, patches, cues, takes, uploads. Read when
 *                    reconstructing a show: what reached air, in what order, from whose hand.
 *
 * A record is append-only and self-contained. It never carries a password, a token, or a
 * payload body - see `REDACTED_KEYS` and `sanitiseDetail`.
 */

export type AuditSink = "audit" | "events";

export type AuditResult = "success" | "failure" | "denied";

/**
 * Every action worth reconstructing later.
 *
 * Kept as a closed union rather than a free string so a typo cannot invent an action that
 * nothing queries for.
 */
export type AuditAction =
  // Identity
  | "auth.login"
  | "auth.logout"
  | "auth.login-failed"
  | "auth.refresh"
  | "auth.permission-denied"
  // Engine link
  | "engine.connect"
  | "engine.disconnect"
  // Authoring
  | "scene.load"
  | "scene.edit"
  | "scene.patch"
  | "scene.publish"
  | "asset.upload"
  // Operations
  | "playout.cue"
  | "playout.take-online"
  | "playout.take-offline"
  | "ae-runtime.control-write"
  | "ae-runtime.control-refused"
  | "ae-runtime.revision-applied"
  | "ae-runtime.revision-refused"
  | "ae-package.ingest"
  | "ae-package.load"
  // Administration
  | "settings.change"
  | "user.change";

/** Which sink an action belongs in. Exhaustive, so a new action must choose deliberately. */
export const SINK_FOR_ACTION: Readonly<Record<AuditAction, AuditSink>> = {
  "auth.login": "audit",
  "auth.logout": "audit",
  "auth.login-failed": "audit",
  "auth.refresh": "audit",
  "auth.permission-denied": "audit",
  "engine.connect": "events",
  "engine.disconnect": "events",
  "scene.load": "events",
  "scene.edit": "events",
  "scene.patch": "events",
  "scene.publish": "events",
  "asset.upload": "events",
  "playout.cue": "events",
  "playout.take-online": "events",
  "playout.take-offline": "events",
  "ae-runtime.control-write": "events",
  "ae-runtime.control-refused": "audit",
  "ae-runtime.revision-applied": "events",
  "ae-runtime.revision-refused": "audit",
  "ae-package.ingest": "events",
  "ae-package.load": "events",
  "settings.change": "audit",
  "user.change": "audit"
};

/**
 * One line of the log.
 *
 * `sequence` is monotonic per sink and survives restart, so a gap is evidence of a deleted or
 * truncated line rather than of a quiet process death.
 */
export interface AuditRecord {
  /** ISO-8601 with milliseconds, UTC. */
  timestamp: string;
  sequence: number;
  action: AuditAction;
  result: AuditResult;
  /** Null for an anonymous action - a failed login names an attempt, not a user. */
  userId: string | null;
  username: string | null;
  role: string | null;
  sessionId: string | null;
  /** The host the actor was using, as reported by the client. Advisory, never authority. */
  deviceName: string | null;
  ipAddress: string | null;
  /** Engine connection id, when the action crossed the engine link. */
  connectionId: string | null;
  sceneId: string | null;
  revision: number | null;
  /** Present only when `result` is not "success". */
  error: { code: string; message: string } | null;
  /** Small, scalar-only extras. Anything large or secret is stripped before it lands here. */
  detail?: Record<string, string | number | boolean | null>;
}

/** Fields whose *value* is never written, whatever the key path. */
export const REDACTED_KEYS: readonly string[] = [
  "password",
  "newpassword",
  "currentpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "authorization",
  "secret",
  "signingsecret",
  "apitoken",
  "passwordhash",
  "cookie",
  "setcookie"
] as const;

const MAX_DETAIL_ENTRIES = 24;
const MAX_STRING_LENGTH = 256;

/**
 * Reduce arbitrary detail to something safe and small.
 *
 * Three rules, in order: a redacted key never yields its value; a non-scalar is described
 * rather than serialised, so a scene document or an image buffer can never be inlined; a long
 * string is truncated. The result is always safe to append to a file that ships to support.
 */
export function sanitiseDetail(input: unknown): Record<string, string | number | boolean | null> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  let count = 0;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_DETAIL_ENTRIES) break;
    if (REDACTED_KEYS.includes(key.toLowerCase().replace(/[-_]/g, ""))) {
      output[key] = "[redacted]";
      count += 1;
      continue;
    }
    if (value === null) {
      output[key] = null;
    } else if (typeof value === "boolean" || typeof value === "number") {
      output[key] = Number.isFinite(value as number) || typeof value === "boolean" ? (value as number | boolean) : null;
    } else if (typeof value === "string") {
      output[key] = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      // Never the bytes. The size is the only useful thing and the only safe thing.
      const bytes = value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
      output[key] = `[binary ${bytes} bytes]`;
    } else if (Array.isArray(value)) {
      output[key] = `[array ${value.length}]`;
    } else {
      output[key] = "[object]";
    }
    count += 1;
  }

  return count > 0 ? output : undefined;
}

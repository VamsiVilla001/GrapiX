/**
 * Render engine protocol v3 — the envelope.
 *
 * Protocol v2 got the important things right: a version, a request id, a strictly
 * increasing per-connection sequence, a timestamp, explicit nullability, and revision
 * gating. v3 keeps all
 * of that and adds the four things a *remote, multi-engine* deployment cannot
 * work without:
 *
 *   messageId    so a retransmit can be recognised and discarded
 *   engineId     so a client talking to several engines can route
 *   projectId    so permissions can be scoped to a project
 *   requiresAck  stated rather than inferred from the message type
 */

import type { SceneRef } from "./messages.js";
export const ENGINE_PROTOCOL_VERSION = 3 as const;
export type EngineProtocolVersion = typeof ENGINE_PROTOCOL_VERSION;

/** Client-to-engine message types, grouped as the requirements specify. */
export const CONNECTION_MESSAGE_TYPES = [
  "connection.hello",
  "connection.authenticate",
  "connection.heartbeat",
  "connection.capabilities",
  "connection.disconnect"
] as const;

export const SCENE_MESSAGE_TYPES = [
  "scene.load",
  "scene.unload",
  "scene.fullSync",
  "scene.applyPatch",
  "scene.validate",
  "scene.prepare"
] as const;

export const ASSET_MESSAGE_TYPES = [
  "asset.register",
  "asset.upload",
  "asset.validate",
  "asset.preload",
  "asset.release"
] as const;

export const PLAYOUT_MESSAGE_TYPES = [
  "playout.cue",
  "playout.takeOnline",
  "playout.takeOffline",
  "playout.continue",
  "playout.update",
  "playout.stop",
  "playout.clear",
  "playout.replace",
  "playout.transition"
] as const;

export const PREVIEW_MESSAGE_TYPES = [
  "preview.request",
  "preview.streamStart",
  "preview.streamStop",
  "preview.setViewport"
] as const;

/** Private native authoring view. Only a credential-derived Editor principal may use it. */
export const EDITOR_VIEW_MESSAGE_TYPES = ["editor.view.request", "editor.view.close"] as const;

export const ENGINE_CONTROL_MESSAGE_TYPES = [
  "engine.getStatus",
  "engine.getDiagnostics",
  "engine.getCapabilities",
  "engine.setConfiguration",
  "engine.restartRenderer"
] as const;

/** Stage is not in the original six groups but a stage must reach the engine. */
export const STAGE_MESSAGE_TYPES = ["stage.load", "stage.unload"] as const;

/**
 * Output configuration.
 *
 * Separate from the engine group because outputs are what put pixels on air, and an
 * audit log that cannot distinguish "read the status" from "start transmitting"
 * is not much of an audit log.
 */
export const OUTPUT_MESSAGE_TYPES = [
  "output.list",
  "output.configure",
  "output.start",
  "output.stop",
  "output.remove"
] as const;

export const ENGINE_REQUEST_TYPES = [
  ...CONNECTION_MESSAGE_TYPES,
  ...SCENE_MESSAGE_TYPES,
  ...STAGE_MESSAGE_TYPES,
  ...ASSET_MESSAGE_TYPES,
  ...PLAYOUT_MESSAGE_TYPES,
  ...PREVIEW_MESSAGE_TYPES,
  ...EDITOR_VIEW_MESSAGE_TYPES,
  ...ENGINE_CONTROL_MESSAGE_TYPES,
  ...OUTPUT_MESSAGE_TYPES
] as const;

export type EngineRequestType = (typeof ENGINE_REQUEST_TYPES)[number];

/** Engine-to-client message types. */
export const ENGINE_REPLY_TYPES = [
  "reply.ack",
  "reply.error",
  "reply.hello",
  "reply.capabilities",
  "reply.status",
  "reply.diagnostics",
  "reply.sceneValidation",
  "reply.scenePrepared",
  "reply.assetProgress",
  "reply.preview",
  "reply.editorView",
  "reply.outputs"
] as const;

export type EngineReplyType = (typeof ENGINE_REPLY_TYPES)[number];

export const ENGINE_EVENT_TYPES = [
  "event.engineState",
  "event.sceneLifecycle",
  "event.channelChanged",
  "event.outputHealth",
  "event.previewFrame",
  "event.transitionProgress",
  "event.warning",
  "event.error",
  "event.deviceLost",
  "event.resyncRequired"
] as const;

export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

export type EngineMessageType = EngineRequestType | EngineReplyType | EngineEventType;

export const ENGINE_MESSAGE_TYPES: readonly EngineMessageType[] = [
  ...ENGINE_REQUEST_TYPES,
  ...ENGINE_REPLY_TYPES,
  ...ENGINE_EVENT_TYPES
];

const MESSAGE_TYPE_SET = new Set<string>(ENGINE_MESSAGE_TYPES);
const REQUEST_TYPE_SET = new Set<string>(ENGINE_REQUEST_TYPES);
const REPLY_TYPE_SET = new Set<string>(ENGINE_REPLY_TYPES);
const EVENT_TYPE_SET = new Set<string>(ENGINE_EVENT_TYPES);

export function isEngineMessageType(value: unknown): value is EngineMessageType {
  return typeof value === "string" && MESSAGE_TYPE_SET.has(value);
}

export function isEngineRequestType(value: unknown): value is EngineRequestType {
  return typeof value === "string" && REQUEST_TYPE_SET.has(value);
}

export function isEngineReplyType(value: unknown): value is EngineReplyType {
  return typeof value === "string" && REPLY_TYPE_SET.has(value);
}

export function isEngineEventType(value: unknown): value is EngineEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

export type EngineMessageDirection = "client-to-engine" | "engine-to-client";

export interface EngineEnvelope {
  protocolVersion: EngineProtocolVersion;
  /** Unique per message. Retransmits reuse it; new messages never do. */
  messageId: string;
  /** Correlates a reply to its request. Null on unsolicited events. */
  requestId: string | null;
  /** Which engine this concerns. Null before the engine has identified itself. */
  engineId: string | null;
  /** Canonical scene address. Null only for connection-level messages. */
  sceneRef: SceneRef | null;
  timestampMs: number;
  type: EngineMessageType;
  /** Whether the sender expects an explicit acknowledgement. */
  requiresAck: boolean;
  /** Strictly increasing per connection, per direction. */
  sequence: number;
  direction: EngineMessageDirection;
}

export type EngineMessage<TPayload = unknown> = EngineEnvelope & { payload: TPayload };

/**
 * Message types that mutate engine state and therefore need acknowledging.
 *
 * Queries are excluded because their reply *is* the acknowledgement; sending both
 * would double the traffic for no added certainty.
 */
const ACK_REQUIRED_TYPES = new Set<string>([
  "connection.authenticate",
  "scene.load",
  "scene.unload",
  "scene.fullSync",
  "scene.applyPatch",
  "scene.prepare",
  "stage.load",
  "stage.unload",
  "asset.register",
  "asset.upload",
  "asset.preload",
  "asset.release",
  "playout.cue",
  "playout.takeOnline",
  "playout.takeOffline",
  "playout.continue",
  "playout.update",
  "playout.stop",
  "playout.clear",
  "playout.replace",
  "playout.transition",
  "preview.streamStart",
  "preview.streamStop",
  "preview.setViewport",
  "engine.setConfiguration",
  "engine.restartRenderer",
  "output.configure",
  "output.start",
  "output.stop",
  "output.remove",
  "editor.view.request",
  "editor.view.close"
]);

export function messageRequiresAck(type: EngineMessageType): boolean {
  return ACK_REQUIRED_TYPES.has(type);
}

export interface CreateEnvelopeOptions {
  messageId: string;
  sequence: number;
  timestampMs: number;
  direction?: EngineMessageDirection;
  requestId?: string | null;
  engineId?: string | null;
  sceneRef?: SceneRef | null;
  requiresAck?: boolean;
}

/**
 * Build a message.
 *
 * Throws on malformed identity rather than sending something the receiver will
 * reject: a client that cannot produce a valid message id or sequence is broken,
 * and finding out locally is cheaper than a round trip.
 */
export function createEngineMessage<TPayload>(
  type: EngineMessageType,
  payload: TPayload,
  options: CreateEnvelopeOptions
): EngineMessage<TPayload> {
  if (!isEngineMessageType(type)) {
    throw new Error(`unknown engine message type: ${String(type)}`);
  }
  if (typeof options.messageId !== "string" || options.messageId.trim() === "") {
    throw new Error("engine messageId must be a non-empty string");
  }
  if (!Number.isSafeInteger(options.sequence) || options.sequence <= 0) {
    throw new Error("engine sequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.timestampMs) || options.timestampMs < 0) {
    throw new Error("engine timestampMs must be a non-negative safe integer");
  }

  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    messageId: options.messageId,
    requestId: options.requestId ?? null,
    engineId: options.engineId ?? null,
    sceneRef: options.sceneRef ?? null,
    timestampMs: options.timestampMs,
    type,
    requiresAck: options.requiresAck ?? messageRequiresAck(type),
    sequence: options.sequence,
    direction: options.direction ?? (isEngineRequestType(type) ? "client-to-engine" : "engine-to-client"),
    payload
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ENGINE_ERROR_CODES = [
  "INVALID_JSON",
  "PROTOCOL_VERSION_MISMATCH",
  "INVALID_ENVELOPE",
  "INVALID_PAYLOAD",
  "UNSUPPORTED_MESSAGE",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "PROJECT_NOT_PERMITTED",
  "DUPLICATE_MESSAGE",
  "STALE_SEQUENCE",
  "SEQUENCE_GAP",
  "REVISION_MISMATCH",
  "RESYNC_REQUIRED",
  "SCENE_NOT_FOUND",
  "SCENE_NOT_PREPARED",
  "STAGE_NOT_FOUND",
  "STAGE_UNSUPPORTED",
  "ASSET_NOT_FOUND",
  "ASSET_REJECTED",
  "PATH_NOT_PERMITTED",
  "MESSAGE_TOO_LARGE",
  "UPLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "PREVIEW_TOO_LARGE",
  "CAPABILITY_UNSUPPORTED",
  "OUTPUT_ERROR",
  "DEVICE_LOST",
  "ENGINE_BUSY",
  "INTERNAL_ERROR"
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export interface EngineErrorPayload {
  code: EngineErrorCode | string;
  message: string;
  /** True when the client may retry the same message unchanged. */
  retryable: boolean;
  /** True when the client must issue a `scene.fullSync` before continuing. */
  requiresFullSync?: boolean;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation and codec
// ---------------------------------------------------------------------------

export interface EnvelopeValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Structural validation of an arriving envelope.
 *
 * "field explicitly null" must not be the same thing, because a missing
 * `sceneRef` is a bug while a null one is legitimate for connection messages.
 */
export function validateEnvelope(value: unknown): EnvelopeValidation {
  const errors: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["message must be a JSON object"] };
  }

  const record = value as Record<string, unknown>;

  if (record.protocolVersion !== ENGINE_PROTOCOL_VERSION) {
    errors.push(
      `protocolVersion must be ${ENGINE_PROTOCOL_VERSION}, received ${String(record.protocolVersion)}`
    );
  }
  if (typeof record.messageId !== "string" || record.messageId.trim() === "") {
    errors.push("messageId must be a non-empty string");
  }
  if (!isEngineMessageType(record.type)) {
    errors.push(`unknown message type ${String(record.type)}`);
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) <= 0) {
    errors.push("sequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(record.timestampMs) || (record.timestampMs as number) < 0) {
    errors.push("timestampMs must be a non-negative safe integer");
  }
  if (typeof record.requiresAck !== "boolean") {
    errors.push("requiresAck must be a boolean");
  }
  if (record.direction !== "client-to-engine" && record.direction !== "engine-to-client") {
    errors.push("direction must be client-to-engine or engine-to-client");
  }
  if (!("payload" in record)) {
    errors.push("payload is required, even when empty");
  }

  for (const field of ["requestId", "engineId"] as const) {
    const candidate = record[field];
    if (candidate !== null && typeof candidate !== "string") {
      errors.push(`${field} must be a string or explicitly null`);
    }
  }

  const sceneRef = record.sceneRef;
  if (sceneRef !== null) {
    if (typeof sceneRef !== "object" || Array.isArray(sceneRef)) {
      errors.push("sceneRef must be an object or explicitly null");
    } else {
      const ref = sceneRef as Record<string, unknown>;
      if (typeof ref.projectId !== "string" || ref.projectId.trim() === "") {
        errors.push("sceneRef.projectId must be a non-empty string");
      }
      if (ref.domain !== "authoring" && ref.domain !== "published") {
        errors.push("sceneRef.domain must be authoring or published");
      }
      if (typeof ref.sceneId !== "string" || ref.sceneId.trim() === "") {
        errors.push("sceneRef.sceneId must be a non-empty string");
      }
      if (!Number.isSafeInteger(ref.revision) || (ref.revision as number) < 0) {
        errors.push("sceneRef.revision must be a non-negative safe integer");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function encodeEngineMessage(message: EngineMessage<unknown>): string {
  return JSON.stringify(message);
}

export type DecodeResult<TPayload = unknown> =
  | { ok: true; message: EngineMessage<TPayload> }
  | { ok: false; code: EngineErrorCode; errors: string[] };

/**
 * Decode and validate a frame.
 *
 * `maxBytes` is enforced here rather than at the transport so every transport
 * inherits the same limit. An unbounded frame from a remote client is a denial
 * of service against a live renderer.
 */
export function decodeEngineMessage<TPayload = unknown>(
  raw: string,
  options: { maxBytes?: number } = {}
): DecodeResult<TPayload> {
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && raw.length > maxBytes) {
    return {
      ok: false,
      code: "MESSAGE_TOO_LARGE",
      errors: [`message is ${raw.length} bytes; limit is ${maxBytes}`]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      errors: [error instanceof Error ? error.message : "unparseable JSON"]
    };
  }

  const validation = validateEnvelope(parsed);
  if (!validation.valid) {
    const versionMismatch = validation.errors.some((entry) =>
      entry.startsWith("protocolVersion")
    );
    return {
      ok: false,
      code: versionMismatch ? "PROTOCOL_VERSION_MISMATCH" : "INVALID_ENVELOPE",
      errors: validation.errors
    };
  }

  return { ok: true, message: parsed as EngineMessage<TPayload> };
}

/** Which group a message belongs to. Used for rate limiting and audit logs. */
export type EngineMessageGroup =
  | "connection"
  | "scene"
  | "stage"
  | "asset"
  | "playout"
  | "preview"
  | "engine"
  | "output"
  | "reply"
  | "event";

export function messageGroup(type: EngineMessageType): EngineMessageGroup {
  const prefix = type.split(".")[0];
  switch (prefix) {
    case "connection":
      return "connection";
    case "scene":
      return "scene";
    case "stage":
      return "stage";
    case "asset":
      return "asset";
    case "playout":
      return "playout";
    case "preview":
      return "preview";
    case "engine":
      return "engine";
    case "output":
      return "output";
    case "reply":
      return "reply";
    default:
      return "event";
  }
}

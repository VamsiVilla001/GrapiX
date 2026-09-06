/** Versioned local protocol between Playout and the resident After Effects adapter. */
export const AE_RUNTIME_PROTOCOL_MAJOR = 2 as const;
export const AE_RUNTIME_PROTOCOL_MINOR = 0 as const;
export const AE_RUNTIME_MAX_FRAME_BYTES = 256 * 1024;

export const AE_RUNTIME_CAPABILITIES = [
  "project.discovery",
  "property.read",
  "property.write",
  "time.rational",
  "render.readiness",
  "data.revision"
] as const;

export type AeRuntimeCapability = (typeof AE_RUNTIME_CAPABILITIES)[number];
export type AeRuntimeSurface = "aegp-sdk" | "controlled-dom";

export interface AeRuntimeFingerprint {
  aeVersion: string;
  adapterVersion: string;
  adapterSha256: string;
  pluginSetSha256: string;
  suiteVersions: Record<string, number>;
  /**
   * Non-null when the adapter was launched with a fault deliberately armed, e.g.
   * `"revision-write@1"` from `GRAPIX_AE_RUNTIME_FAULT_INJECT_REVISION_WRITE`.
   *
   * Injection is the only route to a *live* rollback measurement: `AE-CD2`'s phase 2 is thorough
   * enough that no validated member on the pinned fixture can fail its write, so the recovery path
   * cannot otherwise be reached against real After Effects state. That makes it useful and dangerous
   * in the same breath, which is why it travels here — a supervisor sees it on connect, and a
   * certification runner **must refuse to record evidence** from an adapter that was told to fail.
   * Optional so an older adapter that predates the field is read as "did not say" rather than
   * silently as "clean"; treat a missing value as unknown, never as null.
   */
  faultInjection?: string | null;
}

export interface AeRuntimeHello {
  kind: "hello";
  protocolMajor: number;
  protocolMinor: number;
  sessionId: string;
  token: string;
  capabilities: AeRuntimeCapability[];
}

export interface AeRuntimeHelloAck {
  kind: "hello-ack";
  protocolMajor: typeof AE_RUNTIME_PROTOCOL_MAJOR;
  protocolMinor: number;
  sessionId: string;
  capabilities: AeRuntimeCapability[];
  fingerprint: AeRuntimeFingerprint;
  hostPid: number;
}
/** HEALTH proves both adapter liveness and the project the licensed host actually has open. */
export interface AeRuntimeHealthResult {
  resident: true;
  driverMajor: number;
  driverMinor: number;
  pluginId: number;
  /** Absolute path reported by `AEGP_GetProjectPath`, or null while no saved project is open. */
  projectPath: string | null;
}

export interface AeRuntimeProjectItemDescriptor {
  itemId: number;
  parentItemId: number | null;
  itemType: "folder" | "composition" | "footage" | "solid" | "unknown";
  displayName: string;
}

export interface AeRuntimeCompositionDescriptor {
  itemId: number;
  displayName: string;
  width: number;
  height: number;
  duration: AeRationalTime;
  /**
   * The composition's nominal rate as After Effects reports it from `AEGP_GetCompFramerate`.
   *
   * This is an `A_FpLong` at the source and is **diagnostic only**. It cannot be trusted to separate
   * `2997/100` from `30000/1001`, and conflating those two is what quantised a declared cue onto a
   * neighbouring frame. Reconcile against `clock`, never against this.
   */
  frameRate: string;
  /**
   * The composition's own clock as an exact rational, from `AEGP_GetCompFrameDuration`: the frame
   * duration in the composition's own time scale, which is the unit every `SET_TIME` must be stated
   * in. Optional because a composition can report no usable frame duration, and an absent clock is
   * refused upstream rather than replaced with a fabricated one.
   */
  clock?: { frameDuration: string; timeScale: string };
}

export interface AeRuntimeLayerDescriptor {
  compositionItemId: number;
  layerId: number;
  sourceItemId: number | null;
  index: number;
  displayName: string;
}

export interface AeRuntimePropertySegment {
  matchName: string;
  /** Zero-based occurrence among siblings with the same match name. */
  ordinal: number;
}

export interface AeRuntimePropertyTarget {
  compositionItemId: number;
  layerId: number;
  sourceItemId: number | null;
  path: AeRuntimePropertySegment[];
}

export interface AeRuntimePropertyMetadata {
  target: AeRuntimePropertyTarget;
  displayName: string;
  valueType: "text" | "number" | "boolean" | "color" | "point2d" | "point3d" | "enum" | "image";
  writable: boolean;
  readOnlyReason: string | null;
  timeVarying: boolean;
  expressionEnabled: boolean;
  surface: AeRuntimeSurface;
  /** Diagnosis only. Never used to resolve or rebind a target. */
  structuralFingerprint: string;
}

/**
 * One member of an atomic data revision.
 *
 * The adapter reads every member, proves every one writable, captures every prior value, and only
 * then writes any of them. A member is never applied on its own.
 */
export interface AeRuntimeRevisionMember {
  target: AeRuntimePropertyTarget;
  value: unknown;
}

export interface AeRuntimeRevisionRequest {
  /** The revision this batch becomes once accepted. Monotonic, never reused. */
  revision: number;
  members: AeRuntimeRevisionMember[];
}

/** A property value in its own declared type, exactly as the adapter reads it back. */
export interface AeRuntimePropertyValue {
  value: string | number;
  valueType: AeRuntimePropertyMetadata["valueType"];
}

export interface AeRuntimeRevisionMemberResult {
  target: AeRuntimePropertyTarget;
  /**
   * The value held before this revision and the value AE reports now.
   *
   * Both are read back through the same path, so a text or colour member is described in its own type
   * rather than coerced into a number the way a single `previousValue: unknown` invited.
   */
  previous: AeRuntimePropertyValue;
  current: AeRuntimePropertyValue;
}

export interface AeRuntimeRevisionResult {
  revision: number;
  applied: AeRuntimeRevisionMemberResult[];
  /**
   * True when a mid-batch failure forced every already-written member back to its prior value.
   * A rolled-back revision is a failure: it never advances the accepted revision.
   */
  rolledBack: boolean;
}

export interface AeRationalTime {
  value: string;
  scale: string;
}

/**
 * Client-to-adapter requests. Every one carries a `requestId` and is answered by exactly one result.
 *
 * `RENDER_READY` and `RENDER_FAILED` are deliberately **absent**: a render completion travels the other
 * way. They were previously declared here *and* in `AeRuntimeEvent`, which is how the same name came to
 * mean two incompatible things — a client asking After Effects whether a render is ready, and the
 * adapter reporting that it is. Only the second is meaningful, so they are events alone.
 *
 * Project lifecycle is also deliberately absent. After Effects 26.3 proved that
 * `AEGP_OpenProjectFromPath` can return success and then wedge the adapter's idle callback forever.
 * The Playout supervisor therefore changes projects only by terminating its owned host and launching
 * a fresh process with the target `.aep`.
 */
export type AeRuntimeOperation =
  | "HEALTH"
  | "SHUTDOWN"
  | "LIST_PROJECT_ITEMS"
  | "LIST_COMPOSITIONS"
  | "LIST_LAYERS"
  | "LIST_PROPERTIES"
  | "READ_PROPERTY"
  | "SET_PROPERTY"
  | "READ_PROPERTY_METADATA"
  | "FIXTURE_IDENTITY"
  | "LIST_EFFECTS"
  | "SET_TIME"
  | "RENDER_FRAME"
  | "APPLY_DATA_REVISION";


/**
 * Ask After Effects to evaluate one frame and publish it into the `AE-F1` ring.
 *
 * This is the request that `RENDER_READY`/`RENDER_FAILED` answer. Until it existed those events had no
 * cause on the protocol at all: the only way to make After Effects render was the adapter's legacy file
 * command channel, which carries one command at a time and so could never be pipelined — `AE-F3`
 * measured that path at ~21 frames per second.
 *
 * No pixels travel here either. The reply describes the frame and the ring publish; the bytes reach the
 * engine through the shared mapping, and the payload file the `checkout` verb writes for `AE-F0`
 * comparison evidence is deliberately **not** written on this path.
 */
export interface AeRenderFrameRequest {
  /** Stable composition item id, as `LIST_COMPOSITIONS` reports it. */
  compositionItemId: number;
  /**
   * The instant to evaluate, in the composition's own scale.
   *
   * Refused as `TIME_NOT_REPRESENTABLE` when it is not a whole number of this composition's frames.
   * `PL1`'s rule: a declared rate and a composition's scale are two clocks until proven equal, and an
   * instant between frames is a request no render can honour honestly.
   */
  time: AeRationalTime;
  /** The revision in force. Echoed on the descriptor so ingress can refuse a stale render. */
  dataRevision: number;
  /** Correlates the reply and the resulting event with the request that caused them. */
  renderRequestId: string;
  /** Ring frame identity, and the Program frame number ingress matches against. */
  frameId: number;
  /** Absolute presentation deadline in nanoseconds, decimal string because it is a u64 at the source. */
  presentationDeadlineNanos: string;
}

/** What the adapter reports about one evaluated frame. Geometry is observed, never requested. */
export interface AeRenderFrameResult {
  composition: string;
  frame: number;
  width: number;
  height: number;
  stride: number;
  worldType: string;
  renderMs: number;
  onHookThread: boolean;
  /** `published`, `backpressure`, `refused` or `not-requested`. */
  ringPublish: { outcome: string; slotIndex?: number; ringGeneration?: string; code?: string; message?: string };
}

export interface AeRuntimeRequest<TPayload = unknown> {
  kind: "request";
  protocolMajor: typeof AE_RUNTIME_PROTOCOL_MAJOR;
  protocolMinor: number;
  sessionId: string;
  requestId: string;
  sequence: number;
  idempotencyKey: string;
  deadlineUnixMs: number;
  expectedProjectDigest: string | null;
  operation: AeRuntimeOperation;
  payload: TPayload;
}

export type AeRuntimeErrorCode =
  | "AUTH_FAILED"
  | "PROTOCOL_INCOMPATIBLE"
  | "CAPABILITY_MISSING"
  | "FRAME_TOO_LARGE"
  | "MALFORMED_FRAME"
  | "DUPLICATE_REQUEST"
  | "DEADLINE_EXPIRED"
  | "PROJECT_DIGEST_MISMATCH"
  | "OPERATION_UNSUPPORTED"
  | "INVALID_PAYLOAD"
  | "TARGET_NOT_FOUND"
  | "PROPERTY_READ_ONLY"
  /** A revision failed part-way and every already-applied member was restored. */
  | "REVISION_ROLLED_BACK"
  /**
   * A revision failed part-way and at least one member could not be restored; After Effects holds a
   * mixed state, so retrying is unsafe until a human has inspected the project.
   */
  | "REVISION_ROLLBACK_FAILED"
  /** The composition's own time scale cannot represent the requested instant exactly. */
  | "TIME_NOT_REPRESENTABLE"
  | "RUNTIME_UNAVAILABLE"
  | "AE_ERROR";

export interface AeRuntimeFailure {
  code: AeRuntimeErrorCode;
  message: string;
  retryable: boolean;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AeRuntimeResult<TResult = unknown> {
  kind: "result";
  protocolMajor: typeof AE_RUNTIME_PROTOCOL_MAJOR;
  protocolMinor: number;
  sessionId: string;
  requestId: string;
  sequence: number;
  operation: AeRuntimeOperation;
  ok: boolean;
  surface: AeRuntimeSurface | null;
  projectDigest: string | null;
  time: AeRationalTime | null;
  result?: TResult;
  error?: AeRuntimeFailure;
}

export type AeRuntimeEventName =
  | "RUNTIME_READY"
  | "RUNTIME_DEGRADED"
  | "RENDER_READY"
  | "RENDER_FAILED";

/**
 * Adapter-to-client push. An event has a `sequence` but **no `requestId`**, which is what keeps it from
 * ever being mistaken for a reply: replies and events must never share an identity (memory rule 24).
 */
interface AeRuntimeEventBase {
  kind: "event";
  protocolMajor: typeof AE_RUNTIME_PROTOCOL_MAJOR;
  protocolMinor: number;
  sessionId: string;
  sequence: number;
  at: string;
}

export interface AeRuntimeStateDetail {
  /** Why the runtime entered this state. Diagnostic prose, never a control value. */
  reason: string;
}


/**
 * A render completed. **No pixels travel here** — the frame itself reaches the engine through the
 * shared ring, and this is the control-channel statement that it is there, and which instant it is.
 */
export interface AeRenderReadyDetail {
  /** Correlates with the evaluation request that produced this frame. */
  renderRequestId: string;
  compositionItemId: number;
  /** The instant actually evaluated, in the composition's own scale. */
  time: AeRationalTime;
  dataRevision: number;
  /** Ring frame identity, as a decimal string because it is a u64 at the source. */
  frameId: string;
  /** Absolute presentation deadline in nanoseconds, decimal string for the same reason. */
  presentationDeadlineNanos: string;
}

export interface AeRenderFailedDetail {
  renderRequestId: string;
  compositionItemId: number;
  /** Null when the failure happened before an instant could be established. */
  time: AeRationalTime | null;
  dataRevision: number | null;
  error: AeRuntimeFailure;
}

export type AeRuntimeEvent =
  | (AeRuntimeEventBase & { event: "RUNTIME_READY" | "RUNTIME_DEGRADED"; detail: AeRuntimeStateDetail })
  | (AeRuntimeEventBase & { event: "RENDER_READY"; detail: AeRenderReadyDetail })
  | (AeRuntimeEventBase & { event: "RENDER_FAILED"; detail: AeRenderFailedDetail });

export type AeRuntimeEnvelope = AeRuntimeHello | AeRuntimeHelloAck | AeRuntimeRequest | AeRuntimeResult | AeRuntimeEvent;

export class AeRuntimeProtocolError extends Error {
  constructor(readonly code: AeRuntimeErrorCode, message: string) {
    super(message);
    this.name = "AeRuntimeProtocolError";
  }
}

/** Encode one bounded UTF-8 JSON envelope with a four-byte big-endian length prefix. */
export function encodeAeRuntimeFrame(envelope: AeRuntimeEnvelope): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(envelope));
  if (payload.byteLength > AE_RUNTIME_MAX_FRAME_BYTES) {
    throw new AeRuntimeProtocolError("FRAME_TOO_LARGE", `runtime frame is ${payload.byteLength} bytes`);
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** Decode one complete frame. The declared size is refused before slicing or parsing. */
export function decodeAeRuntimeFrame(frame: Uint8Array): AeRuntimeEnvelope {
  if (frame.byteLength < 4) throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime frame has no length prefix");
  const declared = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (declared > AE_RUNTIME_MAX_FRAME_BYTES) {
    throw new AeRuntimeProtocolError("FRAME_TOO_LARGE", `runtime frame declares ${declared} bytes`);
  }
  if (frame.byteLength !== declared + 4) {
    throw new AeRuntimeProtocolError("MALFORMED_FRAME", `runtime frame declares ${declared} bytes but carries ${frame.byteLength - 4}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)));
  } catch {
    throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime frame is not valid UTF-8 JSON");
  }
  assertAeRuntimeEnvelope(value);
  return value;
}

export function negotiateAeRuntimeHello(
  hello: AeRuntimeHello,
  options: { sessionId: string; token: string; capabilities: readonly AeRuntimeCapability[]; fingerprint: AeRuntimeFingerprint; hostPid: number }
): AeRuntimeHelloAck {
  if (hello.protocolMajor !== AE_RUNTIME_PROTOCOL_MAJOR) {
    throw new AeRuntimeProtocolError("PROTOCOL_INCOMPATIBLE", `runtime protocol major ${hello.protocolMajor} is not supported`);
  }
  if (hello.sessionId !== options.sessionId || hello.token !== options.token) {
    throw new AeRuntimeProtocolError("AUTH_FAILED", "runtime session credentials do not match this launch");
  }
  const available = new Set(options.capabilities);
  const missing = hello.capabilities.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    throw new AeRuntimeProtocolError("CAPABILITY_MISSING", `runtime lacks required capabilities: ${missing.join(", ")}`);
  }
  return {
    kind: "hello-ack",
    protocolMajor: AE_RUNTIME_PROTOCOL_MAJOR,
    protocolMinor: Math.min(hello.protocolMinor, AE_RUNTIME_PROTOCOL_MINOR),
    sessionId: options.sessionId,
    capabilities: [...options.capabilities],
    fingerprint: options.fingerprint,
    hostPid: options.hostPid
  };
}

export function assertAeRuntimeRequest(request: AeRuntimeRequest, now = Date.now()): void {
  if (request.protocolMajor !== AE_RUNTIME_PROTOCOL_MAJOR) {
    throw new AeRuntimeProtocolError("PROTOCOL_INCOMPATIBLE", "runtime request protocol major is incompatible");
  }
  if (!request.requestId || !request.idempotencyKey || !Number.isSafeInteger(request.sequence) || request.sequence < 1) {
    throw new AeRuntimeProtocolError("INVALID_PAYLOAD", "runtime request identity is invalid");
  }
  if (!Number.isSafeInteger(request.deadlineUnixMs) || request.deadlineUnixMs <= now) {
    throw new AeRuntimeProtocolError("DEADLINE_EXPIRED", "runtime request deadline has expired");
  }
  if (request.expectedProjectDigest !== null && !/^[0-9a-f]{64}$/.test(request.expectedProjectDigest)) {
    throw new AeRuntimeProtocolError("INVALID_PAYLOAD", "expectedProjectDigest must be a lowercase SHA-256 or null");
  }
}

function assertAeRuntimeEnvelope(value: unknown): asserts value is AeRuntimeEnvelope {
  if (!value || typeof value !== "object") throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime envelope must be an object");
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.protocolMajor) || !Number.isInteger(record.protocolMinor) || typeof record.kind !== "string") {
    throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime envelope header is invalid");
  }
  if (!["hello", "hello-ack", "request", "result", "event"].includes(record.kind)) {
    throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime envelope kind is invalid");
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length < 1 || record.sessionId.length > 128) {
    throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime session id is invalid");
  }
}

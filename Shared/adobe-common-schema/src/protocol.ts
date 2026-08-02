import type { AdobeGatewayStatus } from "./types.js";

export type AdobeApp = "photoshop" | "after-effects";

/**
 * How the gateway reaches an application.
 *
 * - `local` — a plugin running inside the installed application (Photoshop UXP,
 *   After Effects ExtendScript/CEP). Sees the document the operator has open.
 * - `cloud` — Adobe's Photoshop API, driven by the gateway itself through
 *   `@adobe/aio-lib-photoshop-api`. Operates on a PSD by URL and needs no local
 *   Photoshop, which is what makes it usable on a playout machine.
 *
 * After Effects has no cloud API, so `cloud` is Photoshop-only and a request for it is
 * refused by name rather than quietly served by the local bridge.
 */
export type AdobeTransport = "local" | "cloud";

/** Who opened the socket. A bridge serves tools; a client calls them. */
export type PeerRole = "bridge" | "client";

export interface HelloMessage {
  type: "hello";
  role: PeerRole;
  token: string;
  /** Required when role is "bridge". */
  app?: AdobeApp;
  /** Defaults to `local`; the cloud bridge is registered in-process, not over a socket. */
  transport?: AdobeTransport;
  appVersion?: string;
  bridgeVersion?: string;
  tools?: string[];
}

export interface HelloAckMessage {
  type: "hello.ack";
  role: PeerRole;
  gatewayVersion: string;
  /** Assigned peer id, used in logs and progress events. */
  peerId: string;
}

/** A client asking the gateway to run a tool on a bridge. */
export interface ToolCallMessage {
  type: "tool.call";
  requestId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Overrides the app inferred from the tool namespace. */
  app?: AdobeApp;
  /**
   * Which transport must serve this call. Omitted means "prefer the local plugin, fall
   * back to cloud" — the same precedence the Figma importer uses for REST versus MCP.
   */
  transport?: AdobeTransport;
}

export interface ToolResultMessage {
  type: "tool.result";
  requestId: string;
  ok: true;
  result: unknown;
}

export interface ToolErrorMessage {
  type: "tool.error";
  requestId: string;
  ok: false;
  code: string;
  message: string;
}

export interface ToolProgressMessage {
  type: "tool.progress";
  requestId: string;
  /** 0..1. Clamped by the gateway before it is forwarded. */
  progress: number;
  message?: string;
}

export interface StatusRequestMessage {
  type: "status.request";
  requestId: string;
}

export interface StatusMessage {
  type: "status";
  requestId?: string;
  status: AdobeGatewayStatus;
}

export interface LogMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: number;
}

export interface LogsRequestMessage {
  type: "logs.request";
  requestId: string;
  limit?: number;
}

export interface LogsMessage {
  type: "logs";
  requestId: string;
  entries: LogMessage[];
}

/**
 * The operator granting this session permission to modify open Adobe documents.
 * It is sent by the Adobe panel in response to a click, never by a tool.
 */
export interface SessionApproveMessage {
  type: "session.approve";
  requestId: string;
  approved: boolean;
}

export interface SessionApprovalMessage {
  type: "session.approval";
  requestId: string;
  approved: boolean;
}

/**
 * Drop a bridge's socket so the plugin's own reconnect loop rebuilds it. The gateway
 * cannot relaunch a UXP plugin or a CEP panel; it can only release the connection.
 */
export interface BridgeRestartMessage {
  type: "bridge.restart";
  requestId: string;
  app: AdobeApp;
}

export interface BridgeRestartResultMessage {
  type: "bridge.restarted";
  requestId: string;
  app: AdobeApp;
  /** False when no bridge was connected, so the panel can say so instead of implying success. */
  dropped: boolean;
}

export type GatewayInbound =
  | HelloMessage
  | ToolCallMessage
  | ToolResultMessage
  | ToolErrorMessage
  | ToolProgressMessage
  | StatusRequestMessage
  | LogsRequestMessage
  | SessionApproveMessage
  | BridgeRestartMessage;

export type GatewayOutbound =
  | HelloAckMessage
  | ToolCallMessage
  | ToolResultMessage
  | ToolErrorMessage
  | ToolProgressMessage
  | StatusMessage
  | LogMessage
  | LogsMessage
  | SessionApprovalMessage
  | BridgeRestartResultMessage;

export const GATEWAY_VERSION = "0.1.0";
export const GATEWAY_PROTOCOL = "grapix-adobe/1";

/** Tools the gateway will route, grouped by the bridge that must serve them. */
export const PHOTOSHOP_TOOLS = [
  "photoshop.getActiveDocument",
  "photoshop.getDocumentStructure",
  "photoshop.getSelectedLayers",
  "photoshop.exportLayers",
  "photoshop.importGrapixScene",
  "photoshop.createDocument",
  "photoshop.createLayer",
  "photoshop.updateTextLayer",
  "photoshop.updateShapeLayer",
  "photoshop.replaceSmartObject",
  "photoshop.exportPreview"
] as const;

export const AFTER_EFFECTS_TOOLS = [
  "aftereffects.getProject",
  "aftereffects.getActiveComposition",
  "aftereffects.getCompositionStructure",
  "aftereffects.getSelectedLayers",
  "aftereffects.importGrapixScene",
  "aftereffects.createComposition",
  "aftereffects.createLayer",
  "aftereffects.createTextLayer",
  "aftereffects.createShapeLayer",
  "aftereffects.updateLayerTransform",
  "aftereffects.createKeyframes",
  "aftereffects.exportComposition",
  "aftereffects.renderPreview"
] as const;

/**
 * Tools that mutate the Adobe document. They may not run until the operator has
 * approved the calling session, so a model cannot silently rewrite a live PSD.
 */
export const MUTATING_TOOLS: Record<string, true> = {
  "photoshop.importGrapixScene": true,
  "photoshop.createDocument": true,
  "photoshop.createLayer": true,
  "photoshop.updateTextLayer": true,
  "photoshop.updateShapeLayer": true,
  "photoshop.replaceSmartObject": true,
  "aftereffects.importGrapixScene": true,
  "aftereffects.createComposition": true,
  "aftereffects.createLayer": true,
  "aftereffects.createTextLayer": true,
  "aftereffects.createShapeLayer": true,
  "aftereffects.updateLayerTransform": true,
  "aftereffects.createKeyframes": true
};

/** Every routable tool, mapped to the bridge that must serve it. */
export const TOOL_APP: Record<string, AdobeApp> = Object.fromEntries([
  ...PHOTOSHOP_TOOLS.map((tool) => [tool, "photoshop" as AdobeApp]),
  ...AFTER_EFFECTS_TOOLS.map((tool) => [tool, "after-effects" as AdobeApp])
]);

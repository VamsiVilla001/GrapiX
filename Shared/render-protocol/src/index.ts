/**
 * `@grapix/render-protocol` — GrapiX render engine protocol v3.
 *
 * The only way the Editor and Playout may talk to a render engine. Neither ever
 * touches a renderer object; both send messages defined here.
 *
 * What v3 adds over `@grapix/renderer-protocol` v2, which stays supported:
 *
 *   messageId    duplicate suppression, so a retransmit is safe
 *   engineId     routing when several engines are connected
 *   projectId    permission scoping
 *   requiresAck  stated rather than inferred
 *   connection lifecycle, asset, and preview-stream message groups
 *   the full playout verb set, not just a cut
 *   hardware limits in capability negotiation, not just feature booleans
 *
 * Everything time-dependent in `EngineConnection` is injected, so reconnect
 * backoff, heartbeat timeout, retry, and resync are tested without real timers.
 */

export * from "./envelope.js";
export * from "./messages.js";
export * from "./capabilities.js";
export * from "./engine-state.js";
export * from "./diagnostics.js";
export * from "./reliability.js";
export * from "./client.js";
export * from "./transport.js";
export * from "./ipc-transport.js";
export * from "./registry.js";

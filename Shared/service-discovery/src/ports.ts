/**
 * Every TCP/UDP port GrapiX binds, in one place.
 *
 * The ports were correct and undocumented: eight services each carried their own literal, spread
 * across TypeScript, Rust, two Vite configs and a launch profile, and the only written record was a
 * partial list in a memory file. Nothing was colliding — and nothing was stopping the next service
 * from colliding either, because the person adding it had no way to find out what was taken short
 * of grepping for four-digit numbers.
 *
 * This is that list. `npm run check:ports` reads it and verifies two things a comment cannot: that
 * no two services claim the same port, and that each service's own source still declares the port
 * recorded here — including `config.rs`, which no TypeScript import could ever reach.
 *
 * ## Why the numbers are grouped
 *
 * `41xx` is the Editor's own services, `43xx` Playout's, `44xx` the render engine and any render
 * nodes beside it, `47xx` the Adobe bridge, `51xx` the Vite dev servers. The bands are wide enough
 * that a new service in a domain does not have to think, and the gap between them is what stops an
 * engine node counting upward into Playout's range.
 *
 * ## What is deliberately not here
 *
 * Ports a test binds. Tests should ask the OS for a free port (`listen(0)`) rather than claiming a
 * number, because a fixed test port fails on a developer machine that happens to be running the
 * real service — which is exactly how the editor-mcp suite fails when a project service is up.
 */

/** Which product owns the process, for the boundaries the architecture already fixes. */
export type GrapixServiceOwner = "editor" | "playout" | "engine" | "shared";

export interface GrapixServicePort {
  /** Stable id, used by the checker and in diagnostics. */
  id: string;
  /** What an operator would call it. */
  name: string;
  owner: GrapixServiceOwner;
  /** The port it binds when nothing overrides it. */
  port: number;
  /** Environment variable that overrides it, when the service accepts one. */
  envVar: string | null;
  protocol: "http" | "websocket" | "udp";
  /**
   * Repository-relative file that declares this default, and a fragment that must appear in it.
   * The checker asserts the fragment is still present, so moving a port in code without moving it
   * here fails the gate rather than silently disagreeing with the documentation.
   */
  declaredIn: { file: string; contains: string };
  notes?: string;
}

export const GRAPIX_SERVICE_PORTS: readonly GrapixServicePort[] = [
  {
    id: "project-api",
    name: "Editor project service",
    owner: "editor",
    port: 4100,
    envVar: "GRAPIX_API_PORT",
    protocol: "http",
    declaredIn: {
      file: "Editor/services/project-api/src/index.ts",
      contains: "process.env.GRAPIX_API_PORT ?? 4100"
    },
    notes: "Scenes, assets, fonts, imports and the project workspace. Owned by the Editor shell."
  },
  {
    id: "editor-mcp",
    name: "Editor MCP server (HTTP transport)",
    owner: "editor",
    port: 4150,
    envVar: "GRAPIX_MCP_PORT",
    protocol: "http",
    declaredIn: {
      file: "Editor/services/editor-mcp/src/config.ts",
      contains: "readPort(env.GRAPIX_MCP_PORT, 4150)"
    },
    notes: "Only bound with --http; the default transport is stdio and binds nothing."
  },
  {
    id: "editor-assistant",
    name: "Editor AI assistant service",
    owner: "editor",
    port: 4160,
    envVar: "GRAPIX_ASSISTANT_PORT",
    protocol: "http",
    declaredIn: {
      file: "Editor/services/editor-assistant/src/config.ts",
      contains: "num(env.GRAPIX_ASSISTANT_PORT, 4160)"
    }
  },
  {
    id: "playout-control",
    name: "Playout control service",
    owner: "playout",
    port: 4300,
    envVar: "GRAPIX_PLAYOUT_PORT",
    protocol: "http",
    declaredIn: {
      file: "Playout/services/playout-control/src/index.ts",
      contains: "process.env.GRAPIX_PLAYOUT_PORT ?? 4300"
    },
    notes: "Published scene store, Scene Manager, take lists. Independent of the Editor's lifecycle."
  },
  {
    id: "render-engine",
    name: "Render engine (protocol v3)",
    owner: "engine",
    port: 4400,
    envVar: "GRAPIX_ENGINE_PORT",
    protocol: "websocket",
    declaredIn: {
      file: "services/render-engine/src/config.rs",
      contains: "pub const DEFAULT_PORT: u16 = 4400"
    },
    notes:
      "Authoritative for Program. Additional render nodes take 4401-4403; an operator may point a "
      + "profile at any host and port, so these are defaults, not a fixed range."
  },
  {
    id: "adobe-mcp-gateway",
    name: "Adobe MCP bridge",
    owner: "editor",
    port: 4784,
    envVar: "GRAPIX_ADOBE_GATEWAY_PORT",
    protocol: "http",
    declaredIn: {
      file: "Editor/services/adobe-mcp-gateway/src/config.ts",
      contains: 'process.env.GRAPIX_ADOBE_GATEWAY_PORT || "4784"'
    },
    notes: "Supervised by the Editor desktop shell alongside the project service."
  },
  {
    id: "editor-web",
    name: "Editor web UI (Vite dev server)",
    owner: "editor",
    port: 5173,
    envVar: null,
    protocol: "http",
    declaredIn: { file: "Editor/apps/editor-web/vite.config.ts", contains: "port: 5173" },
    notes: "Development only. The packaged desktop shell serves the built bundle from disk."
  },
  {
    id: "playout-web",
    name: "Playout operator UI (Vite dev server)",
    owner: "playout",
    port: 5174,
    envVar: null,
    protocol: "http",
    declaredIn: { file: "Playout/apps/playout-web/vite.config.ts", contains: "port: 5174" },
    notes: "Development only."
  },
  {
    id: "editor-web-readonly",
    name: "Editor web UI, second instance",
    owner: "editor",
    port: 5199,
    envVar: null,
    protocol: "http",
    declaredIn: { file: ".claude/launch.json", contains: '"port": 5199' },
    notes:
      "A second Editor pointed at a second project service is how the two are compared; it needs a "
      + "port of its own or it silently attaches to the first."
  },
  {
    id: "mdns",
    name: "Link-local discovery (mDNS)",
    owner: "shared",
    port: 5353,
    envVar: null,
    protocol: "udp",
    declaredIn: { file: "Shared/service-discovery/src/socket.ts", contains: "MDNS_PORT = 5353" },
    notes:
      "Fixed by RFC 6762 and shared with every other mDNS responder on the machine. Not ours to "
      + "reassign; the socket is opened with SO_REUSEADDR for exactly that reason."
  }
] as const;

/**
 * Ports that were used and must not be reused.
 *
 * A retired port is not a free port. Something on the network may still be trying to reach the
 * thing that used to answer there, and a new service picking up the number answers a request it
 * does not understand — or worse, understands differently.
 */
export const GRAPIX_RETIRED_PORTS: readonly { port: number; retired: string; reason: string }[] = [
  {
    port: 4200,
    retired: "2026-07-29",
    reason:
      "The protocol v2 render daemon binary. Nothing launches, packages or falls back to it; the "
      + "crate survives only so its integration tests can drive the render core."
  }
];

/** The port a service binds by default, or `undefined` if the id is not registered. */
export function servicePort(id: string): number | undefined {
  return GRAPIX_SERVICE_PORTS.find((service) => service.id === id)?.port;
}

/** What is already on a port, whether live or retired. `null` when it is free to claim. */
export function whatClaimsPort(port: number): string | null {
  const service = GRAPIX_SERVICE_PORTS.find((entry) => entry.port === port);
  if (service) return service.name;
  const retired = GRAPIX_RETIRED_PORTS.find((entry) => entry.port === port);
  return retired ? `retired ${retired.retired}: ${retired.reason}` : null;
}

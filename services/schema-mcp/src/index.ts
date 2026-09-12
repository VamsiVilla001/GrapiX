// schema-mcp. Status: Partial.
//
// Standalone, vendor-neutral, read-only MCP surface over the GrapiX contracts.
// Deliberately independent of a running Editor: any MCP-capable model can read
// the schema without booting an application.
//
// It holds no schema of its own, and as of build-plan 8.1 it holds no schema
// *values* either. Both come from @grapix/contracts, generated from Rust
// (invariant 22).
//
// What changed, and why it mattered: this file used to carry five
// hand-maintained runtime lists — device tiers, localities, clock sources,
// reference states, media codecs — plus the refusal codes, each guarded by a
// compile-time assertion against the generated union. The guards worked, and
// they were a good answer to the wrong question. A union type carries no
// runtime list, so the values had to come from somewhere; the fix was to make
// the generator emit them rather than to check a copy by hand. `npm run
// codegen` now writes `capability-surface.ts` from the same Rust that defines
// the enums, so there is nothing left here to drift.
//
// What is still not here: the JSON-RPC transport and the mutating D.2 tool
// groups, which land with the products that own them. The tool *descriptors*
// are present — an agent can discover the whole surface and the scope each
// tool requires — but calling most of them is not yet wired. This file is
// read-only by construction and says so.

import {
  CAPABILITY_SURFACE,
  type CapabilitySurface,
  type Refusal,
  type Scope,
  type ToolDescriptor,
} from "@grapix/contracts";

/** The server is read-only by construction. Authoring belongs to the Editor
 *  and Program belongs to Playout; this exposes neither. */
export const capabilities = {
  resources: true,
  tools: true,
  mutation: false,
} as const;

export const status = "Partial" as const;

/** The contract schema version an agent is talking to. Versioned alongside
 *  protocol v3 so an agent can ask what it is connected to (D.5). */
export const SCHEMA_VERSION = CAPABILITY_SURFACE.schemaVersion;

/** Return the capability surface (system.capability). Always call first.
 *
 *  Every value is generated from the Rust contracts, so an agent that reads
 *  this is reading what the engine will actually enforce — not a description
 *  of it maintained alongside. */
export function getCapabilitySurface(): CapabilitySurface {
  return CAPABILITY_SURFACE;
}

/** The values one enum accepts on the wire, or undefined if it is not an
 *  enumerable this surface publishes.
 *
 *  An agent about to emit a blend mode asks here first. That is the discovery
 *  half of the refusal contract: the values returned are exactly the ones that
 *  do not produce an `unsupportedBlendMode` (D.1 principle 2). */
export function enumValues(name: string): readonly string[] | undefined {
  return CAPABILITY_SURFACE.enums.find((entry) => entry.name === name)?.values;
}

/** Every refusal code a caller can receive, each one actionable. */
export function refusalCodes(): readonly string[] {
  return CAPABILITY_SURFACE.refusals;
}

/** Every tool on the automation surface, with the scope each requires. */
export function tools(): readonly ToolDescriptor[] {
  return CAPABILITY_SURFACE.tools;
}

/** The tools a caller holding these scopes may reach.
 *
 *  Advisory, not enforcement: the server refuses on its own authority and this
 *  is here so an agent can avoid asking for what it cannot have. A client-side
 *  filter that disagreed with the server would be worse than none, which is
 *  why both read the same declared `requiredScope` rather than each deciding
 *  (invariant 27). */
export function reachableWith(held: readonly Scope[]): readonly ToolDescriptor[] {
  return CAPABILITY_SURFACE.tools.filter(
    (tool) => tool.requiredScope === null || held.includes(tool.requiredScope),
  );
}

// Referenced so the contract dependency is real rather than declared, and so
// a broken regeneration fails this package's typecheck.
export type { Refusal, ToolDescriptor };

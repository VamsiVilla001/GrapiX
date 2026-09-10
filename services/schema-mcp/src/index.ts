// schema-mcp. Status: Planned. Skeleton only.
//
// Standalone, vendor-neutral, read-only MCP server exposing the GrapiX
// contracts as MCP resources plus introspection tools. Deliberately
// independent of a running Editor: any MCP-capable model can read the schema
// without booting an application.
//
// It holds no schema of its own. It reads @grapix/contracts, which is
// generated from Rust (invariant 22), so it cannot drift from the source of
// truth.

import * as contracts from "@grapix/contracts";

/** The server is read-only by construction. Authoring belongs to the Editor
 *  and Program belongs to Playout; this exposes neither. */
export const capabilities = {
  resources: true,
  tools: true,
  mutation: false,
} as const;

export const status = "Planned" as const;

// Referenced so the contract dependency is real rather than declared, and so
// a broken regeneration fails this package's typecheck.
export type ContractSurface = typeof contracts;

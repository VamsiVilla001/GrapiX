# schema-mcp

Standalone, vendor-neutral, **read-only** MCP server exposing the GrapiX
contracts as MCP resources plus introspection tools.

Deliberately independent of a running Editor: any MCP-capable model can read
the schema without booting an application. It is a reader of
`Shared/generated-ts` and the Rust contracts — it holds no schema of its own,
so it cannot drift from them.

It cannot mutate anything. Authoring is the Editor's, and Program is Playout's.

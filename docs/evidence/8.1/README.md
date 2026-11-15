# 8.1 — Tool schema generated from contracts

Build-plan row `8.1`. Done when: **no hand-written schema**; the row's work is
"tool schema generated from contracts; versioned alongside the protocol".

Reopened 13 October 2026 because none of the 30 `tools/list` entries carried an
`inputSchema` (each named a type). The plan's condition to close it again:
"every listed tool carries its generated JSON Schema as `inputSchema`, checked
by a test over every tool". Codex made the schemas generated on 19 October and
left the row active until the shared gate passed; it passes now (below).

## Where the schema comes from

`gx_contracts::mcp::input_schema(descriptor.input)` builds each tool's schema
from the Rust payload type (`schemars`), and `npm run codegen` writes the same
value to `Shared/generated-ts/schemas/mcp/<tool>.schema.json`. The registry
(`ToolRegistry::all()`) holds 31 tools today (30 at the reopening). `Server::listed_tools` builds
`tools/list` from that one function, for the in-process API and for the rmcp
wire alike. `services/schema-mcp` is a reader of the generated files and
holds no schema of its own.

## Executed

- `cargo test -p gx-mcp-server` (17 passed, 0 failed), including:
  - `tools_list_returns_the_whole_registry_under_the_spec_field`: for every
    one of the 31 registry tools, `tools/list` carries an `inputSchema` equal to
    `input_schema(descriptor.input)`, of `"type": "object"`, and equal to the
    checked-in `schemas/mcp/<tool>.schema.json`.
  - `wire::tests::tools_list_carries_the_generated_schema_and_the_registry_entry`:
    the same over the rmcp wire, with the registry entry under
    `_meta["dev.grapix/tool"]` and `readOnlyHint` from the tool's effect.
  - **new** `every_checked_in_tool_schema_is_one_the_registry_generates`: the
    schema directory holds exactly the 31 registry tools and no other file, and
    each file equals what the contracts generate for its tool whether or not a
    server installs a handler for it (so the Program tools, which have no
    shipped binary yet, are covered too).
  - **new** `the_tool_schema_is_versioned_with_the_protocol`: the capability
    surface's `schemaVersion` and `protocolVersion` are both
    `PROTOCOL_VERSION` (5 today), the checked-in `capability-surface.ts` carries
    the same two numbers, and `system.capability` over the server answers it.
- `cargo test -p gx-editor-mcp --test stdio_surface`: the shipped
  `gx-editor-mcp` binary, a real handshake, `tools/list`: every advertised
  tool's `inputSchema` equals the generated one, is a usable JSON Schema, and
  rejects a non-object argument.
- `cargo test -p gx-playout-mcp --test surface` (3 passed): the Program-side tools
  answer through the same server; their schemas are covered by the directory
  test above.
- `npm run codegen:check` (in `npm run check`): the generated tree is not stale.
- A search of every `.ts`, `.mjs` and `.js` file outside `node_modules`, `dist`, `target` and `legacy`
  for `inputSchema` finds none: the TypeScript side builds no tool schema, and `schema-mcp` only reads
  the generated files.
- npm run check exit 0 (46 Node, 412 Editor, 877 Rust passed, 0 failed, 37 ignored; conformance 591/0/9), cargo fmt --all and cargo clippy --workspace --all-targets -D warnings clean.

## Jev and Laya acceptance (`jev-laya-acceptance.json`)

Run on this record before the final gate. Laya read it whole: 1452 tokens,
nothing truncated or dropped.

| Question | Jev | Laya |
| --- | --- | --- |
| done-when met by execution | 0.95 | 0.90 |
| evidence names execution | 0.98 | 0.83 |
| silent substitution risk | 0.27 | 0.93 |
| weakest point | none (0.60) | vague record |
| what was not run is named | 0.59 | 0.89 |
| mutations can fail | 0.95 | 0.87 |
| every tool has its generated schema | 0.96 | 0.80 |
| no hand-written schema | 0.95 | 0.91 |
| versioned with the protocol | 0.97 | 0.87 |
| arrives over a real wire | 0.97 | 0.88 |

They agree the done-when is met and split, as on 3.19 and on the MCP edits, on
the silent-substitution risk and the weakest point, again without reasons. By
hand: the one clause, no hand-written schema, is shown by the whole-registry
tests, six mutations (a hand edit, a hand-built listing, a stray file, the
version) that each fail a named test, and a search that finds no `inputSchema`
in any TypeScript. Everything not covered (`outputSchema`, a shipped Program
binary, the tiers, `if_revision`) is listed under "Not in this row". The
disagreement is reported to the user.

## Mutations

One exact change each, run alone against the tests named, each file restored
byte-identical (`mutate_81.py` in the session scratchpad):

| # | Mutation | Failing |
| --- | --- | --- |
| S1 | a generated schema file is edited by hand | `every_checked_in_tool_schema_is_one_the_registry_generates`, `tools_list_returns_the_whole_registry_under_the_spec_field` |
| S2 | `tools/list` builds its schema by hand | `tools_list_returns_the_whole_registry_under_the_spec_field`, `wire::tests::tools_list_carries_the_generated_schema_and_the_registry_entry` |
| S3 | the wire lists no `inputSchema` | `wire::tests::tools_list_carries_the_generated_schema_and_the_registry_entry` |
| S4 | the schema version is not the protocol version | `the_tool_schema_is_versioned_with_the_protocol` |
| S5 | the shipped binary lists a hand-built schema | `shipped_stdio_tools_list_carries_usable_generated_schemas` |
| S6 | a hand-written schema file is added beside the generated ones | `every_checked_in_tool_schema_is_one_the_registry_generates` |

## Not in this row

- **`outputSchema`.** Codegen emits input schemas only; a tool's result type has
  no schema. The done-when does not ask for one.
- **No shipped Program MCP binary.** The Program tools' schemas are generated and
  checked, but no process lists them over a wire yet (8.14's transport half
  covered the Editor).
- **The three tiers** (read, author on a draft handle, propose) and the
  every-tool Cue/Take conformance test are 8.14's, not this row's.
- **`if_revision` and idempotency keys** on writes are 8.12's.

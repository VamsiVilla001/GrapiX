# 8.14 slice 1: every MCP tool the crates serve, behind its scope, with a recording engine behind the Program tools

Built 25 Nov 2026 by claude-grapix-f1 (the user asked me to start on backend alongside codex; nobody held the MCP lane; the board had
been cleared by the user). Verification only: **no contract, wire, generated-file or service change**. New `conformance/src/mcp_scope.rs`;
one `mod` line and one `pub use` line in `conformance/src/lib.rs`; the import and one call in `conformance/src/main.rs`. Row 8.14 stays
active: its three tiers and the approval queue are not built.

## What the row asks, and what existed

The done-when: "A conformance test enumerates every MCP tool and asserts that none reachable by an author- or agent-scoped token can Cue,
Take, Continue, Clear or configure outputs, while 8.11's operator-scoped tools stay behind their scopes (invariant 65)."

`gx-contracts` already tested the tool **table** (every tool has a scope decision; an author scope is refused four named tools). Nothing
tested what is **served**, nor that a tool that *can* reach the engine does not. This suite does, by running the tools.

## How it proves it

It assembles every handler the MCP crates provide (the shipped author-only Editor server plus every Playout tool) into one server and wires
the Program tools to a mock engine that **records every request it receives**. "Changes Program or outputs" is not a list of names kept in the
test: it is `ClientRequest::required_scope()`, an exhaustive match in the control plane (a request that needs an operator scope changes Program
or outputs; `Phase`, which is how Continue, Hold, Update and Out reach the engine, needs `Take`). The checks (`mcp` plane, nine):

1. **The operator scopes and tools are written out again** (Cue, Take, Clear, ConfigureOutput, Stop; and the scope each of the seven
   operator-scoped tools needs), so the classification cannot be changed by the same edit that changes the table.
2. **The Editor MCP crate and the Editor service have no direct dependency** on `gx-control-plane`, `gx-control-transport`, `gx-playout` or
   `gx-playout-mcp` (read from their manifests, `[dependencies]` only), so an author tool has no path to Program.
3. **Every served tool has a scope decision**; only capability discovery needs none.
4. **An agent credential calling an operator-scoped tool is refused by name and the engine hears nothing**, for each of four agent
   credentials (no scope, Author, Report, both), with arguments valid enough to reach the engine if the gate failed (a pinned revision for
   cue and take, a real output config), and a revision's review state is unchanged afterwards.
5. **No tool an agent credential can reach sends the engine a Program-changing request**, called with representative arguments
   (including a valid `render.preview`, the one author tool that talks to the engine: it sends a `Render` request only).
6. **Each operator-scoped tool is opened by its own scope and by no other operator scope**, and under its own scope the recorder **sees the
   Program request reach the engine** (the positive control: without it every zero above could be a recorder that cannot see).
7. **A hostile tool is caught**: an assembly in which an author-reachable tool (`outputs.list`) sends the engine a Clear is run through the
   same detector, which must report it (the negative control).
8. **Every tool the table declares is served, or named as not served yet** (a ratchet, see Findings).
9. **The shipped Editor MCP server lists no Program or output tool, and the operator-scoped tools it lists are exactly the named admin ones**
   (a ratchet, see Findings).

Plus two unit tests of the manifest reader. The suite is also a `#[test]`, so `cargo test -p gx-conformance --lib mcp_scope` runs it alone.

## Findings (reported, not fixed: they are other rows' calls; both are written into the suite as ratchets)

1. **`objects.list`, `assets.list` and `fonts.list` are declared in the contract's tool table and have no handler anywhere.** The three names
   appear in `Shared/contracts/src/mcp.rs` and in no other source file. `tools/list` does not show them, so an agent never sees them, but
   rows 8.3 ("project, scenes, objects") and 8.4 ("materials, assets, fonts") are marked done. Either the table is stale or those rows are
   overclaimed. I changed neither row; the owner decides (serve them, or remove the declarations and say what replaced them).
2. **`tools/list` is not filtered by the caller's scopes.** `Server::listed_tools()` lists every installed tool, so an author credential on
   the shipped Editor MCP server sees `designsystem.import` and `designsystem.commit` (`ConfigureOutput`, the "admin" scope of row 8.7,
   historical compatibility) that it can never call. They are refused by name when called (check 4), so this is a leak of names, not of
   authority; but it contradicts the comment in `authorised_handler` ("a caller probing for what exists learns nothing it was not told").
   A per-caller list changes what every MCP client sees, so it is a decision for the owner of 8.14 and 8.7, not part of this slice.

## Verification (25 Nov 2026, `agent/worktree`, own `CARGO_TARGET_DIR` on D:, under LOCK gate)

- `cargo test --locked -p gx-conformance --lib mcp_scope`: **3 passed**. `cargo check -p gx-conformance --bins` compiles `main.rs` with the new call.
  `rustfmt --check` on the new file is clean.
- **Mutation, `tools/mutate-mcp-scope.mjs`: 16 of 16 caught**, each by a named check (`mut-logs.txt`), both files restored and verified
  (the suite byte for byte, `Shared/contracts/src/mcp.rs` by `git diff`, which nobody else had changed). Part A, the suite's own sensitivity:
  Take dropped from the operator scopes; the hostile tool made harmless; the agent-reach loop never calling a tool; cue and take given
  no valid arguments; outputs.configure given none; both ratchets emptied; the Program tools not registered; the expected scope list
  losing Stop; the expected tool list giving `playout.clear` the wrong scope; the program-crate list emptied; a dev-dependency read as a
  dependency. Part B, the contract itself: **the gate lets every caller through** (caught by three checks), **`playout.take` needing only
  an author scope** and **`outputs.configure` needing only an author scope** (each caught by the expectation list *and* by the behavioural
  check: an agent credential reached the tool and the engine saw the Take or the ConfigureOutput), and **`playout.clear` needing the Cue
  scope** (a cue-only token can clear). **Two weaknesses were found by the first mutation run and fixed before this record:** a single
  classifier meant a wrong edit to it hid everything (A1), and nothing checked *which* operator scope each tool needs, only that it stays
  behind whatever the table says (B4). Both are now the first check above. (The first run also mislabelled caught mutants as survivors
  because the runner read cargo's "error: test failed" as a build error; fixed, all 16 re-run.)

- **The project's own conformance command**, `cargo build -p gx-mock-engine -p gx-mock-editor -p gx-mock-playout -p gx-render-worker -p
  gx-engine-host -p gx-editor-mcp -p gx-diag && cargo run -p gx-conformance` (own target dir): exit 0, **CONFORMANT, 653 passed, 0 failed, 9
  skipped**. Before this slice the same run was 644 passed; the difference is these nine checks, listed as their own section ("every MCP
  tool the crates serve, Program tools on a recording mock (8.14)"). The 9 named skips are unchanged.

**Not verified:** the rest of `npm run check` (the Rust workspace tests, codegen freshness and the Editor suites: others' work is in flight); a real engine behind the recorder (the suite uses the
mock engine, which is enough because the property is about which requests a tool *sends*, and the control-plane request type is the same).
No commit.

## Open

- The three tiers of 8.14 (Read, Author on a draft handle, Propose) and the approval queue (13.7) are not built. A **read-only credential
  does not exist**: `Scope::Author` covers reads and writes alike, so the Figma E4 "Reader" role cannot be represented today. That is a
  contract decision (a new scope, and what an existing author token becomes), tied to the owner's open question on the roles (screen map C-17).
- The two findings above.

---

# 8.14 slice 2: a published revision never changes, an unknown scene schema fails closed, and the specification beside the wire

Built 25 Nov 2026 by claude-grapix-f1, answering three of the five gaps in codex's review of the row (Panchayati 695). **No contract, wire,
generated-file or service change**: three more checks in `conformance/src/mcp_scope.rs` (mine), one new test file in
`services/mcp-server/tests/http/` (one `mod` line in its `main.rs`), and `spec-check.md` here. Row 8.14 stays active.

| Codex's gap (695) | This slice |
|---|---|
| "The scope suite does not demonstrate that an author edit cannot change published content" | Closed by checks 10 and 11 below. |
| "...or that an unknown tool schema version is rejected" | Closed for the scene document's schema version (check 12) and for the wire revision (`spec-check.md`); see "What 'unknown schema version' means". |
| "no record of the pre-coding official-spec check" | There cannot be one now. `spec-check.md` is the check made after the fact, by running the transport against the specification's own words, and says so. The latest-release half of the SDK check is open (the fetch tool was refused github.com, crates.io and docs.rs). |
| "Scope::Author still covers reads and writes; the dedicated Read tier" | Not built: a contract decision (a read-only credential), tied to the owner's open roles question (C-17). |
| "stateless draft handles, and submission to Playout's 13.7 approval queue" | Not built. |

## What "unknown schema version" means

The row's words are "an unknown schema version is refused (the server fails closed)". Three things carry a schema version here:

1. **A scene document** (`version`, `SCENE_SCHEMA_VERSION` = 4). `parse_scene_document` upgrades 1 to 3 and refuses everything else, newer
   or below the range, as `SceneSchemaUnsupported { actual, supported }`. A tool call can run into it, so this is what the row means and
   what check 12 proves.
2. **The MCP wire revision.** A request naming a revision the server does not speak is answered -32022 with the revisions it does; proved in
   `spec-check.md`.
3. **The tool table's own version** (`TOOL_SCHEMA_VERSION`, reported by `system.capability`). No tool takes it as input, so there is nothing
   for a server to refuse. Stated so the question does not come back.

## The three checks (plane `mcp`; 656 in the conformance run, 653 before)

10. **No tool that writes under the Author scope can name a published revision.** Every served Author-scoped write tool's generated input
    schema (the one `tools/list` hands an agent), read recursively, has no property called `takeId` or `contentHash`. Controls: the
    operator's own write tools (cue, take, review) must show those names (at least three do), and at least five author write tools must
    be found, so a reader that sees nothing fails instead of passing.
11. **A published revision is byte-identical after every author write.** Through the served tools, as an Author credential: build a package,
    publish it (revision 1, snapshotted whole: document, content hash, review, design-system stamp), then rebuild the package file with
    another scene, publish again (a new revision 2 with a different document and hash), publish naming `takeId: lower-third, revision: 1`,
    create a stored scene with the same id in the Editor store, edit it and delete it. Revision 1 is compared with its snapshot after each.
    Then the operator's one action on a revision: `playout.review` under a Take scope moves the review and nothing else (document, hash,
    stamp, number), and must move it (a review that did nothing fails).
12. **A scene schema version this build does not know is refused by name by every tool that reads a scene, and no package is built from
    it.** A stored scene is rewritten with version 5, 99 and 0; every served tool whose input is a scene reference (found from the table,
    at least four: `scenes.get`, `objects.hierarchy`, `materials.list`, `bindings.schema`, `validate.preflight`) and `scenes.edit` must answer
    `SceneSchemaUnsupported` with the version found and the version supported, and the file must be byte-identical afterwards (nothing
    upgraded, nothing written). `packages.build` of a version-99 scene is refused and creates no file; over an existing package it leaves
    that package byte-identical.

## Mutation: 16 of 16 caught (`mutation-log-slice2.txt`, `tools/mutate-immutability-schema.mjs`)

| | Mutant | Caught by |
|---|---|---|
| A13-A15 | the suite itself made blind: no author write tool looked at; the names of a published revision not listed; no scene-reading tool found | the guards inside checks 10 and 12 |
| X1 | a publish reuses the revision number, overwriting the last revision (`services/playout`) | check 11 |
| X2-X5 | a review wipes the document / drops the content hash / drops the design-system stamp / moves nothing | check 11 (X3 also by the operator-scope check) |
| X6 | a publish hashes nothing of its document | check 11 |
| X7 | `packages.publish` made to take a Take ID and a content hash (`Shared/contracts/src/mcp.rs`) | check 10 |
| Y1-Y3 | the scene reader's guard removed / widened to version 0 / widened to the next version (`Shared/contracts/src/scene.rs`) | check 12 |
| Y4-Y5 | the refusal does not say what was found / what is supported | check 12 |
| Z1 | a package's scene read without the version guard (`Shared/asset-plane/src/package.rs`) | check 12 |

The runner is careful with files other agents also have uncommitted work in (`services/playout/src/lib.rs`,
`Shared/contracts/src/scene.rs`): it reads each at the start, **stops if one has changed before the next mutant**, restores after every
mutant, and compares every file with its start byte for byte at the end (all five, `restoredByteForByte: true`). **The honest limit of
check 11:** revision 1 is compared with its snapshot at five points. Only the one after the second publish has a product mutant that fails
there (X1); the review comparison has its own (X2-X5), and X6 fails the "revision 2 differs" test. The other four points (after the package
rebuild, after a publish naming revision 1, after the edit of a stored scene and after its deletion) have none, because no code joins the
package file, the publish arguments or the Editor store to Playout's library for a mutant to break: they pin that independence in the
assembly and would catch a future change that joins them, but nothing here has shown that they would.

## Findings (reported, not fixed; the first is pinned so it cannot change unseen, the second is a statement of what the tree contains)

- **D1. A scene of an unknown version can be deleted.** `scenes.delete` with the right `ifRevision` removes a stored scene whose version this
  build cannot read; nothing parses the file to delete it. Deleting is not reading, and a person who wants a scene gone should be able to say
  so, but a build too old to read a scene destroys what a newer build wrote. The owner of 8.14 decides; today's behaviour is pinned in check
  12, which fails when it changes.
- **L1. `packages.publish` and the Playout tools do not share a library.** `PackagesPublish` owns its `PublishedLibrary`
  (`services/playout-mcp/src/lib.rs`) and so does `ProgramTools`; no code in the tree constructs the two sharing one (the only places
  `PackagesPublish(` is built are this suite, `tests/surface.rs` and the crate's own test). A revision published through `packages.publish`
  is therefore not one `playout.library`, `playout.review` or `playout.take` can see through MCP; the Playout shell may connect them by
  another route, which I did not look for. Check 11 holds on both libraries separately; there is no end-to-end publish-review-take run
  through the MCP tools to be tested until they meet. I changed nothing.

## Verification (25 Nov 2026, own `CARGO_TARGET_DIR` on D:, under LOCK gate)

- `cargo test --locked -p gx-conformance --lib mcp_scope`: 4 passed (the suite and three unit tests, one new: the schema reader).
- `cargo test --locked -p gx-mcp-server`: 24 passed, and the HTTP binary 9 passed, one of them the new
  `the_transport_answers_as_the_2026_07_28_specification_says_where_it_decides`.
- The project's conformance command (`npm run conformance`): exit 0, **CONFORMANT, 656 passed, 0 failed, 9 skipped** (653 before).
- `rustfmt --check` on both new files: clean. `cargo clippy -D warnings` on `gx-conformance`, `gx-mcp-server` and `gx-editor`: clean once
  four lints in other agents' uncommitted code are allowed, six places (without that it stops there: `neg_cmp_op_on_partial_ord` in
  `Shared/contracts/src/path_geometry.rs` 831 and 834, `type_complexity` in `services/editor/src/import.rs` 349 and
  `services/render-engine/worker/src/engine.rs` 1114, `nonminimal_bool` in `services/editor/src/project.rs` 590, `map_identity` in
  `engine.rs` 635); CI's lint step would be red on them whoever pushes.
- Not run: the rest of `npm run check` (others' work is in flight). No commit.

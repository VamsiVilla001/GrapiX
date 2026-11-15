# 5.10 — the Editor publishes by the engine's declared route

**Done-when (reworded 8 Nov 2026, user decision).** The Editor's publish learns
the engine's declared locality only from the engine itself, with a closed
`{locality:{}}` read on the asset-plane address it publishes to, answered from
the same field as `EngineCapability.locality`. The Editor holds no control-plane
client (R6) and names no `Locality` (R9). The publish always writes one verified
package, named by content hash, into its package folder, and publishes it
through `gx_asset_plane::publish_package`: co-located by path with 0 asset
bytes, over a LAN chunked with only the missing bytes. The package is removed
after the reply. Conformance against real workers and both mocks shows each
peer's asset-plane answer equal to its capability, publishes the Inter lower
third to each route, takes both with their pinned hashes on T0, and shows each
named refusal. Mutations each fail a check. `npm run check` passes.

## Design

`design-synthesis.json` and `design-jev-laya.json` in this directory. User
decisions (8 Nov 2026): the Editor reads locality through an asset-plane read; a
co-located engine without `--package-dir` is a named refusal with no fallback;
conformance does the take.

## What was built

- **Asset plane.** The closed request `{"locality":{}}` and its reply
  (`LocalityReply`); `AssetPublishPeer::locality` with no default, so no peer
  declares by omission; `declared_locality`; `publish_as_package`,
  `DocumentPublication`, `DocumentPublishError`; `AssetHandoff` serialises. A
  LAN-declared engine reads no path even if it holds a package directory.
- **Peers.** The worker engine and the mock return the field their capability
  declares; the conformance recording peer delegates. `gx-render-worker` refuses
  `--lan` together with `--package-dir` (usage error, exit 2).
- **Contracts.** `platform::package_exchange_root()` (`<cache root>/packages`).
- **`gx_editor::publish`** (new): `package_sources`, `publish_document`,
  `Published`, `PublishFailure`. No `Locality` appears in it. Only the caller's
  own clone is pinned to the revision a package needs; the workspace document is
  untouched. The hash the engine issues is compared with the hash of what was
  packaged: a mismatch is a Protocol failure that says not to take that revision.
- **Editor shell.** `cmd_publish` goes through `package_sources` and
  `publish_with_sources`; `PublishResult` gains `handoff` and `transferredBytes`;
  `EditorError::WritePackage`; the package folder is `GX_EDITOR_PACKAGE_DIR` or the
  platform exchange root. The old `publish`, `publish_with_assets` and
  `scene_asset_bytes` are removed. Its own cache read failures are `AssetCache`.
- **Web.** The result and the log show the route and bytes.
- **Launchers.** `tools/launch-shells.mjs` creates `target/dev-packages`, starts
  the worker with it as `--package-dir` and tells the Editor
  `GX_EDITOR_PACKAGE_DIR`. `gx-engine-host` gives a worker it spawns the same
  folder.
- **Conformance.** `conformance/src/editor_publish.rs`, against three real
  workers (`--package-dir D`, `--lan`, and co-located with none), plus the
  locality agreement on both mocks.
- **Boundaries.** Two new synthetic cases: a `Locality::Lan` arm in the Editor's
  publish, and a control-plane client in the shell's manifest, are each refused.

## Executed

| Check | Result |
| --- | --- |
| `cargo test -p gx-asset-plane --lib` | 109 passed, includes the locality read, the closed forms, the LAN rule, both routes of `publish_as_package`, unique package names, a missing source, an unreachable engine, a pre-5.10 engine |
| `cargo test -p gx-editor --lib publish` | 9 passed |
| `cargo test -p gx-editor-shell --test publish` | 6 passed against real workers: by path (revisions 1 then 2, folder empty), unreachable, font by path, the same scene chunked to `--lan` (the font's bytes, then 0), no `--package-dir` (named, with the Editor's folder), a folder the engine was not started with (named) |
| `node --test tools/tests/check-boundaries.test.mjs` | 21 passed |
| `npm run typecheck:web` | clean |
| `npm run conformance` | 583 passed, 0 failed, 9 skipped; the 5.10 checks below all PASS on this T0 workstation |
| Gate | cargo fmt --check and clippy -D warnings exit 0; npm run check exit 0 (46 Node, 412 Editor, 837 Rust / 0 failed / 26 ignored, conformance 583/0/9) |

Conformance, plane "asset", real workers:

1. the asset-plane locality equals the capability's on the worker started with a
   package directory, with `--lan`, and with none (three checks), and on the
   co-located and LAN mocks (two);
2. the Editor publishes the Inter lower third by path (0 asset bytes) to the
   co-located engine and chunked (exactly the font's bytes) to the LAN engine;
3. both are the document's content hash, revision 1, and leave the folder empty;
4. the co-located publication is taken with its pinned hash, and the LAN one is
   (Taken on T0; a named skip below T0);
5. publishing again issues revision 2 by the same route;
6. a folder the engine was not started with is `PackagePathOutsideDirectory`;
7. a co-located engine with no package directory is
   `PackageDirectoryNotConfigured`, with no fallback and nothing written;
8. a LAN-declared worker engine holding a directory still refuses a forced path;
9. an asset with no content hash is refused before any socket opens;
10. an engine nothing listens for is unreachable, not refused, and writes no
    package;
11. `--lan` with `--package-dir` exits 2 and names `--package-dir`.

## Mutations

One exact replacement each, run alone, files restored byte-identical (compared
byte for byte). Conformance totals are from `npm run conformance`.

| # | Mutation | Failing |
| --- | --- | --- |
| M1 | the publisher ignores the declared locality and always sends chunked | 4 checks (by path expected, republish, outside folder, no package directory) |
| M2 | the publisher ignores it and always sends by path | 2 checks (the LAN route, the folder and hashes) |
| M3 | the worker answers the opposite locality on the asset plane | 19 checks, including all three agreement checks and the 5.8 suite |
| M4 | the LAN mock answers co-located | the LAN mock agreement check |
| M5 | the server reads a path for a LAN-declared engine that holds a directory | the LAN-holding-a-directory check |
| M6 | the package is not removed after the reply | 3 checks (the empty folder, and two that read it) |
| M7 | the Editor accepts a revision for other content | `a_revision_for_other_content_is_a_protocol_failure_that_says_not_to_take_it` |
| M8 | the locality read accepts an argument | `the_locality_read_takes_no_argument_and_no_company` |
| M9 | the package is written outside the folder | 3 checks |

## Supersedes and changes

- **5.8 evidence** (`docs/evidence/5.8/README.md`) said the Editor never builds a
  package. From 5.10 it always does, and removes it.
- **5.9.** Its done-when "the Editor's publish sends every asset through
  preflight and the 5.3 transfer" now holds over a LAN. Co-located, the path
  handoff replaces it. A co-located engine started by hand without
  `--package-dir` now refuses every Editor publish by name; 5.9's chunked publish
  succeeded. A running dev pair must be restarted once through the updated
  launcher.
- An asset with no content hash, which the 5.9 publish skipped, is now refused
  `PackageAssetNotPackaged` before any connection.

## Not in this row

- **Live check in the Tauri window was not run.** The shell's Rust path, the web
  bundle (`npm run build:web`, `npm run typecheck:web`) and the conformance suite
  were. What remains to see by eye: the result line in the window showing the
  route and bytes, and the dev pair through `npm run shells`.
- **Orphans.** A crash between writing and removing a package, or a removal that
  fails, leaves one inert, uniquely named `.gpxpkg` that is never offered again.
  There is no sweeper.
- **Residual staleness** between the locality read and the publish, which are two
  connections. An engine restarted from co-located to LAN in that window is
  refused by name; one restarted the other way is published chunked, with
  verified, identical content.
- **The asset plane is unauthenticated** and binds loopback. The locality read is
  readable by any local process. Phase 14 must authenticate the plane, this read
  included, before it is exposed beyond loopback (invariant 55).
- **Folder agreement** holds by construction only when the host and the Editor
  share one user's cache root. Under different accounts the result is a named
  refusal, never a mis-route.
- **The "LAN" worker** is a loopback worker started with `--lan`, not a second
  machine.
- **Jev and Laya were not run** on this row's acceptance; their environments are
  not installed on this machine (see 5.12). The design was decided with both on
  8 Nov (`design-jev-laya.json`).

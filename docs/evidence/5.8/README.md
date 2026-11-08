# 5.8, done 8 November 2026 (Claude)

**Row (Needs 5.5, 5.9):** L0 asset handoff by local path (ADR-001's co-located
asset plane).

**Done-when:**

- A co-located engine accepts a published package by local path. It re-hashes
  every asset before use, and refuses by name a path outside the package
  directory or a hash mismatch.
- The publisher chooses path or chunked upload from the declared locality,
  through one negotiation function.
- A conformance test publishes the same package both ways, and the engine
  prepares identical scenes.

## User decisions (8 Nov)

- **The Editor's publish is not part of this row.** The Editor publishes from
  its content store and never builds a package. Wiring it up is the new row
  5.10, "Editor publishes by path when co-located" (Needs 5.8).
- **A co-located publisher is configured with the engine's package
  directory.** Nothing new goes on the wire or into `EngineCapability`.
- **Done, with the check-then-open window noted** (see "Known gap" below).

## Design, asked of both models (`design-jev-laya.json`)

| Question | Jev | Laya | Taken |
|---|---|---|---|
| The package directory | engine-configured (1.0) | engine-configured (0.60) | agreed: `--package-dir` |
| How the publisher learns it | caller-configured (0.82) | a capability field (0.51) | the user: caller-configured |
| How bytes reach preparation | the same in-memory route as chunked (1.0) | lazy disk reads at take (0.53) | in memory: lazy reads break 5.9's rule that the engine never reads a mutable path later |
| Home of the negotiation | asset-plane (1.0) | control-plane (0.41) | asset-plane, following media-plane's `profile_for` precedent; asset-plane already depends on contracts, where `Locality` lives |
| Is the Editor in scope? | no (0.15) | yes (0.87) | the user: no, row 5.10 |
| Evidence of identical scenes | hash and frames (0.91) | hash only (0.51) | hash and frames: stronger, and cheap |
| Is the proposal sound? | 0.82 | 0.93 | agreed |

## What was built

- **Contract.** Three new refusals:
  - `PackageDirectoryNotConfigured`
  - `PackagePathOutsideDirectory`
  - `PackageUnreadable`

  Each has its Display text and code name, and is driven in the refusal
  audit. TS was regenerated.
- **`Shared/asset-plane/src/handoff.rs`:**
  - `handoff_for(locality)` returns `LocalPath` or `ChunkedUpload`. It is the
    one negotiation function, the asset plane's counterpart of
    `gx_media_plane::negotiate`.
  - `open_package_in(directory, path)` is the engine side. It resolves the
    path with links followed and refuses it outside the directory. A missing
    path that climbs out with `..` is refused the same way, so the answer does
    not reveal whether a file outside exists. It then calls `read_package`,
    which re-hashes every member against the manifest. Then `packaged_scene`
    re-hashes every declared asset against the scene's content hash.
  - `publish_package(asset_addr, declared_locality, package)` is the one
    publisher function. By path it sends the absolute path, and no asset byte
    crosses the plane. By chunked upload it reads and verifies the package,
    sends only the missing bytes (5.9), then publishes. The raw by-path client
    is crate-private, so no caller can pick a route by hand.
- **The asset port** takes `{package: {path}}`. The package is read and
  verified without the peer lock. Its assets go to the same
  `accept_verified_asset`, and its scene to the same `publish_scene`, as the
  chunked route. The engine keeps no path. A refusal comes back as
  `PublishRefusal::PackageRefused { cause }`.
- **The engine.** `AssetPublishPeer::package_directory` (default `None`).
  `Engine::set_package_directory`. The worker takes `--package-dir DIR`; it
  must be an existing directory or the worker will not start. The mock has a
  matching `with_package_directory`.
- **Boundary rule R9.** `Shared/asset-plane/` may match on `Locality`, as
  media-plane may. Every other consumer still may not. There is a new
  boundary test for this.

## Executed

- `cargo run -p gx-conformance`: 543 passed, 0 failed, 9 skipped. The new peer
  section, "real render engines, co-located with a package directory and LAN
  (5.8)", runs two real `gx-render-worker` processes. Each publication goes
  through `publish_package` with the locality that worker declared over the
  wire.
  - PASS "the two workers declare co-located and LAN localities over the
    wire".
  - PASS "one package publishes by local path and by chunked upload":
    - by path: `LocalPath`, 0 asset bytes on the plane;
    - chunked: `ChunkedUpload`, exactly the Inter font's bytes.
  - PASS "both routes publish the same revision and content hash".
  - PASS "the engine prepares identical scenes by either route:
    byte-identical frames". Frames 0, 50 and 100 render to the same image hash
    on each worker, and the PNGs fetched from each asset plane are
    byte-identical.
  - PASS "a co-located engine refuses a package path outside its package
    directory by name": `PackagePathOutsideDirectory`.
  - PASS "a co-located engine refuses a package whose asset bytes do not match
    their hash by name": `AssetHashMismatch`.
  - PASS "an engine without a package directory refuses a package path by
    name": the LAN worker answers `PackageDirectoryNotConfigured`.
  - The refusal audit drives all three new refusals.
- **Mutation check.** With the directory check and the declared-hash check
  removed, both refusal checks FAIL against the real worker, because the
  packages were published. The code was then restored byte-identical.
- `cargo test -p gx-asset-plane handoff`: 6 pass.
  - the locality mapping;
  - both handoffs deliver the same scene and bytes to in-process peers;
  - with no directory, the path is refused;
  - outside paths are refused `PackagePathOutsideDirectory`: absolute,
    climbing with `..`, and missing outside;
  - a missing path inside is refused `PackageUnreadable`;
  - a package with a substituted member is refused `PackageFileHashMismatch`,
    naming the member;
  - a scene that names other bytes is refused `AssetHashMismatch`.
- `node --test tools/tests/check-boundaries.test.mjs`: 19 pass.
- **Acceptance, asked of both models** (`acceptance-jev-laya.json`):
  - done: Jev 0.86, Laya 0.57;
  - identical scenes shown: Jev 0.97, Laya 0.89;
  - the window blocks done: Jev 0.16, Laya 0.90. The user decided: done, with
    the window noted.

## Known gap (tracked)

A file swapped for a link between the directory check and the open is not
re-checked on the open handle. The bytes are still verified against the
package's own manifest and the scene's declared hashes before use, and nothing
read is sent back to the publisher. Closing the window fully on Windows needs
calls beyond Rust's std, such as checking the final path of the opened handle.
It is tracked as a hardening follow-up.

## Not in this row

- The Editor publishing by path when co-located (5.10).

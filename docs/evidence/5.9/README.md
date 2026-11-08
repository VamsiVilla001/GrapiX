# 5.9, done 8 November 2026 (Claude)

**Row (new, user decision of 8 Nov; Needs 5.3):** Published assets reach the
engine. The 5.3 transfer is wired into the engine's asset plane and into the
Editor's publish.

**Done-when:**

- The Editor's publish sends every asset the scene declares through preflight
  and the 5.3 transfer, on the same asset-plane address, before the scene. The
  bytes are re-hash checked from the Editor's store.
- The real engine keeps the verified bytes.
- A conformance test against the real worker shows a scene with a font and an
  image asset:
  - refused `AssetMissing` when published alone;
  - its assets transferred;
  - then published and taken to Program.
- An image object is refused by name until 3.17 draws images.
- A re-publish moves no bytes.

## The gap it closes

This was found while scoping 5.8.

- The real worker's asset port took only the scene document and served fetches
  of rendered images.
- The only code that handed asset bytes to the engine was in tests
  (`record_verified_asset_bytes`).
- The Editor's publish sent the scene alone.
- 5.3's transfer dialect was tested at the plane level and used by nothing.

So any published graphic with text or an image was refused `AssetMissing` by
the real engine. Jev and Laya both recommended a new row before 5.8 and called
it urgent (`plan-jev-laya.json`). The user chose that. 5.3 stays done with a
note, by user decision. Jev called it not breached (0.45); Laya called it
breached (0.96).

## Design, asked of both models (`design-jev-laya.json`)

| Question | Jev | Laya | Taken |
|---|---|---|---|
| Where the engine accepts the transfer | the existing asset port | the control plane (0.45) | the asset port: ADR-001 keeps content off the control plane |
| Where verified bytes go | a receiver trait; the engine keeps them in memory | the engine loads them from disk (0.06) | in memory: the engine never reads a mutable path |
| Publisher order | transfer, then publish | publish, then transfer (0.19) | transfer first: the engine prepares at publication and would refuse `AssetMissing` |

## What was built

- **Shared/asset-plane:**
  - The transfer handler is generic over where verified bytes go. The on-disk
    `AssetStore` works as before, and an `AssetPublishPeer` keeps them in
    memory.
  - The publish port tells a transfer frame by its `request` tag and serves
    the transfer dialect on that connection. A publisher needs one address.
  - `AssetPublishPeer` gains `has_verified_asset` and `accept_verified_asset`.
    A peer that keeps no bytes refuses by name.
- **The engine and the mock** implement both, through
  `record_verified_asset_bytes`.
- **Editor shell:**
  - `scene_asset_bytes(scene, store)` reads and re-hashes each declared
    asset, refusing `AssetMissing` or `AssetHashMismatch` by name.
  - `publish_with_assets` transfers, then publishes.
  - `cmd_publish` uses it.

## Executed

- `cargo test -p gx-asset-plane`: 76 pass, 5.3's tests unchanged.
- `cargo run -p gx-conformance`, against the real worker: 533 passed, 0 failed,
  9 skipped.
  - PASS "a scene's assets reach the engine before the scene". Published
    alone, the scene is refused `PreparationRefused { AssetMissing }`. The
    first transfer reports both assets missing and moves exactly the font plus
    PNG bytes.
  - PASS "a scene with a font and an image publishes and goes to Program". It
    is taken on this T0 machine. A sub-T0 engine records a named skip for the
    take.
  - PASS "an image object over a delivered image asset is refused by name
    until 3.17": `ObjectKindNotDrawable`, kind image, owner 3.17.
  - PASS "re-publishing moves no asset bytes the engine already holds": 0
    missing, 0 bytes.
- `cargo test -p gx-editor-shell --test publish`: 3 pass, none skipped.
  `a_scene_with_a_font_publishes_with_its_assets_to_a_real_engine` runs the
  Editor's own path:
  - the lower third published alone is refused "asset missing";
  - `scene_asset_bytes` reads its Inter font from the Editor store;
  - `publish_with_assets` publishes revision 1.
- Acceptance, asked of both models (`acceptance-jev-laya.json`): done (Jev
  0.88, Laya 0.96). Both judged the image clause honest (0.97 / 0.98): delivery
  is this row's, and drawing is 3.17's.

## Not in this row

- Drawing an image object on the GPU (3.17).
- Handing assets to a co-located engine by local path (5.8, which now Needs
  5.9).

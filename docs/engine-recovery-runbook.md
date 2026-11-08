# Render engine recovery (3.12, 5.11)

The render worker keeps a durable journal so that a forced process kill does
not lose the state of the current programme. This document is the operator
procedure for dealing with a journal that cannot be loaded.

## What the journal contains

A single file, written atomically (write-to-temporary then rename), at:

```
<platform service data root>/render-engine/recovery.json
```

Beside it, named after it (5.11):

```
recovery.json.assets/<sha256>      the engine's own store of verified asset bytes
recovery.json.dropped.json         the scenes the last restore that dropped any dropped
```

A worker started with `--recovery-journal PATH` uses `PATH`, `PATH.assets`
and `PATH.dropped.json`.

The location is derived from `gx_contracts::platform::service_data_root()`,
which resolves to the per-user data directory the operating system provides
(`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
`~/.local/share` on Linux).

The journal holds:

| Field | Meaning |
|---|---|
| `schemaVersion` | An integer. Only version 3 is understood. |
| `epoch` | The incarnation that wrote this state. |
| `published` | Map of take id to the revision that is live, and the content hash it pins. |
| `preparedScenes` | The scene documents behind those published revisions. |
| `verifiedAssets` | Content hashes whose verified bytes are in the store beside the journal. |
| `cued` | The next programme state, if one was cued. |
| `program` | The current programme state, if a take was active. |
| `revisionFloors` | Optional (5.11). For each take a restore dropped, its last revision, so publishing it again continues from there. |

The prepared raster data (tessellated paths, shaped glyphs, decoded meshes)
is deliberately **not** in the journal. It is rebuilt from the stored scene
document and verified asset bytes on every restore, so a stale preparation
can never bypass validation.

The asset bytes are not in the journal either. Every asset the engine
accepts, by chunked upload or by package path, is written to
`recovery.json.assets` before the publication is acknowledged. At restore,
every asset each journaled scene declares is read back from the store and
re-hashed before the scene is prepared; `verifiedAssets` is not trusted for
this. The package a scene was published from is never read again.

## Normal operation

The worker opens the journal at startup. If it exists and validates, the
engine restores into an **output-inhibited** state: it remembers what was on
Programme, but it will not emit pixels until the host sends a fresh
`ConfigureOutput` message. This prevents a recovered engine from accidentally
driving an output with stale configuration.

If the journal does not exist, the worker starts with an empty state at
epoch 1. This is the expected path on first boot.

### A restored scene was dropped (5.11)

**Symptom.** The worker starts, at the next epoch and output-inhibited, and
writes to stderr:

```
recovery: 2 journaled scene(s) dropped; re-publish them
recovery: dropped scene show/name/3 (pin <hash>): assetMissing: asset missing: <hash>
recovery: dropped scene show/score/1 (pin <hash>): assetHashMismatch: ...; it was cued, now clear
recovery: every dropped scene is listed in <journal path>.dropped.json
```

A Cue, Take or Render of a dropped take is refused with the same reason
(`AssetMissing`, `AssetHashMismatch` or `AssetStoreFailed`) until the take is
published again. `gx-engine-host` does not keep a running worker's stderr, so
`recovery.json.dropped.json` is where every dropped scene is named. It holds
the latest restore that dropped anything, with its epoch.

**Cause.** A stored asset was removed, altered or could not be read. Every
scene declaring it is dropped; scenes whose bytes are intact are restored. A
journal written before 5.11 has no store, so its scenes with assets are
dropped this way on the first start after the upgrade. If Program or the cue
named a dropped scene, it is cleared; otherwise it survives.

**Action.**

1. Read `recovery.json.dropped.json` (or the stderr lines).
2. Re-publish each dropped scene from the Editor. Its assets are sent again,
   which also repairs an altered store entry, and its revision continues from
   the dropped one (never reused).
3. Re-cue or re-take as needed, then send `ConfigureOutput` to re-arm output.

A scene whose bytes are intact but which can no longer be prepared (for
example after a capability change) still stops the restore, as before 5.11:
the worker refuses to start and leaves the journal untouched. Use the
corrupt-journal procedure below.

### The asset store cannot be written (5.11)

**Symptom.** A publication is refused `AssetStoreFailed` naming the asset's
hash: by package path as `PackageRefused`, by chunked upload as the
transfer's refusal. The detail names the operating-system cause, never a
path.

**Action.** Check disk space and permissions on the directory beside the
journal (`recovery.json.assets`), then publish again. Nothing was kept, so
nothing needs cleaning up.

The store only grows in 5.11: files of dropped scenes and assets no scene
uses stay until the store is cleaned (a follow-up).

## Failure modes and operator actions

### Journal is corrupt or has the wrong schema version

**Symptom.** The worker refuses to start; the error names
`RecoveryError::UnsupportedSchema` or `RecoveryError::InvalidState`.

**Cause.** The file was partially written, manually edited, or written by a
newer version of the software.

**Action.**

1. Stop the render worker.
2. Rename the corrupt journal (do not delete it):
   ```sh
   mv <journal path> <journal path>.corrupt
   ```
3. Restart the worker. It will create a fresh journal at epoch 1.
4. Re-publish and re-take any scenes that were on air.

The `.corrupt` file can be inspected if the cause is unclear. It is JSON.

### Journal write fails at runtime

**Symptom.** A publish or control-plane mutation (cue, take, clear) returns
`EngineReply::Refused(Refusal::TransportFailed)` with the detail
`recovery journal write failed: …`. The engine also sets output-inhibited.

**Cause.** The filesystem is full, read-only, or the journal directory was
removed while the worker was running.

**Action.**

1. Check disk space and permissions on the service data root.
2. If the directory was removed, restart the worker. It will recreate the
   journal from scratch.
3. After the filesystem is healthy, any subsequent successful mutation will
   write a new complete state. The engine remains output-inhibited until
   `ConfigureOutput` re-arms the output adapter.

### Epoch exhaustion

**Symptom.** `RecoveryError::EpochExhausted` on startup.

**Cause.** The epoch counter (`u64`) wrapped. This requires approximately
5 × 10¹⁸ worker restarts and is not expected in practice.

**Action.** Delete the journal file. The worker starts at epoch 1 with an
empty state.

## What is never acceptable

- Do not edit the journal by hand while the worker is running.
- Do not copy a journal from one machine to another as a configuration
  migration mechanism. The journal is a crash-recovery tool, not a backup.
- Do not delete the journal while the worker is running and expect the
  worker to notice. It will fail on the next write attempt.

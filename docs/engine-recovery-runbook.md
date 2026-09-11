# Render engine recovery (3.12)

The render worker keeps a durable journal so that a forced process kill does
not lose the state of the current programme. This document is the operator
procedure for dealing with a journal that cannot be loaded.

## What the journal contains

A single file, written atomically (write-to-temporary then rename), at:

```
<platform service data root>/render-engine/recovery.json
```

The location is derived from `gx_contracts::platform::service_data_root()`,
which resolves to the per-user data directory the operating system provides
(`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
`~/.local/share` on Linux).

The journal holds:

| Field | Meaning |
|---|---|
| `schemaVersion` | An integer. Only version 1 is understood. |
| `epoch` | The incarnation that wrote this state. |
| `published` | Map of take id to the revision that is live. |
| `preparedScenes` | The scene documents behind those published revisions. |
| `verifiedAssets` | Content hashes the asset plane had confirmed. |
| `cued` | The next programme state, if one was cued. |
| `program` | The current programme state, if a take was active. |

The prepared raster data (tessellated paths, shaped glyphs, decoded meshes)
is deliberately **not** in the journal. It is rebuilt from the stored scene
document and verified asset bytes on every restore, so a stale preparation
can never bypass validation.

## Normal operation

The worker opens the journal at startup. If it exists and validates, the
engine restores into an **output-inhibited** state: it remembers what was on
Programme, but it will not emit pixels until the host sends a fresh
`ConfigureOutput` message. This prevents a recovered engine from accidentally
driving an output with stale configuration.

If the journal does not exist, the worker starts with an empty state at
epoch 1. This is the expected path on first boot.

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

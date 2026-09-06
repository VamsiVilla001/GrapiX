# GrapiX runtime adapter — AE-A0 spike

Phase **AE-A0** of [`../../docs/ae-runtime-container-phase-plan.md`](../../docs/ae-runtime-container-phase-plan.md).
Result record: [`certification/AE-A0-result.json`](certification/AE-A0-result.json).

This is the kill experiment, not a product runtime. It answers one question the existing one-shot
`afterfx.exe -r` bridge cannot: **can a GrapiX-owned component stay resident inside a licensed After
Effects, accept a bounded command while AE stays open, and perform supported control work with no panel
click and no remote script endpoint?**

On this machine, against After Effects 2026 (26.3), the answer is yes, and the lifecycle around it is now
closed too: **29 of 30** launch → command → shutdown cycles passed with no stalls and no restarts, in 30
distinct After Effects processes, leaving the fixture byte-identical. The thirtieth failed on the graceful
quit and the next cycle recovered — one `WM_CLOSE` is not always enough, so the stop path needs a bounded
retry. See `certification/AE-A0-result.json` for the evidence and the caveats, and
`certification/AE-A0-cycles-*.log` for the per-cycle record.

## What it is

- An AEGP plugin (`GrapiXRuntimeAdapter.aex`) that registers an idle hook and a death hook.
- A closed verb set: `ping`, `list`, `read`, `set`, `probe`, `dirty`, `discard`, `checkout`,
  `fixture`, `fixture-control`. Adding a verb is a deliberate edit. `open` remains as a **refusal**:
  project changes are supervisor-owned restarts (finding F2), so nothing here calls
  `AEGP_OpenProjectFromPath` on the idle hook.
- A command channel that is a **file in this user's own `%LOCALAPPDATA%\GrapiX\ae-adapter\`**. There is
  no socket and nothing listening, so nothing off this machine can reach it. AE-A1 replaces this with an
  authenticated same-user named pipe and a versioned envelope.
- Every After Effects suite call runs on AE's own callback thread, inside the idle hook.

## The pixel path (AE-F0)

`checkout` renders one composition frame through AE's own render path and describes it — geometry, world
type, stride, thread, timing, and alpha statistics computed over the buffer:

```sh
./send.sh checkout 0 0                        # comp 0, frame 0, 8-bit, premul-black, bgra
./send.sh checkout 0 0 8  premul-black argb   # the configuration you should actually use
./send.sh checkout 0 0 32 straight     argb
./send.sh fixture "D:\path\alpha-probe.aep"   # author the alpha probe and save it
```

Two rules, both measured (`certification/AE-F0-checkout.json`):

- **Request `argb`, then swizzle yourself.** AE's world is natively ARGB. Asking for `bgra` makes
  consecutive checkouts of one unchanged frame alternate between BGRA and ARGB layout — the flip follows
  the call count, not the request. Correct pixels on odd calls, channel-swapped on even ones.
- **`premul-black` is the mode that matches After Effects.** Mapped ARGB→RGBA it is byte-for-byte
  identical to what AE's own Render Queue writes, which is premultiplied despite the TIFF declaring
  `ExtraSamples = unspecified`.

References come from `aerender`, never from this path — see `references/export-references.sh` and
`references/pixel-digest.mjs`, which digests *pixels* rather than files because AE embeds per-render XMP
metadata that changes the file hash while the pixels stay identical.

BO0a's adversarial edge gate is `npm run certify:ae-runtime-fixtures`. Its pinned fixture isolates
opaque, zero-alpha, hard, antialiased, 50% gradient, coloured translucent shadow and
premultiplied-black edge vectors. The command exports independent Render Queue references first,
then compares named `premul-black` and `straight` checkouts at zero tolerance. The fixture authoring
verb is explicit maintenance, not part of certification:

```sh
./send.sh fixture "D:\path\bo0a-alpha-edges.aep" edge-corpus
./send.sh fixture "D:\path\lower-third.aep" lower-third
./send.sh fixture-control 1 21 SCORE 317
```

`fixture-control` is a BO0a harness route, not the AE-CD1 product service. It resolves the pinned
composition item and layer IDs and accepts only `PLAYER_NAME`, `SCORE`, `PLAYER_IMAGE` and `TEAM_COLOR`.
The production route remains gated on authenticated declared controls, canonical target resolution,
revisioned application, validated project-store media and dependency preflight.

## What it is deliberately not

- Not a scripting endpoint. No `eval`, no script text, no shell, no caller-supplied filesystem path.
- Not a transport. `checkout` reads a frame and writes it beside the channel for comparison; there is no
  ring, no shared memory and no wire. That is AE-F1.
- Not a product surface. No menu item, no panel, no UI.

## Build

Requires the vendored Adobe SDK (gitignored, never redistributed), MSVC and the Windows SDK.

```sh
./build.sh            # cl → PiPLtool → rc → link, into build/GrapiXRuntimeAdapter.aex
./install.sh          # copies into the AE Plug-ins folder; needs an elevated shell
```

Override `GRAPIX_AE_SDK_ROOT`, `GRAPIX_MSVC_ROOT`, `GRAPIX_WINKIT_ROOT`, `GRAPIX_WINKIT_VERSION` or
`GRAPIX_AE_ROOT` if your installs differ. The build script names every tool path it uses rather than
relying on a developer prompt, so a failure says which prerequisite is missing.

## Harnesses that need no After Effects

Two adapter invariants are load-bearing and cannot be observed by staring at the code, so each has a
standalone harness that links the real implementation and runs without a licensed host. Both are shell
scripts rather than npm scripts because they need MSVC, not Node.

```sh
./run-frame-ring-harness.sh            # AE-F1: 100,000 max-frame cycles through every ring slot
./run-revision-rollback-harness.sh     # AE-CD2: the write/rollback sequence under injected faults
```

`run-revision-rollback-harness.sh` links `src/revision_apply.cpp` — the same sequencing
`runtime_apply_data_revision` uses in production — and includes no SDK header at all. It proves the
parts that are pure bookkeeping: writes run forward, already-written members are restored in **reverse**
and exactly once, a failing restore does not abandon the remaining ones, the original write's failure
code survives the rollback's own report, and any restore failure degrades the outcome to a mixed state
rather than a clean rollback. It exits non-zero when an invariant breaks — verified by reversing the
restore order on purpose, which fails six of its ten cases.

**What neither harness claims.** They measure the sequence, not After Effects. `AE-CD2`'s remaining gate
is a *live* trigger: proving a real stream can validate in phase 2 and then refuse
`AEGP_SetStreamValue` in phase 3. Phase 2 is deliberately thorough — every kind is gated on a cheap total
query before a stream is acquired — so on the pinned fixture nothing validated can fail its write. That
is why `GRAPIX_AE_RUNTIME_FAULT_INJECT_REVISION_WRITE=<index>` exists: it forces the Nth write of the next
revision to fail, once, so the restore path runs against real AE values and the read-back is real. It is
one-shot, and while armed the HELLO fingerprint reports `faultInjection`, which
`compare-lower-third.mjs` refuses to record evidence against. An injected run is a **measurement of the
recovery path**, never a certification of the product.

## Evaluating one real AE frame into the ring (AE-F2a's live gate)

This procedure has been executed on this host; `certification/AE-F2a-live-frame.json` records the run.
The install step is no longer a manual detour: `install.sh` tries an unelevated copy, hands the copy to
a UAC prompt when Program Files refuses it, and then **verifies the installed hash** — a stale `.aex`
still answers on the pipe, at the old protocol major, which is a much later and more confusing failure
than a refused copy.

```sh
# 1. Build (works from git-bash; the default `bash` on PATH is WSL and cannot see MSVC)
"C:/Program Files/Git/bin/bash.exe" ae-plugin/runtime-adapter/build.sh

# 2. Install — self-elevates, then proves the installed file matches what was just built
./install.sh

# 3. Launch and reach a commandable state (not merely a running process — see finding F3)
./supervise.sh start "<repo>\tools\certification\ae-runtime-fixtures\v1\fixtures\lower-third.aep"

# 4. Evaluate one frame and publish it into the ring.
#    `checkout … ring <renderRequestId> <dataRevision> <frameId> <presentationDeadlineNanos>`
#    Frame 1 of LOWER_THIRD is 800/23976 in the composition's own scale (PL1's measured clock), and
#    at its true 2997/100 rate frame 1's deadline is 33366700 ns.
./send.sh checkout LOWER_THIRD 1 ring live-1 0 1 33366700

# 5. Quit without ever saving, then read the evidence
./supervise.sh quit
cat "$LOCALAPPDATA/GrapiX/ae-adapter/result.json"
```

**What a pass looks like.** The reply reports the observed world type, geometry and stride; a
`RENDER_READY` event carries `renderRequestId`, `compositionItemId`, the evaluated time in the
composition's own scale, `dataRevision`, `frameId` and `presentationDeadlineNanos`; and the ring's
`ready_depth` moves. A 16- or 32-bit world, or an alpha mode other than premultiplied, must be
**refused** rather than relabelled — that refusal is a pass too, and a silent conversion is the only real
failure.

**Two things to check before believing a green run.** The fingerprint's `faultInjection` must be `null`
(an armed adapter is not evidence), and the observed channel order must be the one the descriptor
reports: finding C4 measured BGRA and ARGB alternating by *call count*, so repeat the checkout an odd and
an even number of times before trusting the layout.

## Drive it

`supervise.sh` owns the lifecycle. It launches After Effects, answers the startup dialogs, waits for a
real command round-trip, and stops AE without ever saving:

```sh
./supervise.sh start "D:\path\to\project.aep"   # launch → clear dialogs → ready (owned pid N)
./supervise.sh attach                           # what is running, and what may be done to it
./supervise.sh quit                             # dirty → discard → clean exit, no prompt
./supervise.sh cycle 30 "D:\path\to\project.aep"
```

Then drive the adapter directly:

```sh
./send.sh ping
./send.sh list
./send.sh probe 0 16 opacity
./send.sh read  0 16 opacity
./send.sh set   0 16 opacity 42.5
./send.sh dirty
./send.sh discard
```

`send.sh` keeps a monotonic sequence beside the channel so a stale command file is never replayed.
Results land in `%LOCALAPPDATA%\GrapiX\ae-adapter\result.json`, and every dispatch is appended to
`log.txt` in the same folder.

Two rules the harness enforces, both learned the hard way:

- **Ready means a command came back.** Not a PID, not a window title, not the adapter's load marker — a
  commandable AE here had no editor window at all, and the load marker lives in the reply slot, so the
  first successful command overwrites it.
- **Never force-kill After Effects.** A kill invalidates AE's plugin cache and arms the crash dialog, so
  the next start inherits a modal chain. `quit` exists to prevent that, not merely to be tidy.

## Changing projects (AE-A3's restart lifecycle)

The adapter has **no** project-lifecycle command. `OPEN_PROJECT` and `CLOSE_PROJECT` refuse
`OPERATION_UNSUPPORTED` at the pipe, and `send.sh open` refuses too: finding F2 makes
`AEGP_OpenProjectFromPath` unusable on the idle hook, so a project change is a **new After Effects
process**, owned by Playout's supervisor.

```sh
# Pipe-level: the removed surface refuses, and HEALTH reports the project AE actually has open.
GRAPIX_AE_RUNTIME_SESSION_ID=... GRAPIX_AE_RUNTIME_TOKEN=... node runtime-lifecycle-smoke.mjs

# End-to-end through the production supervisor: launch project A, refuse both removed operations,
# replace the process with project B, prove identity from AE, shut down. Writes its own evidence.
node ../../Playout/services/playout-control/tests/ae-restart-live.mjs \
  "<repo>/tools/certification/ae-runtime-fixtures/v1/fixtures/lower-third.aep" \
  "<repo>/tools/certification/ae-runtime-fixtures/v1/fixtures/bo0a-alpha-edges.aep" \
  certification/AE-A3-restart-lifecycle.json
```

**Run the dialog clearer beside it.** The supervisor does not answer AE's startup modals, and its own
stop is a `TerminateProcess` that arms crash repair for the next launch — so an unattended restart run
on a dialog-queuing host sits at `ENOENT` on the pipe for the whole window and looks like a broken
adapter. During the recorded run this loop ran alongside:

```sh
while :; do powershell -NoProfile -File ae-window.ps1 -Action clear-dialogs; sleep 3; done
```

**What a pass looks like.** Two different PIDs, each reporting its own project through
`HEALTH.projectPath` (`AEGP_GetProjectPath`), both removed operations refused **with the host still
commandable afterwards**, the replacement project answering `LIST_COMPOSITIONS`, and a shutdown that
reaches `stopped` with no error. The declared `.aep` digest is never the proof — only AE's answer is.

## Findings that change the design

| # | Finding | Where it lands |
| --- | --- | --- |
| F1 | AE queues modal dialogs across startup and its **idle loop does not run until they are answered**, so the adapter loads while no command can reach it. They are `#32770` shells holding one `DroverLord` pane: no automatable controls, usually **empty window text**, sometimes **never painted at all**, and deaf to synthetic keystrokes. Found by window class and answered with `WM_CLOSE` per handle, they clear — and `WM_CLOSE` takes each one's non-destructive default, proven by this adapter still loading after a chain containing Crash Repair Options was cleared. | AE-A2 supervisor |
| F2 | `AEGP_OpenProjectFromPath` from the idle hook returned success and then idle callbacks stopped. Project lifecycle does not belong on the idle path — **or in the adapter at all**: it is removed from runtime protocol v2 and replaced by supervisor-owned process restarts, proven live in `certification/AE-A3-restart-lifecycle.json`. | AE-A1, AE-A3 |
| F3 | The idle hook is not a scheduler; it fires only once AE is idle. | AE-F0, AE-F2 |
| F4 | `AEGP_GetUniqueStreamID` returned 0 for layer transform streams, so stable identity cannot rest on it. | AE-A3 |
| F5 | Installing into the Plug-ins folder needs elevation. `install.sh` self-elevates through an `-EncodedCommand` UAC child and verifies the installed hash, because a stale `.aex` still answers on the pipe at the old protocol major. | packaging |
| F6 | AE 2026 converts an older project on open and marks it dirty. Never save; author fixtures on the profile under test. | BO0a |
| F7 | Force-killing AE invalidates its plugin cache and arms the crash dialog, so the *next* start inherits a modal chain. The graceful quit is what keeps unattended starts working. | AE-A2 |
| F8 | `AEGP_NewProject` discards a dirty project with **no save prompt** and leaves the idle channel alive — the clean-shutdown primitive, because the save prompt is unanswerable. | AE-A1, AE-A2 |
| F9 | The death hook fires on a graceful quit and never on a kill. | AE-A2 |
| F10 | The file channel carries **no process identity** — a second AE with this adapter installed answers on it — so every reply stamps `hostPid` and lifecycle authority rests on a launch-time claim. | AE-A1, AE-A2 |
| F11 | A fully commandable AE can have **no editor window** (`MainWindowHandle == 0`). Readiness is a channel fact. | AE-A2 |
| F12 | A host with broken third-party plugins (a Resolume DXV install here) raises a load-failure modal on every cold plugin scan. Host provisioning is a prerequisite, not a detail. | AE-A2 |

## Licence posture

This directory is GrapiX source. It calls the After Effects SDK and copies no Adobe sample code. The SDK
is read from `vendor/adobe/` at build time, is gitignored, and nothing from it ships in any artefact
except the PiPL blob this build generates. Conditions in
[`../../docs/ae-runtime-licensing-decision-request.md`](../../docs/ae-runtime-licensing-decision-request.md)
§9.2 apply — in particular: no external distribution before **L1**, and the customer-facing product name
must not carry an Adobe mark or the abbreviation "AE".

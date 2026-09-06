# Importing an After Effects composition

How a `.aep` composition becomes an editable GrapiX scene, what each part of that is working around,
and why the obvious implementation of each step was wrong.

This is a record of defects that were found by running the importer against two real production
projects — `BG Project.aep` (18 compositions, 65 footage items, 3.9 GB) and `DYno_Format.aep`
(245 compositions, 383 footage items, 68.9 MB project file) — not a description of an intended
design. Every symptom below was observed, and every fix is verified against those projects.

---

## 1. The project is a folder the operator named

**Symptom.** Scenes had nowhere legitimate to live. They were written into the service's own data
root — a per-user AppData path — which an operator never opens, cannot hand to anyone, and which a
reinstall wipes. Collected footage had the same problem.

**Cause.** There was no "project" concept. The Editor had a data root and nothing else.

**Fix.** A project is a directory the operator chose, marked by a `.gpx` file at its root and laid
out one folder per asset class, the way XPression and Viz Artist do it:

```
BMSD Show/
  BMSD Show.gpx        ← the project file: manifest, version, settings
  Scenes/
  Assets/
    AEP/               ← footage collected out of an After Effects project
    Images/  Videos/  Audio/  Fonts/  Models/
  Packages/  Autosaves/  Backups/
```

The `.gpx` is found by extension, not by a fixed name, so the file carries the project's own name
and a folder of projects stays readable. Opening a directory that already holds one adopts it: the
project id, name and creation date survive.

**Consequences that are deliberate:**

- **Save asks first.** The first save in a session with no project opens a *save* dialog, not a
  folder picker — the operator types a project name, and the folder layout is created around the
  file they named. Cancelling cancels the save; it never writes the work somewhere else.
- **Autosave is off.** Until a project has a location there is nowhere for a background write to
  go, so saving is an explicit act. Every autosave mechanism is still present and still gated on
  `preferences.autosave.enabled`; turning it back on is a one-line change.

---

## 2. A root-relative URI resolves under every allowlisted root

**Symptom.** `ENOENT: no such file or directory, stat '…\ae-projects\BG Project\BG Project.aep'`
on every project the panel listed. The panel could enumerate projects it could not then read.

**Cause.** `resolveAeProjectUri` walked the allowlisted roots and returned the first one the URI was
*within*. A project URI is root-relative, so it is "within" every root — the first one always won.
The installation provisions an empty `…/ae-projects` root and lists it first, so every project
resolved to a path inside an empty directory.

**Fix.** `resolveExistingAeProjectUri` stats each candidate and returns the root that actually holds
the file. Six call sites use it; the one remaining synchronous caller does nothing but an allowlist
check and never touches the file.

**The trap this set.** The first fix left `createAeRuntimeContainer` on the synchronous resolver,
reasoning that a *create* has nothing to find yet. That was wrong in a way worth naming: the
container's sidecar is new, but the **project it is declared against must already exist** — the
next line hashes it. The symptom moved from "ENOENT" to "After Effects project was not found".

> **Rule.** Any caller that goes on to touch the file must use the existence-aware resolver. Only a
> pure allowlist check may use the synchronous one.

---

## 3. Three copies of the service bundle

**Symptom.** The fix above was verified, deployed and still did not take effect in the running app.

**Cause.** The desktop shell does not run the repository's `dist/`. It loads
`grapix-api-server.mjs` from whichever of these it finds first:

| Copy | Who writes it |
|---|---|
| `Editor/services/project-api/dist/bundle/` | `npm run build` |
| `…/desktop-tauri/src-tauri/target/release/services/` | `tauri build` |
| `C:\Program Files\GrapiX\services\` | the installer |

Rebuilding the first updates neither of the others. Worse, orphaned `node.exe` service processes
outlived their parent shell and kept port 4100, so a freshly launched Editor talked to the *old*
service.

**Fix / operational rule.** After changing the service, deploy to all three and confirm no orphan
holds the port. The frontend is compiled *into* `app.exe` (`frontendDist`), so UI changes need a
full `tauri build` — a bundle copy will never carry them.

---

## 4. Precomps imported as empty groups — "layers but no keyframes"

**Symptom.** A 35-layer composition imported as 35 objects, most of them empty groups, and the
Timeline showed no keyframes at all.

**Cause.** A `precomp` layer was converted to `{ type: "group", childIds: [] }` and the composition
it points at was never read. In `points distribution` the keyframes do not live on the top-level
layers — they live inside `8st`, `Point box`, `Points 8` and their descendants.

**Fix.** Recursive expansion, bounded to 8 levels, plus replication of the AE parent chain
(`layer.parentIndex`) into `childIds`. Keyframe times inside a precomp are shifted by
`parentTimeOffset + layer.startTime` so they land on the composition's own clock.

**Measured on `points distribution`:** 35 objects → **326**, 0 keyframed objects → **18**,
Timeline 0 rows → **361**.

---

## 5. Only four animatable streams were mapped

**Symptom.** Layers that visibly animate in After Effects imported with no channels.

**Cause.** `expandStream` matched exactly `opacity`, `position`, `scale`, `rotation`. After Effects
also emits `positionX/Y/Z` when dimensions are separated, `rotateX/rotateY/rotateZ`, `orientation`
and `anchorPoint`. Anything else fell through to `default:` and produced nothing.

**Fix.** All of those are mapped, with AE's units converted: opacity and scale are percentages,
GrapiX uses 0–1 and a multiplier. `hold` keeps its step; `bezier` maps to the nearest named curve
because the scene channel does not carry AE's tangents.

---

## 6. Photoshop footage — the missing-texture grid

**Symptom.** Every image layer drew a magenta "missing texture" placeholder.

**Cause, in two layers.** First, footage was referenced by a project-relative path with nothing in
`scene.assets`, so the renderer fetched a path the dev server answered with HTML. Registering the
file fixed that for PNGs and immediately exposed the real problem: **54 of 65 footage items in the
reference project are layers of a single layered `.psd`**, and no browser decodes a `.psd`. The
asset resolved, downloaded, and still could not be drawn.

**What After Effects actually does.** Importing a layered PSD does not hand the renderer the PSD. AE
creates **one footage item per Photoshop layer**, each carrying that layer's own pixels and its own
bounds, and the composition positions those items. Reproducing the import means reproducing that.

**Fix.** `psdLayerCatalog.ts` reads the `.psd` once with `ag-psd`, and for every top-level layer
emits a PNG at the layer's own rectangle. A group with no stored composite has its children drawn
into a canvas rather than being reported as missing. Each layer is registered as its own asset and
served from `/api/assets/<id>/content`.

### Matching a footage item to a Photoshop layer

This is the part with no obvious answer, and the data decided it:

- The footage item's **name is useless** — AE names them `Footage 7192`.
- The AE **layer name matches the Photoshop layer name exactly** for every referenced layer.
- Footage ids ascend in Photoshop document order, in whole-PSD runs. `points distribution.psd` has
  28 layers and the project declares **56** items for it — AE imported it twice.

So resolution is layered, and the order matters:

1. **AE layer name → Photoshop layer name.** Exact, and it is what AE itself preserves.
2. **Ordinal within the run** (`rank % layerCount`) — used when a name is ambiguous. This PSD has
   two layers called `Group 2` and two called `Group 2 copy`, so duplicated names are deliberately
   *not* registered as keys; a name that maps to two rectangles cannot say which one was meant.
3. Fall back to the file itself, and report it.

> Getting this precedence backwards is a silent failure. When the id key was consulted first, the
> ordinal guess overrode the exact name match and `Artwork 9` (146×123) came back as the Background
> plate (1920×1080) — resolved, decodable, and wrong.

---

## 7. Object bounds were the composition frame

**Symptom.** Imported layers were positioned wrongly and stretched across the canvas.

**Cause.** Every object was given `width`/`height` of the composition. An AE layer's `position` is
the world position of its **anchor**, and `anchorPoint` is expressed in the footage's own
coordinates — so a layer anchored at (73, 61) only lands correctly if the object is 146×123.
Substituting 1920×1080 misplaces the anchor and scales the image to the frame.

**Fix.** Footage resolution carries intrinsic size — from the PSD layer's rectangle, or by decoding
the image header — and the object takes that. `objectFit` is `stretch`, not `contain`: the surface
is already the footage's own size, so the image must map onto it one-to-one.

**Measured:** every checked layer now matches Photoshop exactly — `Artwork 9` 146×123,
`BGMI_New logo_B&W&C-02` 165×111, `Rectangle 5` 2192×1288, `ChatGPT Image…` 2005×1129.

An earlier version used `0.01×0.01` placeholders, which imported every layer as an invisible dot
with a correct position — indistinguishable from "the import did nothing".

---

## 8. Collection must be per-composition and streamed

**Constraints measured on `BG Project.aep`:** 9 unique files, **3.87 GB**, dominated by one
**3.66 GB** `.mov`. One composition needs between 0.6 MB and 3.7 GB of that.

- **Per-composition closure**, not per-project — `resolveCompositionClosure` already answers what a
  composition reaches through its whole precomp tree.
- **Streamed copies.** `importAssetBuffer` takes a `Buffer`; a 3.66 GB file would exceed Node's
  buffer ceiling. `pipeline(createReadStream, createWriteStream)` copies in constant memory. Video
  and anything over 96 MB is never buffered — the scene points at the streamed copy.
- **Deduplicated by size + mtime + name**, not by content hash: hashing means a second full read of
  every gigabyte to answer what those three already answer.
- **Reference counted.** One `.psd` backs 54 footage items. Removing an import releases its claim
  and deletes only files nothing else draws. Removal touches the project's own copies under
  `Assets/AEP` and can never reach the source `.aep` or its `(Footage)` folder.

Measured: second import of an overlapping composition copied **0 bytes** and reused 3 files in 4 ms.

---

## 9. Import is one removable unit

Every imported composition is wrapped in a single group, `ae-import-<importId>`, carrying the
composition id in `importedDesign.raw`. Removing it deletes that subtree and releases the import's
claim on collected footage. Verified: removing one of two overlapping imports deleted only the file
the other did not use, and left the source project untouched.

Import goes to a new scene or into the open one; both are offered on each composition row.

---

## Known limits

- **Video frames are not decoded.** A video layer imports with correct timing and transform but no
  texture; it keeps the project-relative path. 1 of 85 image objects in the reference composition.
- **A few layers parse with degraded scale/opacity.** The manifest's contract is percent
  (`scale: [100,100,100]`); a handful of layers arrive as 0–1. The converter honours the documented
  contract rather than guessing per layer.
- **Expressions are not translated.** Baked keyframes import; the expression is reported.
- **Adjustment layers, cameras and lights** import as empty groups — they keep their place and
  timing in the tree, and draw nothing, because GrapiX has no layer-level equivalent.

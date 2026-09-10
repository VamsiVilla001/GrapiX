# GrapiX — Cross-Platform Foundations and MCP Automation Schema

Companion to the distributed architecture ADRs. Covers the platform
basics that must be right before feature work, and the MCP schema that
makes the application fully automatable by any LLM.

| | |
|---|---|
| **Status** | **Final draft — accepted 10 September 2026.** Authoritative for what is to be built; says nothing about what is built. Implementation status lives in `/memory.md` and uses the vocabulary in `docs/README.md`. |
| **Date** | 9 September 2026 |
| **Scope** | Editor on Windows + macOS. Engine anywhere; Program certification target is Windows. |
| **Resolution ceiling** | 1920×1080, progressive only. Stepped: 1080p now, 4K next, larger later. |
| **Decided** | Design engine **per workstation**. Shared render pool only when asked for. |
| **Also covers** | UI research plan (Part F); design system and motion library handoff (Part G) |
| **Supersedes** | The standalone *GrapiX — Design System and Motion Library Handoff* of 9 September 2026, absorbed here as Part G. Do not work from that copy. |

---

# Part A — Platform matrix

## A.1 Renderers

| Layer | Windows | macOS |
|---|---|---|
| Engine graphics API | **D3D12** (wgpu default) or Vulkan | **Metal** |
| Editor webview | **WebView2** (Chromium) | **WKWebView** (WebKit) |
| Browser renderer | Three.js on WebGL2 | Three.js on WebGL2 |
| WebGPU in webview | Available | Safari 26+ — **verify on target OS versions** |

**Two webview engines, not three** — that's the payoff of dropping Linux
from scope. It also makes the WASM fallback more viable than it would have
been, because WebKitGTK was the weak link.

**Action:** a one-page WebGPU capability probe on both platforms, run
early. It decides whether the WASM fallback is real.

## A.2 Codecs

| Need | Windows | macOS |
|---|---|---|
| Decode (video tier) | **NVDEC** via FFmpeg hwaccel; Quick Sync fallback; Media Foundation | **VideoToolbox** |
| Encode (recording, remote media plane) | **NVENC** | **VideoToolbox** |
| Interchange | H.264, HEVC | H.264, HEVC, **ProRes** (native, expected by broadcast) |

**Design rule:** one `VideoDecoder` / `VideoEncoder` trait in the engine,
two backends behind it. Never let platform codec choice leak into scene
logic or the control plane.

**Licensing, decide before code:** FFmpeg's LGPL vs GPL build matters —
GPL is likely incompatible with distribution. H.264/HEVC carry patent-pool
obligations. ProRes *encode* requires Apple licensing; decode does not.
This is the same class of gate as the Adobe decision and should be raised
at the same time.

## A.3 Vendor I/O SDKs

| SDK | Windows | macOS | Notes |
|---|---|---|---|
| **DeckLink** (Blackmagic Desktop Video) | Yes, COM-based | Yes, Thunderbolt devices | Cross-platform SDK. Program certification stays Windows. |
| **AJA NTV2** | Yes | Yes | Same posture. |
| **NDI** | Yes | Yes | Dynamically loaded; never bundled. Already the shape in use. |
| **Virtual / recording / null** | Yes | Yes | Pure engine, no SDK, no platform code. |

**Critical:** every vendor SDK is C++ in your address space. Wrap thin at
the FFI boundary via `ash`/`cxx`, keep it out of scene logic, and consider
a sidecar for the crash-prone ones. Memory safety in the Program process
is the property being protected.

**On macOS SDI:** technically possible with Thunderbolt DeckLink. Do not
make it a certification target — it doubles the soak and certification
surface for a configuration no facility runs.

---

## A.4 Fonts — carried forward unchanged

**The Font Manager and the whole font handling path come across from the
existing GrapiX as-is.** It is one of the few subsystems already recorded
as Implemented end to end, it is genuinely ahead of the reference product,
and there is no platform reason to touch it. Port it; don't redesign it.

| Capability | Carried forward |
|---|---|
| Formats | OTF, TTF, WOFF, WOFF2 |
| Sources | Local files, Google Fonts, CSS imports, Adobe Fonts, direct HTTPS URL |
| Storage | Checksum dedupe, fonts packaged as project assets |
| Resolution | Package-first resolution |
| Shaping | Native **cosmic-text** with fallback, bidi and OpenType features |
| UI | Font Manager panel, unchanged |

**Why it survives the cross-platform move intact:** shaping is done by
cosmic-text, not by the OS. Windows DirectWrite and macOS CoreText resolve
system fonts differently and apply different fallback chains — but that
never reaches the render path, because fonts are packaged and shaping is
ours. This is the same property that makes the browser and native paths
agree, and it is worth protecting deliberately.

**The one rule to enforce:** nothing that reaches air may depend on a
system-installed font. A missing font is a **refusal at preflight**, not a
silent fallback to whatever the machine happens to have. Both platforms
will happily substitute something plausible; that is exactly the class of
silent difference the architecture forbids everywhere else.

**One gate worth raising early, in the same conversation as codecs and
Adobe:** font licences frequently restrict embedding and redistribution,
and Adobe Fonts terms generally do not permit extracting font files at
all. Packaging a font into a `.gpxpkg` that ships to a render server is
redistribution. Linked sources may need to resolve at the render node
rather than travel inside the package — which is a licensing decision, not
an engineering one.

---

# Part B — The traps that will actually bite

These are the ones that pass code review and fail a pixel gate.

## B.1 Colour space — the highest-risk item on this page

| Concern | Windows | macOS |
|---|---|---|
| Desktop colour management | Not by default | **ColorSync, always on** |
| Consequence | Texture displays "raw" | Texture is transformed before display |

The same asset will look different on the two platforms unless managed.
And broadcast wants **Rec.709 / BT.1886**, not sRGB — different transfer
function, and a designer approving on an sRGB monitor is approving the
wrong thing.

**Rules:**

- **Render internally in linear.** Always.
- **Tag every texture with its source colour space** at import. Never
  infer it.
- **Two output transforms:** sRGB for preview surfaces, Rec.709/BT.1886
  for broadcast output. Selected by output adapter, not by platform.
- Three.js: `SRGBColorSpace` on textures, explicit `outputColorSpace`.
- wgpu: `Rgba8UnormSrgb` vs `Rgba8Unorm` — these must agree with what
  Three.js does, or the pixel gate fails for reasons nobody can find.
- **Put a colour ramp in the reference scene set.** A gamma mismatch is
  invisible on typical content and obvious on a ramp.

## B.2 Pixel ratio and DPI

| | Windows | macOS |
|---|---|---|
| Scale factors | Fractional: 100–300%, any step | 1× or 2× only |
| Awareness | Per-Monitor v2, must be declared | Automatic |
| Change events | On monitor move, on setting change | On monitor move |

**The rule that prevents most bugs: the scene document is in scene
coordinates. DPI affects display only, never the document.** A 1920×1080
scene is 1920×1080 whatever monitor it is on.

- Canvas backing store = CSS size × `devicePixelRatio`. Recompute on
  `ScaleFactorChanged`, don't cache it at startup.
- Hit tolerances in scene units, not device pixels — the same rule already
  argued for the timeline in frames rather than pixels.
- Test on a fractional-scaled Windows monitor. 125% and 150% are where
  rounding errors appear, and they are the most common real settings.

## B.3 File and directory handling

| Concern | Windows | macOS | Risk |
|---|---|---|---|
| Case sensitivity | Insensitive | Insensitive by default (APFS), **can be sensitive** | A scene referencing `Logo.png` and a file named `logo.png` works — until Linux CI or a case-sensitive volume |
| Path length | 260 default, long-path opt-in | ~1024 | Deep project folders + content hashes overflow silently |
| Illegal characters | `< > : " / \ | ? *`, trailing dots and spaces | `:` and `/` | Asset names from Figma or PSD frequently contain these |
| Reserved names | `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` | None | A layer named "AUX" becomes an unwriteable file |
| Unicode normalisation | Preserved as given | APFS normalisation-insensitive | Accented filenames round-trip differently between platforms |
| Atomic rename | Fails under handle contention | Reliable | **This is already a recorded bug** — the AE package builder and user store both hit it |

**Rules:**

- **Sanitise on import, once.** Asset display name and on-disk name are
  separate fields. Never derive the filename from user text at write time.
- **Canonicalise and compare case-insensitively; preserve case for
  display.**
- **Normalise Unicode to NFC on write.** Pick one, apply it everywhere.
- **Use content hashes for on-disk names in the store**, project-relative
  paths only in the library. The two-address model already in place solves
  most of this — apply it consistently.
- **Atomic write helper, one implementation.** Unique temp name per write,
  fsync, rename with retry-on-contention, directory fsync. The two current
  races are the same bug twice; fix it once, in one place.

**Directory conventions** — use the `directories` crate, never hardcode:

| Purpose | Windows | macOS |
|---|---|---|
| Service data | `%APPDATA%\GrapiX` | `~/Library/Application Support/GrapiX` |
| Cache, asset store | `%LOCALAPPDATA%\GrapiX` | `~/Library/Caches/GrapiX` |
| Logs | `%LOCALAPPDATA%\GrapiX\logs` | `~/Library/Logs/GrapiX` |
| Project folder | Operator-chosen, anywhere | Operator-chosen, anywhere |

**Fix the current default:** the service data root defaults to a folder
inside the repository. That is a development convenience that must not
ship.

**File watching:** `notify` crate. FSEvents and `ReadDirectoryChangesW`
coalesce differently — debounce in your code, don't rely on platform
behaviour.

---

# Part C — Resolution and rate policy

**Ceiling: 1920×1080, progressive only.** State it as a supported tier and
refuse everything else by name.

| Resolution | Rates (rational, num/den) |
|---|---|
| 1920×1080p | 60/1, **60000/1001** (59.94), 50/1, 30/1, **30000/1001** (29.97), 25/1, 24/1, **24000/1001** (23.976) |
| 1280×720p | Same set |

- **Rates are always rational.** Never a float, never a hardcoded constant.
  This is already the model — extend it to the output configuration.
- **Interlaced is refused**, by name, with "not implemented" as the reason.
  1080i50 and 1080i59.94 are what facilities will ask for; better an
  explicit refusal than a wrong field order.
- **Square pixels only** (1:1 PAR). Non-square is SD-era and out of scope.
- **Safe areas per EBU R95.** Configurable, displayed in the Editor,
  checkable by the validator — which matters more once templates are
  generated rather than hand-placed.
**Step the ladder, don't jump it.** 1080p now, 4K next, larger formats
after that. Each tier is added only once the one below it is certified,
so the soak and certification surface grows one step at a time rather
than all at once.

| Tier | Status | Adds |
|---|---|---|
| **1** | Now | 1080p and 720p, progressive, square pixels |
| **2** | Next | UHD 3840×2160 — memory budget, tiling above the texture limit, higher output bandwidth |
| **3** | Later | Larger canvases and video-wall formats |

Nothing in tiers 2 or 3 should shape a decision made today beyond one
rule: **output resolution and rate are configuration, never constants.**
Keep them out of scene logic, shaders and the control plane, and moving up
the ladder stays a configuration change.

---

# Part D — MCP automation schema

The goal: **any LLM can read and write every part of the application**,
without bespoke prompt engineering per model.

## D.1 Five principles

**1. Resource-oriented, stable IDs.** Everything addressable —
`scene:0142`, `object:0142/text-3`, `material:std-a91f`,
`take:107`, `binding:0142/score-home`.

**2. Capability discovery, not guessing.** One tool returns every
supported enum: blend modes, fit modes, object types, easing curves,
resolutions, rates, output adapters, device tier. An agent that must guess
`overlay` is supported will generate broken scenes forever. An agent that
can *ask* will not.

**3. Structured refusals, not prose.** The refusal contract is what makes
the agent loop work — but only if it is machine-parseable.

```json
{ "ok": false,
  "refusal": { "code": "UNSUPPORTED_BLEND_MODE",
               "field": "objects[3].material.blend",
               "given": "overlay",
               "supported": ["normal","add","multiply","screen","darken","lighten"],
               "hint": "closest_supported: screen (visually different)" } }
```

The `supported` array is what turns a failure into a successful retry.

**4. Optimistic concurrency and atomic batches.** Every write takes
`if_revision` and returns the new revision. A batch is one transaction and
**one undo entry** — matching existing multi-select behaviour.

**5. The agent can see.** `render.preview` returns an actual frame. This
is the differentiator; nothing built on a design tool's API can do it.

## D.2 Tool surface

| Group | Read | Write | Notes |
|---|---|---|---|
| `system` | capability, version, device tier, build hash | — | Always call first |
| `project` | open, list, tree | create, settings | |
| `scenes` | get, list, search | create, duplicate, delete, rename, resize | |
| `objects` | get, list, hierarchy, bounds | create, update, delete, reparent, reorder | Full property surface |
| `materials` | get, list, usage | create, update, assign, relink | Per-object, per-face, per-glTF-element |
| `assets` | list, resolve, metadata | import, replace, delete | Content-hash addressed |
| `fonts` | list, resolve | add, link | |
| `animation` | channels, keys, curves | set-key, remove-key, tangents, **apply-preset** | Preset is the motion-library hook |
| `bindings` | list, schema | create, update, delete | Data-driven templates |
| `validate` | preflight, design-system diff | — | Returns structured refusals |
| `render` | **preview(scene, frame) → image**, thumbnail | — | The feedback loop |
| `packages` | list, inspect, verify | build, publish | Returns Take ID + revision |
| `playout` | library, rundown, status | cue, take, continue, clear | **Scope-gated** |
| `outputs` | list, status, reference lock | configure, enable | **Scope-gated, `is_live` applies** |

## D.3 Scopes map to existing roles

| Role | Grants |
|---|---|
| `author` | Everything under project, scenes, objects, materials, assets, fonts, animation, bindings, validate, render, packages |
| `operator` | Read across the above, plus playout and outputs |
| `admin` | Both |

**A design-scope token must never reach `playout.take` or
`outputs.configure`.** The automation pipeline runs as `author`. It
publishes drafts; a human takes them to air. That is also the honest
answer to "who signs off" — until a template class graduates, nobody
automated does.

## D.4 The agent loop this enables

```
system.capability          → what is supported, no guessing
validate.design_system     → constraints as data
scenes.create              → new scene
objects.create × N         → assemble  ┐
materials.assign           →           ├ one batch, one undo entry
animation.apply_preset     → motion    ┘
render.preview             → SEE IT
  └─ critique → objects.update → render.preview  (loop)
validate.preflight         → structured refusals → fix → retry
packages.publish           → draft with Take ID
```

Two things make this work that are already yours: refusals name what is
supported, and the model can look at its own output.

## D.5 Schema hygiene

- **One source of truth.** Rust types generate both the TS client and the
  MCP JSON Schema. No hand-mirrored declarations — that drift is already a
  recorded problem.
- **Version the tool surface** alongside protocol v3. An agent should be
  able to ask what schema version it is talking to.
- **Every tool description states its refusal codes.** The model reads
  descriptions; put the contract where it will be read.
- **Idempotency keys on writes**, so a retried call after a timeout does
  not duplicate an object.

---

# Part E — Definition of done for the platform layer

Before feature work is called complete on a clean branch:

1. [ ] Editor builds, signs and notarises on Windows and macOS; installers produced by CI on both
2. [ ] WebGPU capability probe run on both target OS versions, result recorded
3. [ ] Colour-managed pipeline: linear internal, tagged textures, sRGB and Rec.709 output transforms, colour ramp in the reference scene set
4. [ ] Pixel gate passes identically on both platforms — this is what proves item 3
5. [ ] DPI: correct at 100%, 125%, 150%, 200%; survives a monitor move; survives a scale-factor change at runtime
6. [ ] Filenames: sanitiser with a test corpus of hostile names — reserved words, illegal characters, trailing dots, accented characters, >260 char paths
7. [ ] One atomic-write helper, used everywhere; both known races closed
8. [ ] Service data root uses OS conventions; the in-repo default is gone
9. [ ] Output tier: 1080p and 720p at all eight rational rates; interlaced refused by name
10. [ ] Virtual, recording and null adapters work on both platforms
11. [ ] DeckLink and NDI compile behind feature flags on both; certification remains Windows-only and **External gate**
12. [ ] MCP: capability discovery, structured refusals, `if_revision` on every write, batch-as-one-undo, `render.preview` returning a real frame
13. [ ] MCP scopes enforced — an `author` token is refused on `playout.take` and `outputs.configure`
14. [ ] Font Manager ported unchanged; all sources resolve on both platforms; packaged fonts shape identically on Windows and macOS
15. [ ] A missing font is refused at preflight by name — never substituted from system fonts
16. [ ] UI built against the design-constraints document produced by Part F — density scale, chrome value range, reserved accent, type scale at control-room viewing distance
17. [ ] Design reviewed against the Part F anti-pattern list before merge
18. [ ] Token schema — including motion tokens and the preset format — lands in shared contracts before any consumer reads it
19. [ ] Design-system violations refused at preflight with `allowed` values, identically for human-authored and generated scenes
20. [ ] Every published package stamped with the design-system version it was authored against
21. [ ] Motion presets resolve identically at 25, 50, 59.94 and 23.976; resolved frame count recorded on each instance
22. [ ] A preset with no `out` phase is refused

**The two items that will consume the most time and are most often
underestimated: colour management (3, 4) and filename handling (6).**
Neither is difficult; both are broad, and both fail quietly.

---

# Part F — UI research plan

The UI is being redesigned from scratch on the clean branch. It must work
for two very different users in two very different rooms, and it must not
read as generic. This plan makes those decisions on evidence and produces
constraints engineering can build against.

**Duration:** 5 weeks to synthesis. **Baseline:** the live Editor and
Playout captures of 3 September 2026.

## F.1 Decisions this research must inform

1. **Density and information hierarchy** — how much can be on screen
   before it stops being scannable under deadline?
2. **Chrome neutrality** — how dark, how desaturated, and what does that
   cost in legibility?
3. **Interaction model** — keyboard-first, direct manipulation, or both,
   and where each dominates.
4. **Two products or one language?** Editor and Playout have different
   users, rooms and stakes. Do they share a design language or diverge
   deliberately?
5. **What must never move.** Which controls are muscle memory and must
   stay put across releases.

---

## F.2 Decoding "must not look AI made"

This is a real brief, but it isn't researchable as stated. What people
mean by it is usually a specific set of tells. Naming them makes them
testable — and gives the design something to be measured against.

| The tell | What it signals | What professional tools do instead |
|---|---|---|
| Uniform rounded corners, soft shadows everywhere | Component-library defaults, untouched | Sharp or minimal radii; depth from value, not shadow |
| Saturated accent gradients (violet, teal-to-blue) | Decoration with no meaning | One accent, reserved for state that matters |
| Generous padding, low density | Designed for a marketing page | High density; every pixel earns its place |
| Decorative empty-state illustrations | Consumer onboarding patterns | Empty states state a fact and stop |
| Explaining the obvious in helper text | The tool doesn't trust its user | Terse labels; the tool assumes competence |
| Everything the same visual weight | No hierarchy was decided | Strong hierarchy; most chrome recedes |
| Emoji or icon-as-decoration | Filler | Icons are functional, custom, consistent |

**The positive framing, and the one to test against:** it should look like
a tool that someone who does this job every day chose to use — closer to
Resolve, Nuke, Ableton or XPression than to a SaaS dashboard.

**And one domain constraint that is functional, not aesthetic:** in a
graphics application, UI chrome must not bias the operator's judgement of
the content. That is why grading suites and NLEs are neutral dark grey.
Colour in the chrome competes with colour in the scene. This connects
directly to the colour-management work — a saturated UI undermines the
Rec.709 pipeline it surrounds.

---

## F.3 Participants

Two distinct users. Do not merge them.

| Segment | n | Recruit from | Why |
|---|---|---|---|
| **Broadcast/esports designers** | 5–6 | Tesseract productions; freelancers on tournament packs | Primary Editor users. Deep tool comparisons available. |
| **Playout operators / TDs** | 4–5 | Control room staff on live tournaments | Different room, different stakes, different failure cost. |
| **Producers / show callers** | 2–3 | Same productions | They don't use it, but they define the deadline pressure that shapes it. |

**Screening priority:** people who have used XPression, Viz, Chyron or
Singular under live conditions. Their comparisons are the most valuable
data in the study, and their muscle memory is a hard constraint.

**Include at least two macOS-primary designers.** Platform habits differ,
and the Editor now ships on both.

---

## F.4 Methods and sequence

| Wk | Method | n | Produces |
|---|---|---|---|
| 1 | **Artifact teardown** — structured analysis of XPression, Viz Artist, Resolve, Nuke, Ableton, Singular | — | A vocabulary of density, chrome and control conventions. Do this first so interviews can reference real screens. |
| 1–2 | **Contextual interviews** — in the design suite and the control room, not on a call | 9–11 | Workflow, pressure points, what they look at and when |
| 2 | **Card sort** — panel and function grouping | 15+ | Information architecture for the workspace |
| 3 | **Usability test on the current build** | 6–8 | Baseline against the September captures |
| 4 | **Concept reaction** — 3 divergent visual directions | 8–10 | Which reads as professional, and specifically why |
| 5 | Synthesis | — | Themes, constraints, tokens |

**Why contextual, not remote.** Control room lighting, monitor
calibration, viewing distance and how many screens someone is scanning are
all design inputs you cannot get over a video call. A UI that tests well
on a designer's calibrated display can be unreadable in a dim gallery.

---

## F.5 Interview guide

### Warm-up (5 min)
Role, shows worked, tools used. Not a design conversation yet.

### Context (10 min)
- Walk me through the last template pack you built, start to on-air.
- Where were you sitting, what was on your screens, who else was involved?
- What time pressure were you under?
- Which tool did you use, and what would you have used given the choice?

### Deep dive — designers (20 min)
- Show me your workspace layout. Why is it arranged that way?
- What do you look at most? What do you never look at?
- Which shortcuts are muscle memory?
- Last time the tool got in your way — what happened?
- When you're checking a scene before publish, what do you check, in what
  order?
- What do you have to check on a second monitor because the tool won't
  show it?

### Deep dive — operators (20 min)
- Walk me through the ten seconds before a take.
- What must be visible without looking for it?
- What has gone wrong on air, and what did the UI show you at the time?
- How do you know the system is healthy? What do you glance at?
- What would you want to be *impossible* to do by accident?

### Reaction (10 min)
Show real screens: the current GrapiX build, XPression, a grading tool, a
generic SaaS dashboard, unlabelled.

- Which of these looks like it was made by people who do your job?
- What specifically gives you that impression?
- Which would you trust with a live show? Why?
- Anything here that looks unserious?

### Wrap-up (5 min)
What haven't I asked about? Who else should I talk to?

---

## F.6 Usability test tasks

Test against the current build to get a baseline. Concrete tasks, timed,
think-aloud.

**Designer**
1. Build a lower third from a supplied brand pack: text, logo, background.
2. Animate it on and off.
3. Fix a scene that fails preflight (seed a refusal — an unsupported blend
   mode).
4. Publish it to Playout and confirm it is ready.
5. A producer changes the sponsor logo. Update and republish.

**Operator**
6. Find and cue take ID 107.
7. Take it to air, then clear.
8. Build a running order of five takes and step through it.
9. Something is wrong — the engine is disconnected. What do you do?

**Measure:** completion, time, errors, hesitation points, where the eye
goes first, and every moment someone asks "did that work?"

Task 9 matters most. It tests whether system state is legible under
stress, which is the failure that costs a show.

---

## F.7 Concept reaction — three directions

Deliberately divergent, so the reaction is informative rather than polite.

| | Direction | Bet |
|---|---|---|
| **A** | **Instrument** — very dark, near-monochrome, high density, custom controls, one accent for live state | Maximum content neutrality, control-room ready |
| **B** | **Studio** — mid-dark, more spatial separation, clearer panel edges, warmer neutrals | Legibility in mixed lighting; easier for new users |
| **C** | **Editorial** — lighter surfaces in the Editor, dark in Playout; deliberately different languages per product | Design suite and gallery are different rooms |

Present unbranded, in randomised order, on a calibrated display **and** on
an uncalibrated laptop. If a direction only works on good hardware, that
is a finding.

**Direct question to ask of each:** does this look like it was designed,
or generated? Then: what specifically makes you say that?

---

## F.8 Synthesis

- **Affinity mapping** across all sessions, tagged by segment — do not let
  designer needs drown out operator needs; there are fewer operators and
  their failures are more expensive.
- **Journey map** for the designer, brief to on-air, marking every moment
  of doubt.
- **Journey map** for the operator, ten seconds before a take.
- **Impact/effort matrix** for findings.
- **Jobs to be done**, stated per segment.

---

## F.9 Deliverables

1. **Synthesis report** — themes, insights, recommendations, per segment.
2. **Design constraints document** — the research output engineering
   builds against:
   - Density scale, with minimum touch and click targets
   - Colour: chrome value range, maximum chroma, the single reserved
     accent, and the state colours that may never be reused decoratively
   - Type scale and minimum legible size **at control-room viewing
     distance**, not at desk distance
   - What must be visible without interaction, per product
   - Keyboard model and the shortcuts that are muscle memory and must not
     move
3. **Anti-pattern list** — the specific tells from F.2 that this UI must
   never exhibit, written so a reviewer can check against it.
4. **Highlight reel** — quotes and clips, especially from task 9.

---

## F.10 Two risks worth naming now

**The research could be used to justify a redesign that was going to
happen anyway.** Guard against it: write down, before fieldwork, what
finding would make you *keep* something from the current build. If nothing
would, this is not research.

**"Doesn't look AI made" is a taste judgement wearing an objective
disguise.** F.2 converts it into testable properties and F.7 asks the
question directly — but the real check is whether practitioners who
weren't involved in the build reach for the design over the tool they use
today. That is the only version of this question that has an answer.

---

# Part G — Design system and motion library handoff

A project accepts a design system — palette, type, spacing **and motion** —
as a handoff, compiles it into enforceable constraints plus a design brief,
stores both in project memory, and makes every downstream actor, human or
LLM, work inside it.

**Plugs into:** Editor (ingest and panels), shared contracts (token and
preset schema), the scene validator (enforcement), the MCP surface in
Part D, and Gen-AI plan M7.2 (consumption). **Not required by the render
engine** — this is authoring-time.

## G.1 The distinction that decides whether this works

There are two very different things people mean by "give the AI our design
system," and only one of them holds up.

| | Design system as **context** | Design system as **constraint** |
|---|---|---|
| Lives in | The model's prompt | The validator |
| Enforced by | Hope | Refusal at preflight |
| Fails | Silently, gradually | Loudly, at publish |
| Catches a human doing it wrong | No | Yes |

**Build both, and make the second one authoritative.** Context alone
drifts — the model will violate the system, confidently, and nobody
catches it until a client does. Constraint alone is unusable, because most
of what a design system communicates isn't expressible as a rule.

The handoff therefore compiles into **three layers**:

| Layer | Content | Consumed by | Enforceable |
|---|---|---|---|
| **1 — Tokens** | Type scale, palette, spacing, radii, stroke weights, safe margins, logo clear-space, minimum legible sizes | Validator, Editor UI, generator | **Yes** |
| **1M — Motion library** | Motion tokens (durations, easings, stagger) and the presets composed from them | Validator, Editor, generator | **Yes** |
| **2 — Brief** | Hierarchy intent, voice, when to use what, motion character, what to avoid | LLM, and any designer reading it | No |
| **3 — Exemplars** | Approved scenes from this project, marked canonical | LLM as reference; designers as precedent | Partially — by diff |

Layer 3 is the underrated one. A handful of approved scenes teaches an
agent more than a page of adjectives, and you can diff against them.

**Layer 1M is where a brand's motion character actually lives**, and it is
the layer this application needs that a web design system does not. It is
specified in full in G.6.

---

## G.2 Ingestion

| Source | Route | Fidelity |
|---|---|---|
| **W3C Design Tokens JSON** | Direct import | Highest. The interchange format to prefer and to ask brand agencies for. |
| **Claude Design** | Export → tokens + brief | High |
| **Figma** | Existing Figma REST path — variables and published styles | High for tokens, partial for intent |
| **A webpage** | Fetch, read CSS custom properties and computed styles, infer scale | Medium. Good for palette and type; poor for rules. |
| **PDF brand guide** | Vision-model extraction into a draft token set | Low. Always a draft a human confirms. |

**Every ingest produces a review step.** The importer proposes a token set
and a brief; a human confirms or edits before it becomes version 1. Never
auto-accept — a wrong token set is worse than no token set, because
everything downstream trusts it.

**Report what could not be expressed.** Same discipline as scene import:
the ingest returns a structured list of things in the source that have no
token representation. That list is what tells you whether the format is
good enough, and it is the honest answer to "did it capture our brand?"

---

## G.3 Project memory

Stored with the project, on disk, as JSON — consistent with the rest of
the persistence model. No new store.

```
<project>/
  design-system/
    v3/
      tokens.json          layer 1 — enforceable
      brief.md             layer 2 — prose, read by the LLM
      exemplars/           layer 3 — canonical scene references
      provenance.json      source, hash, importer version, who confirmed
    current -> v3
```

**Versioned and immutable, like packages.** A new brand pack is v4, never
an edit to v3.

**Every published template records the design-system version it was
authored against.** That single field makes brand-pack drift findable:
when the system moves to v4, you can list every template still on v3 and
what specifically now violates.

This mirrors the immutable revision model already in use, so it needs no
new concepts — just a field.

---

## G.4 Enforcement

Design-system checks join the existing preflight, using the same
structured refusal shape the validator already returns.

```json
{ "ok": false,
  "refusal": { "code": "DESIGN_SYSTEM_VIOLATION",
               "rule": "type.scale",
               "field": "objects[2].text.size",
               "given": 23,
               "allowed": [18, 21, 24, 32, 48],
               "system": "v3",
               "severity": "error" } }
```

**Three severities, because not everything is a hard rule:**

| Severity | Behaviour |
|---|---|
| `error` | Publish refused. Palette outside the system, logo clear-space violated, text below minimum legible size. |
| `warning` | Publish allowed, recorded on the package. Off-scale spacing, unusual nesting. |
| `info` | Reported only. Deviation from an exemplar. |

**Overrides are allowed, and recorded with a reason.** A system that
cannot be overridden gets bypassed entirely, which is worse. And the
override log is signal in its own right: **the rules overridden most often
are the rules that are wrong.** Review them when the system versions.

---

## G.5 How the LLM uses it

The agent does not receive a design system as a wall of prose. It receives
tokens as data, the brief as guidance, exemplars as reference — and then
gets told, precisely, when it is wrong.

```
designsystem.get(project)        → tokens + brief + exemplar ids
system.capability()              → what the renderer supports
  ├─ intersect: what is BOTH permitted by brand AND renderable
scenes.create / objects.create   → assemble within that intersection
animation.apply_preset           → only presets whitelisted by the system
render.preview                   → see it
validate.preflight               → structured violations, with allowed values
  └─ fix → retry
packages.publish                 → draft, stamped with system version
```

Two properties make this work, and both already exist:

- **Refusals name what is allowed.** `allowed: [18, 21, 24, 32, 48]` turns
  a failure into a successful retry. This is the same reason the blend-mode
  refusal fix matters.
- **Capability discovery removes guessing.** The agent asks what the
  renderer supports and what the brand permits, and works in the overlap
  rather than inventing and being corrected.

**Motion is a library, not a description.** The agent selects a preset and
parameterises it; it never invents easing or keyframes. A brand ships its
own motion character the same way it ships its palette. See G.6.

---

## G.6 The motion library

A palette without a motion library is half a broadcast design system. This
is the part that has no equivalent in a web design system, and it is where
a brand is most often recognised — a lower third that slides differently
is a different brand, even in the right colours.

### G.6.1 Two levels, like every other token

**Motion tokens** are the primitives. **Presets** compose from them. A
preset that hardcodes a curve instead of referencing a token is a bug, for
the same reason a component hardcoding `#14D8A0` is.

```jsonc
// motion tokens
{ "duration": { "snap": 160, "fast": 240, "base": 400, "slow": 700 },   // ms
  "easing":   { "brand-in":  [0.16, 1.00, 0.30, 1.00],
                "brand-out": [0.70, 0.00, 0.84, 0.00],
                "hold":      "hold" },
  "stagger":  { "tight": 40, "base": 70, "loose": 120 } }               // ms
```

### G.6.2 Time is normalised; frames are resolved

**Presets store keys on a 0–1 normalised timeline.** Instantiation
resolves that against the scene's rational rate.

This matters more here than anywhere else in the system. A preset authored
at 50p must behave identically at 59.94 and 23.976 — and it will not if
keys are stored in frames. Author in milliseconds, resolve to whole
frames, round deterministically, and **record the resolved frame count on
the instance** so an operator can see that a 400 ms wipe became 20 frames
at 50p and 10 at 25p.

Never a float rate, never a hardcoded frame count. Same rule as everywhere
else.

### G.6.3 A preset is phased, not a single animation

Broadcast motion is not one clip. It maps onto the operator verbs the
system already has — **Cue, Take, Continue, Out, Clear** — and a preset
must describe each phase it participates in.

| Phase | Triggered by | Typical content |
|---|---|---|
| `in` | Take | Build on. Required. |
| `hold` | After `in` completes | Idle loop, or nothing. Must be safely interruptible at any frame. |
| `continue` | Continue | Staged builds — stat card revealing a second row. Zero or more. |
| `out` | Out | Build off. Required. |
| `update` | Data change while on air | How a bound value changes without a full re-take. Often overlooked, always needed. |

The `update` phase is the one that gets forgotten and then hurts: a score
changes mid-hold and the graphic must acknowledge it without re-animating
the whole card.

### G.6.4 Preset schema

```jsonc
{ "id": "lower-third/wipe-on",
  "applies_to": ["group", "text", "quad", "image"],
  "phases": {
    "in":  { "duration": "{duration.base}",
             "channels": [
               { "property": "position.x", "keys": [
                   { "t": 0.0, "v": -1.0, "out": "{easing.brand-in}" },
                   { "t": 1.0, "v":  0.0 } ] },
               { "property": "opacity",    "keys": [
                   { "t": 0.0, "v": 0 }, { "t": 0.35, "v": 1 } ] } ] },
    "out": { "duration": "{duration.fast}", "channels": [ /* ... */ ] }
  },
  "params": {
    "direction": { "type": "enum", "values": ["left","right"], "default": "left" },
    "duration":  { "type": "duration", "min": 160, "max": 900,
                   "default": "{duration.base}" },
    "stagger":   { "type": "duration", "default": "{stagger.base}" }
  },
  "stagger": { "mode": "cap-total", "max_total": 1200 }
}
```

`v: -1.0` is a normalised offset — one object-width — so the preset works
regardless of the object's size. **Presets are resolution- and
size-independent or they are not reusable.**

### G.6.5 Count-adaptive staggering

The one that breaks in production. A three-frame stagger across five
roster entries is 15 frames and feels crisp. Across twenty entries it is
60 frames and the graphic is late.

Every preset with a stagger declares a mode:

| Mode | Behaviour | Use |
|---|---|---|
| `fixed` | Constant interval, total grows with count | Small, known counts |
| `cap-total` | Interval compresses so total never exceeds `max_total` | **Default.** Rosters, brackets, standings |
| `overlap` | Fixed interval, items overlap more as count rises | Dense lists |

A preset used on a data-bound repeater without a stagger mode should be a
validator warning.

### G.6.6 Validation

Motion joins preflight with the same structured refusals:

- A preset referencing a property the renderer cannot animate → **error**
- A preset outside the system's whitelist → **error**
- A duration outside the preset's declared `min`/`max` → **error**
- A hand-authored animation where the system requires a preset → **warning**
- A `hold` phase that cannot be interrupted safely → **error**
- Missing `out` phase → **error**. A graphic that cannot leave is a defect.

That last one is worth stating plainly, because it is the failure that
reaches air.

### G.6.7 Authoring and provenance

Presets are **designer-authored, in GrapiX**, using the timeline and Speed
Graph that already exist. "Save selection as motion preset" captures the
channels, normalises the timebase, and prompts for parameters.

They version with the design system, immutably, and every scene records
which preset version it used. When a brand pack moves to v4 with a
retimed wipe, every template still on v3 is listable — the same mechanism
as the token version stamp.

**The model never authors a preset.** It selects and parameterises. That
boundary is what keeps generated motion broadcast-acceptable, and it is
the single most important rule in this document for the Gen-AI work.

---

## G.7 MCP surface — additions to Part D

These extend the tool surface in Part D; they do not replace it.

| Tool | Scope | Returns |
|---|---|---|
| `designsystem.get` | read | Current tokens, brief, exemplar ids, version |
| `designsystem.list_versions` | read | History with provenance |
| `designsystem.diff` | read | Scene or template vs the system — the same shape as preflight |
| `designsystem.exemplars` | read | Canonical scenes, fetchable via `scenes.get` |
| `motion.list_presets` | read | Presets with `applies_to`, phases, parameters and ranges |
| `motion.get_preset` | read | Full definition, for the agent to reason about before applying |
| `motion.save_preset` | **admin** | Capture a designer-authored selection as a new preset |
| `designsystem.import` | **admin** | Propose from a source; returns a draft plus an unexpressible list. Never auto-commits. |
| `designsystem.commit` | **admin** | Confirm a draft as a new version |

Import and commit are admin-scoped deliberately. An `author`-scoped agent
works *inside* the system and cannot change it — which is the whole point.

---

## G.8 In the Editor

- **A Design System panel** beside Font Manager and Material Manager, in
  the same idiom.
- **Tokens surface in the UI as the defaults**: the colour picker offers
  the palette first, the type control snaps to the scale, spacing controls
  step by the system's rhythm.
- **Live conformance indicator**, not a modal at publish. A designer
  should see drift as it happens.
- **Safe margins and clear-space guides come from tokens**, not from
  preferences.
- **A motion preset browser** next to the timeline, with live previews.
  Applying a preset writes real channels a designer can then adjust —
  adjusting past the preset's declared range is what raises the warning.
- **"Save selection as motion preset"** in the timeline, so the library
  grows from real work rather than a separate authoring exercise.

The point is that the system should be the path of least resistance, not a
gate at the end. Enforcement catches what slips through; defaults prevent
most of it.

---

## G.9 Risks

| Risk | Mitigation |
|---|---|
| Token set is wrong, everything downstream trusts it | Human confirmation before v1; unexpressible list surfaced at import |
| System too strict, blocks legitimate work | Three severities; overrides with recorded reasons; override log reviewed at version bump |
| The brief becomes a dumping ground nobody reads | Cap its length. If a rule matters, make it a token. |
| Brand-pack update orphans existing templates | Version stamp on every package makes drift listable, not invisible |
| Only the LLM respects the system; humans bypass it | Enforcement is at preflight, applied identically to human and generated scenes. Same gate, same refusal. |
| Motion library too small — everything looks the same | Track preset usage distribution. Heavy use of one preset, or heavy overriding, means the library needs extending. |
| Presets authored at one rate misbehave at another | Normalised 0–1 timebase; resolved frame count recorded on every instance |

---

## G.10 Sequencing

Slots into the existing plan without new prerequisites.

| Stage | Work |
|---|---|
| **With M1** | Token schema in the shared contracts package |
| **With M2** | W3C tokens JSON import; Design System panel; tokens as Editor defaults; **motion token schema and preset format in contracts** |
| **With M3** | Preflight enforcement with three severities; version stamp on packages; override logging; **preset browser, save-as-preset, phase validation** |
| **With M7.2** | Layer 2 brief and layer 3 exemplars wired into the generation loop; `designsystem.*` and `motion.*` MCP tools |
| **After M7.4** | Design-system conformance reported alongside zero-edit publish rate |

**The one thing to build first:** the token schema — including motion
tokens and the preset format — in contracts, before anything reads it.
Everything else (Editor defaults, validator rules, MCP tools, agent
context) is a consumer of that one definition.

**And the one rule to hold on to as the Gen-AI work starts:** the model
selects and parameterises presets. It never authors motion. That boundary
is what makes generated animation broadcast-acceptable, and it is far
easier to keep than to reinstate.

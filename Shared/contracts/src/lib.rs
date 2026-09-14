//! Core contract types shared by all four planes.
//!
//! Source of truth for the generated TypeScript (invariant 22). Nothing here
//! may reference a transport, a runtime or a product.

#![forbid(unsafe_code)]

pub mod animation;
pub mod authoring;
pub mod control;
pub mod auth;
pub mod color;
pub mod design_system;
pub mod enforce;
pub mod font;
pub mod import;
pub mod material;
pub mod mcp;
pub mod package;
pub mod platform;
pub mod phases;
pub mod scene;
pub mod text_style;
pub mod validate;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Wire protocol version. A mismatch is an error code, never a negotiation.
pub const PROTOCOL_VERSION: u32 = 3;

/// Stable identity of a published scene. Survives every republish.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct TakeId(pub String);

impl std::fmt::Display for TakeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Content address of asset bytes: SHA-256, lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct ContentHash(pub String);

impl std::fmt::Display for ContentHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Publish revision. Exact-match only: a take against a stale revision is
/// refused, never coerced (invariant 17).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Revision(pub u64);

impl Revision {
    /// The next revision after this one. Publishing is additive (invariant 30):
    /// a write produces a new revision, never edits an old one.
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// Optimistic-concurrency check (0.8): a write declares the revision it
    /// read, and is applied only if that is still current.
    ///
    /// On a match the write proceeds and yields the *next* revision, which the
    /// caller records as the new current. On a mismatch the conflict carries
    /// the revision that is actually current, so the caller re-reads and
    /// retries rather than overwriting someone else's work blind.
    pub fn check_write(&self, if_revision: Revision) -> Result<Revision, RevisionConflict> {
        if if_revision == *self {
            Ok(self.next())
        } else {
            Err(RevisionConflict {
                expected: if_revision,
                current: *self,
            })
        }
    }
}

/// A write attempted against a stale revision (0.8).
///
/// Carries the current revision, never just "conflict": the whole point of
/// optimistic concurrency is that the loser learns the state it must re-read,
/// so a retry can succeed instead of failing the same way again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevisionConflict {
    /// The revision the writer believed was current.
    pub expected: Revision,
    /// The revision that is actually current now.
    pub current: Revision,
}

impl std::fmt::Display for RevisionConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "revision conflict: wrote against {}, current is {}",
            self.expected.0, self.current.0
        )
    }
}
impl std::error::Error for RevisionConflict {}

/// Engine incarnation counter. Bumped on every engine start.
///
/// Reconnect reconciles by revision *and* epoch (ADR B.4): a matching revision
/// from a previous epoch means the engine restarted, and a client that ignores
/// the epoch would assume state it no longer has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Epoch(pub u64);

/// A frame rate as an exact rational. Never a float (invariant 12).
///
/// 29.97 is 30000/1001 and cannot be represented in binary floating point.
/// Accumulating a rounded rate across an 8-hour soak drifts the clock, so this
/// type deliberately offers no `f64` constructor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RationalRate {
    pub num: u32,
    pub den: u32,
}

impl RationalRate {
    pub const P25: Self = Self { num: 25, den: 1 };
    pub const P30: Self = Self { num: 30, den: 1 };
    pub const P50: Self = Self { num: 50, den: 1 };
    pub const P60: Self = Self { num: 60, den: 1 };
    /// Exactly 30000/1001.
    pub const P29_97: Self = Self {
        num: 30000,
        den: 1001,
    };
    /// Exactly 60000/1001.
    pub const P59_94: Self = Self {
        num: 60000,
        den: 1001,
    };

    /// Rejects a zero term rather than producing a rate that divides by zero
    /// somewhere further down.
    pub fn new(num: u32, den: u32) -> Result<Self, Refusal> {
        if num == 0 || den == 0 {
            return Err(Refusal::InvalidRate { num, den });
        }
        Ok(Self { num, den })
    }
}

/// Where the engine is relative to its clients. Declared in the capability
/// exchange; selects transport and media encoding (ADR-001, ADR-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum Locality {
    /// L0 : same machine.
    CoLocated,
    /// L1: reachable over a LAN.
    Lan,
}

/// Render device capability tier. Only T0 may go to air (invariant 19).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum DeviceTier {
    /// Hardware GPU. The only tier a live adapter accepts.
    T0,
    /// Hybrid or reduced hardware path.
    T1,
    /// Software rasteriser: SwiftShader, Lavapipe, WARP. CI only, never live.
    T2,
    /// CPU partial. Degraded by construction.
    T3,
}

impl DeviceTier {
    /// The single place tier is allowed to answer this question.
    pub fn live_capable(self) -> bool {
        matches!(self, DeviceTier::T0)
    }
}

/// Where the render node's phase comes from. Reported, never requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ClockSource {
    /// Slaved to an output device's external reference.
    Genlocked,
    /// IP timing. Deferred to the multi-node phase (ADR-002 option C).
    Ptp,
    /// No reference present. Always reported as such (invariant 11).
    FreeRun,
}

/// External reference signal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ReferenceState {
    Locked,
    /// A reference input exists but is not locked. Distinct from absent: this
    /// is a fault, that is a configuration.
    Unlocked,
    NotPresent,
}

/// Codecs the media plane may negotiate.
///
/// Lives here rather than in either plane: the control plane offers the set in
/// its capability exchange and the media plane negotiates from it, so putting
/// it in one of them would couple two planes that ADR-001 keeps independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MediaCodec {
    /// L0 only: shared memory or handle passing, no encode.
    RawShared,
    /// Bounded JPEG, as 1.x. Adequate for a confidence monitor.
    Jpeg,
    /// Low-latency hardware H.264, for the interactive stream at L1.
    H264,
    /// Where available and measured to help.
    Hevc,
}

/// First-class, named refusals. No silent substitution (invariant 18).
///
/// Every variant names the failing condition. A caller that receives one knows
/// what to fix; an agent that receives one learns the contract, which is the
/// whole argument of the automation plan in ADR Part D, M7.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "refusal",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Refusal {
    /// The take's revision does not match what is published.
    RevisionMismatch {
        expected: Revision,
        actual: Revision,
    },
    /// Device tier is below T0 and a live adapter was requested.
    TierTooLow { actual: DeviceTier },
    /// Reference is not locked and free-run was not explicitly accepted.
    ReferenceUnlocked { state: ReferenceState },
    /// A blend mode the renderer cannot reproduce exactly. Notably
    /// `overlay`, which aliased to `screen` in 1.x: a silent visual
    /// fallback, and an M1 fix. Carries the enum rather than a string, so a
    /// mode that does not exist cannot be refused — or claimed — freehand
    /// (1.3).
    UnsupportedBlendMode { mode: material::BlendMode },
    /// A fit mode the renderer cannot reproduce exactly.
    UnsupportedFitMode { mode: material::FitMode },
    /// A cull mode the renderer cannot reproduce exactly.
    UnsupportedCullMode { mode: material::CullMode },
    /// An alpha interpretation the renderer cannot reproduce exactly.
    UnsupportedAlphaMode { mode: material::AlphaMode },
    /// A depth mode the renderer cannot reproduce exactly.
    UnsupportedDepthMode { mode: material::DepthMode },
    /// A material parameter is outside the range its unit is defined over —
    /// an opacity of 1.4, a roughness of -1. Refused rather than clamped:
    /// clamping answers a question the author did not ask, and the value they
    /// typed never appears again to tell them it was wrong.
    MaterialParameterOutOfRange { material_id: String, field: String },
    /// A lighting block on a material whose kind is not lit. The renderer
    /// would never read it, so accepting it would store authored intent that
    /// silently does nothing.
    MaterialLightingOnUnlitKind {
        material_id: String,
        kind: material::MaterialKind,
    },
    /// A texture slot name no standard material declares. A shader may name
    /// its own inputs; every other kind must use `STANDARD_TEXTURE_SLOTS`,
    /// or the UI and the renderer are looking for different strings.
    MaterialUnknownTextureSlot { material_id: String, slot: String },
    /// A texture points at an asset id the scene's library does not hold.
    MaterialTextureAssetUnknown {
        material_id: String,
        slot: String,
        asset_id: String,
    },
    /// A texture points at an asset that cannot be sampled as this kind of
    /// texture — a font in a base-colour slot, or a still where the material
    /// declares itself a video.
    MaterialTextureAssetWrongKind {
        material_id: String,
        slot: String,
        asset_id: String,
        actual: scene::AssetKind,
    },
    /// An edit named a material the scene's library does not hold.
    MaterialUnknown { material_id: String },
    /// A delete was refused because objects still bind the material. The
    /// count is carried so the caller can say what would break.
    MaterialInUse {
        material_id: String,
        user_count: usize,
    },
    /// A material of this kind cannot be created from nothing; it needs
    /// something only the caller has, named here.
    MaterialKindNeedsPrerequisite {
        kind: material::MaterialKind,
        needs: String,
    },
    /// A vector fill or stroke uses a gradient that the active path
    /// rasteriser cannot carry exactly. It is refused at preparation rather
    /// than reduced to a stop or flat colour (invariant 18).
    UnsupportedPathGradient { object: String, paint: String },
    /// A vector path could not be represented as triangles. The object and
    /// tessellator diagnostic are retained so a malformed path never turns
    /// into an absent or approximate graphic.
    VectorTessellationFailed { object: String, detail: String },
    /// A declared asset's bytes have not arrived. A take blocker
    /// (invariant 29).
    AssetMissing { hash: ContentHash },
    /// Protocol version mismatch. Not negotiable.
    ProtocolMismatch { expected: u32, actual: u32 },
    /// A rate with a zero term.
    InvalidRate { num: u32, den: u32 },
    /// Requested on a platform that is not a certification target.
    PlatformNotCertified { platform: String },
    /// No published scene with this id. Distinct from a revision mismatch:
    /// one means "not that version", this means "not at all", and an operator
    /// needs to know which.
    UnknownTake { take_id: TakeId },
    /// An output adapter identifier the engine does not offer. The offered
    /// identifiers travel with the refusal so an operator can correct a
    /// misspelling without a separate capability lookup.
    UnknownOutputAdapter {
        requested: String,
        offered: Vec<String>,
    },
    /// A requested frame the engine cannot still honour: it has passed, or it
    /// falls inside the lead the engine needs to commit.
    ///
    /// An automation system asking for a frame that is already gone must be
    /// told so. Firing it late instead is the silent failure this refusal
    /// exists to prevent.
    FrameNotReachable { requested: u64, earliest: u64 },
    /// Two outputs on different references means two engine instances, not one
    /// (invariant 10). Configuring a second clock domain in one engine is
    /// refused rather than resolved by picking a winner.
    MultipleClockDomains {
        existing: ClockSource,
        requested: ClockSource,
    },
    /// The connection has not presented a valid credential.
    ///
    /// One variant rather than separate "no token" and "wrong token" cases:
    /// the distinction tells a caller nothing it can act on, and a server that
    /// answers them differently is answering questions it was not asked.
    Unauthenticated,
    /// The peer could not be reached, or answered nothing in time.
    ///
    /// Emitted by a *client*, never by an engine: it describes the transport
    /// rather than a decision. It is a refusal so that a caller handling
    /// refusals cannot accidentally not handle this.
    TransportFailed { detail: String },
    /// Named, so the gap register stays honest instead of stubbing a feature.
    NotImplemented { what: String },
    /// A scene references a font that has not resolved. A take blocker, like
    /// a missing asset (invariant 29): both platforms will substitute a
    /// system font if allowed to, which is precisely the silent visual
    /// difference invariant 18 forbids (ADR-0002 A.4).
    FontMissing { font_id: String },
    /// A font source URL is not HTTPS. Credentials next door are a separate
    /// offence so the caller learns which rule it broke.
    FontUrlNotHttps { url: String },
    /// A font source URL carries credentials.
    FontUrlHasCredentials { url: String },
    /// A font source URL is malformed, or an Adobe Fonts face points at a
    /// host other than use.typekit.net.
    InvalidFontUrl { url: String },
    /// A `package`-policy font with no licence recorded. Unstated licence is
    /// treated as restricted (docs/p2-licensing-positions.md §5).
    FontEmbeddingRefused { font_id: String },
    /// A font file source supplied an absolute or traversal-containing path.
    /// This is the first gate of invariant 42; canonicalisation cannot repair
    /// a path that should never have been accepted as relative input.
    FontPathUnsafe { path: String },
    /// A syntactically-safe font path escaped its configured root after
    /// canonicalisation, usually through a symlink (invariant 42).
    FontPathOutsideRoot { path: String },
    /// A remote font request targeted a host outside the resolver's configured
    /// allowlist. Every redirect hop is checked separately.
    FontFetchHostNotTrusted { url: String },
    /// A remote font host resolved to loopback, private, link-local, or cloud
    /// metadata address space. The resolver never connects to it.
    FontFetchAddressDenied { url: String },
    /// A stylesheet import chain exceeded the resolver's bounded depth.
    FontStylesheetImportDepthExceeded { url: String, max_depth: u8 },
    /// A remote font response exceeded the resolver's byte ceiling.
    FontFetchTooLarge { url: String, limit_bytes: usize },
    /// A remote font request failed after its URL passed policy checks.
    FontFetchFailed { url: String, detail: String },
    /// A stylesheet imports itself through a finite path. It is refused rather
    /// than silently treating the partial stylesheet as complete.
    FontStylesheetImportCycle { url: String },
    /// A required local or packaged font file could not be read.
    FontFileReadFailed { path: String, detail: String },
    /// Verified remote font bytes could not be durably recorded in the cache.
    FontCacheWriteFailed { path: String, detail: String },
    /// Adobe Fonts bytes may not be extracted under the binding font licensing
    /// position; the source is refused rather than substituted.
    AdobeFontLicenceRestricted { url: String },
    /// Font bytes failed inspection: unreadable tables, unsupported
    /// container, no family name.
    InvalidFontData { detail: String },
    /// A colour literal that is not a colour. Never defaulted to black: an
    /// unreadable colour is an authoring error, and substituting one is how
    /// a mistyped fill becomes an invisible graphic on air (1.4).
    InvalidColor { given: String },
    /// The OS could not name a per-user directory. Its own variant because a
    /// refusal names its failing condition (invariant 17) — this was
    /// reported as `InvalidFontData` until 1.4, which told the caller
    /// nothing true.
    PlatformDirectoryUnavailable { detail: String },
    /// A scene document that is not readable as a scene at all: malformed
    /// JSON, a wrong type, or an object kind this schema does not know.
    SceneParseFailed { detail: String },
    /// A design-system source document could not be read: malformed JSON, or
    /// bytes that are not UTF-8. Its own variant because a refusal names its
    /// failing condition (invariant 17) — folding it into `NotImplemented`
    /// would tell a reviewer the importer is unfinished when in fact the file
    /// they supplied is unreadable.
    DesignSourceUnreadable { detail: String },
    /// A scene carried a field this schema does not know, named by its JSON
    /// path. Refused rather than dropped: a key that is silently ignored is a
    /// feature the author believes they used (3.4).
    SceneUnknownField { path: String },
    /// A text object names a font id the scene's own font list does not
    /// carry. The document is self-describing, so this can never resolve
    /// later; substituting a system face is what 3.6 forbids.
    SceneFontUnknown { font_id: String, object: String },
    /// An object names an asset id the scene's own library does not carry.
    SceneAssetUnknown { asset_id: String, object: String },
    /// A mesh material slot names no material in the scene's self-contained
    /// material library.
    SceneMaterialUnknown {
        material_id: String,
        object: String,
        element: String,
    },
    /// A renderable mesh surface has no assignment. It is never drawn with an
    /// implicit default material (invariant 18).
    MeshMaterialUnassigned { object: String, element: String },
    /// A model mesh points at an asset that is not a model.
    MeshModelAssetWrongKind { asset_id: String, object: String },
    /// Verified model bytes are not a readable glTF/GLB document.
    MeshModelInvalid { hash: ContentHash, detail: String },
    /// The model's imported material element names do not agree with the
    /// authored mapping, so assigning by order would be ambiguous.
    MeshMaterialElementsMismatch {
        object: String,
        declared: Vec<String>,
        imported: Vec<String>,
    },
    /// A physically based mesh material has no scene light to respond to.
    MeshMaterialRequiresLight { object: String, material_id: String },
    /// A scene light has no physically based mesh material that can respond.
    LightHasNoResponsiveMaterial { light_id: String },
    /// The selected active camera does not name a camera object in this scene.
    SceneActiveCameraUnknown { camera_id: String },
    /// A package format version this reader does not implement. Packages are
    /// immutable; guessing at a future format would invalidate verification.
    UnknownPackageFormatVersion { received: u32 },
    /// A manifest entry has an absolute, traversal, non-canonical or otherwise
    /// unsafe package-relative path (invariant 42).
    UnsafePackagePath { path: String },
    /// Two manifest entries compare equal under the platform case policy.
    DuplicatePackagePath { path: String },
    /// A manifest checksum is not lowercase hexadecimal SHA-256.
    InvalidPackageHash { path: String },
    /// A required archive member is absent from the package.
    PackageEntryMissing { path: String },
    /// An archive member could not be decoded, including a corrupt archive
    /// checksum. The package is never handed on as a revision.
    PackageEntryUnreadable { path: String, detail: String },
    /// The archive member's actual byte length differs from its manifest.
    PackageFileLengthMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
    /// The archive member's SHA-256 differs from its manifest.
    PackageFileHashMismatch {
        path: String,
        expected: ContentHash,
        actual: ContentHash,
    },
    /// The package's scene does not have the revision its manifest pins.
    PackageScenePinMismatch { detail: String },
    /// A scene-declared asset was omitted from the package closure.
    PackageAssetNotPackaged { asset_id: String, path: String },
    /// Project JSON could not be parsed. The store refuses it instead of
    /// selecting a backup without the operator's explicit recovery choice.
    ProjectJsonCorrupt { project: String, detail: String },
    /// A project document declares a schema this store does not implement.
    UnknownProjectSchema {
        project: String,
        actual: u32,
        supported: u32,
    },
    /// A document's id does not compare equal to the case-canonical project
    /// directory that contains it.
    ProjectIdLocationMismatch {
        project_id: String,
        location: String,
    },
    /// A chunked asset transfer received a chunk out of order.
    ///
    /// Named separately from `FrameNotReachable`, which is about Program
    /// frames: a chunk index and a frame number are different quantities and
    /// reusing one refusal for both tells an operator the wrong thing.
    AssetChunkOutOfOrder {
        hash: ContentHash,
        expected: u32,
        received: u32,
    },
    /// A chunk arrived for a transfer that is already complete.
    AssetTransferAlreadyComplete { hash: ContentHash },
    /// A transfer was declared with no chunks. Zero chunks would verify
    /// vacuously and promote empty bytes under a name asserting they were
    /// checked.
    EmptyAssetTransfer { hash: ContentHash },
    /// Transferred bytes do not hash to the content address they were
    /// declared under.
    ///
    /// Distinct from `AssetMissing`: the bytes arrived and are wrong, which is
    /// a corruption or a substitution, not an absence (invariant 28).
    AssetHashMismatch {
        expected: ContentHash,
        actual: ContentHash,
    },
    /// A media-plane shared buffer could not be established or mapped.
    ///
    /// The media plane drops rather than queues, but failing to create the
    /// transport at all is not a drop — it is the absence of a path, and a
    /// consumer must be told rather than left watching a frame that never
    /// updates (invariant 13).
    MediaTransportUnavailable { detail: String },
    /// A rundown cursor names a position the rundown does not have.
    RundownCursorOutOfRange { cursor: usize, len: usize },
    /// A rundown entry id that the loaded rundown does not contain.
    RundownEntryUnknown { entry_id: String },
    /// An automation trigger evaluated true, and execution is not implemented.
    ///
    /// The deferral is a refusal rather than silence so an automation author
    /// learns their trigger fired and did nothing, instead of concluding the
    /// condition never matched.
    AutomationExecutionDeferred { trigger: String, matched: String },
    /// A write named a project that does not exist.
    ///
    /// Creating it implicitly would be the silent fallback invariant 18
    /// forbids, in its most expensive form: a typo in a project name becomes
    /// a second, near-identical project, and the author's work is split
    /// across both without either looking wrong.
    ProjectNotFound { project: String },
    /// An object id appears twice in one scene document. The hierarchy
    /// resolver can still report it, but an edit addressed by id would not be
    /// able to say which object it changed.
    SceneDuplicateObjectId { object_id: String },
    /// An edit names an object id the scene does not contain.
    SceneObjectUnknown { object_id: String },
    /// A template control names no object or property the control vocabulary
    /// exposes. Storing it would create an operator field that can never be
    /// filled, so declaration refuses before changing the document.
    ControlFieldTargetUnknown { object_id: String, property: String },
    /// Two declared controls use one stable id, making a saved page ambiguous.
    ControlFieldDuplicate { field_id: String },
    /// A field operation or page value names no control in the template.
    ControlFieldUnknown { field_id: String },
    /// A page value has a different concrete type than its declared field.
    ControlValueTypeMismatch {
        field_id: String,
        expected: String,
        actual: String,
    },
    /// A saved page belongs to a different template. Applying it by field id
    /// alone could mutate an unrelated graphic whose controls happen to share
    /// names.
    TakePageSceneMismatch {
        page_id: String,
        expected: String,
        actual: String,
    },
    /// A saved text style names a font the scene does not carry. Applying it
    /// would make a renderer substitute a face, so the style refuses instead.
    TextStyleFontUnknown { style_id: String, font_id: String },
    /// Two styles use one stable id, so applying by name would be ambiguous.
    TextStyleDuplicate { style_id: String },
    /// A style id was requested but is not declared by this scene.
    TextStyleUnknown { style_id: String },
    /// A style references a design token the active project has not confirmed.
    /// Resolving to a last-known or default value would fork brand truth.
    TextStyleTokenUnresolved { style_id: String, token: String },
    /// A kind the authoring surface cannot complete on its own, with what it
    /// needs. An `image` with no asset or a `text` with no font would refuse
    /// the moment it was rendered, so it is refused at creation instead of
    /// being made blank and left for the author to discover.
    SceneObjectKindNotCreatable { kind: String, needs: String },
    /// An object was created or renamed with a blank name. The name is what
    /// the author reads in every panel; an empty one makes an object that
    /// cannot be told from its siblings.
    SceneObjectNameEmpty,
    /// Two named phases claim the same frame. Refused rather than resolved by
    /// precedence: "which phase is frame 50 in" must have one answer, and an
    /// operator taking a graphic out cannot be told it is also building on.
    TimelinePhaseOverlap { earlier: String, later: String },
    /// A phase runs past the scene's declared duration. Also raised when the
    /// duration is shortened underneath an existing phase.
    TimelinePhaseOutOfRange {
        phase: String,
        end_frame: u64,
        duration_frames: u64,
    },
    /// A phase span is empty or inverted. Distinct from out-of-range so an
    /// author who swapped start and end is told that, not something else.
    TimelinePhaseInvalidSpan {
        phase: String,
        start_frame: u64,
        end_frame: u64,
    },
    /// An edit names a phase the timeline does not carry.
    TimelinePhaseUnknown { phase: String },
    /// A frame is outside the scene's declared timeline duration.
    KeyframeOutOfRange {
        object: String,
        property: String,
        frame: u64,
        duration_frames: u64,
    },
    /// Two keys on one channel claim the same frame.
    DuplicateKeyframeFrame {
        object: String,
        property: String,
        frame: u64,
    },
    /// Two channels target the same object/property pair. Evaluating both in
    /// source order would create an undocumented last-writer-wins rule.
    DuplicateAnimationChannel { object: String, property: String },
    /// Keys must be ordered by frame because evaluation uses binary search.
    /// Reordering silently would change the authored wire document.
    AnimationKeyOrderInvalid {
        object: String,
        property: String,
        previous: u64,
        frame: u64,
    },
    /// A channel targets a property that cannot be animated on this object
    /// kind. It is a refusal, not a silent no-op: otherwise an edit can say it
    /// succeeded and change nothing.
    AnimationPropertyUnsupported { object: String, property: String },
    /// An edit names a channel that does not exist.
    AnimationChannelUnknown { object: String, property: String },
    /// An edit names a keyframe the channel does not contain.
    KeyframeUnknown {
        object: String,
        property: String,
        frame: u64,
    },
    /// A keyframe's easing payload disagrees with its named easing.
    InvalidKeyframeEasing {
        object: String,
        property: String,
        detail: String,
    },
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::RevisionMismatch { expected, actual } => {
                write!(
                    f,
                    "revision mismatch: expected {}, got {}",
                    expected.0, actual.0
                )
            }
            Refusal::TierTooLow { actual } => write!(f, "device tier too low: {actual:?}"),
            Refusal::ReferenceUnlocked { state } => write!(f, "reference not locked: {state:?}"),
            Refusal::UnsupportedBlendMode { mode } => write!(f, "unsupported blend mode: {mode:?}"),
            Refusal::UnsupportedFitMode { mode } => write!(f, "unsupported fit mode: {mode:?}"),
            Refusal::UnsupportedCullMode { mode } => write!(f, "unsupported cull mode: {mode:?}"),
            Refusal::UnsupportedAlphaMode { mode } => {
                write!(f, "unsupported alpha mode: {mode:?}")
            }
            Refusal::UnsupportedDepthMode { mode } => write!(f, "unsupported depth mode: {mode:?}"),
            Refusal::MaterialParameterOutOfRange { material_id, field } => {
                write!(f, "material {material_id}: {field} is out of range")
            }
            Refusal::MaterialLightingOnUnlitKind { material_id, kind } => write!(
                f,
                "material {material_id}: a {} material is not lit and cannot carry lighting",
                kind.wire_name()
            ),
            Refusal::MaterialUnknownTextureSlot { material_id, slot } => write!(
                f,
                "material {material_id}: unknown texture slot {slot}"
            ),
            Refusal::MaterialTextureAssetUnknown {
                material_id,
                slot,
                asset_id,
            } => write!(
                f,
                "material {material_id}: texture slot {slot} references unknown asset {asset_id}"
            ),
            Refusal::MaterialTextureAssetWrongKind {
                material_id,
                slot,
                asset_id,
                actual,
            } => write!(
                f,
                "material {material_id}: texture slot {slot} references {asset_id}, which is a {actual:?} asset"
            ),
            Refusal::MaterialUnknown { material_id } => {
                write!(f, "unknown material: {material_id}")
            }
            Refusal::MaterialInUse {
                material_id,
                user_count,
            } => write!(
                f,
                "material {material_id} is used by {user_count} object(s)"
            ),
            Refusal::MaterialKindNeedsPrerequisite { kind, needs } => write!(
                f,
                "a {} material needs {needs}",
                kind.wire_name()
            ),
            Refusal::AssetMissing { hash } => write!(f, "asset missing: {hash}"),
            Refusal::ProtocolMismatch { expected, actual } => {
                write!(f, "protocol mismatch: expected {expected}, got {actual}")
            }
            Refusal::InvalidRate { num, den } => write!(f, "invalid rate: {num}/{den}"),
            Refusal::PlatformNotCertified { platform } => {
                write!(f, "platform not a certification target: {platform}")
            }
            Refusal::UnknownTake { take_id } => write!(f, "unknown take: {take_id}"),
            Refusal::UnknownOutputAdapter { requested, offered } => write!(
                f,
                "unknown output adapter {requested}: offered {}",
                offered.join(", ")
            ),
            Refusal::FrameNotReachable {
                requested,
                earliest,
            } => {
                write!(f, "frame {requested} not reachable: earliest is {earliest}")
            }
            Refusal::MultipleClockDomains {
                existing,
                requested,
            } => write!(
                f,
                "clock domain already {existing:?}, refused {requested:?}"
            ),
            Refusal::Unauthenticated => f.write_str("unauthenticated"),
            Refusal::TransportFailed { detail } => write!(f, "transport failed: {detail}"),
            Refusal::NotImplemented { what } => write!(f, "not implemented: {what}"),
            Refusal::FontMissing { font_id } => write!(f, "font missing: {font_id}"),
            Refusal::FontUrlNotHttps { url } => write!(f, "font URL is not HTTPS: {url}"),
            Refusal::FontUrlHasCredentials { url } => {
                write!(f, "font URL contains credentials: {url}")
            }
            Refusal::InvalidFontUrl { url } => write!(f, "invalid font URL: {url}"),
            Refusal::FontEmbeddingRefused { font_id } => {
                write!(f, "font {font_id} may not be packaged: no licence recorded")
            }
            Refusal::InvalidFontData { detail } => write!(f, "invalid font data: {detail}"),
            Refusal::FontPathUnsafe { path } => write!(f, "unsafe font path: {path}"),
            Refusal::FontPathOutsideRoot { path } => {
                write!(f, "font path escaped configured root: {path}")
            }
            Refusal::FontFetchHostNotTrusted { url } => {
                write!(f, "font fetch host is not trusted: {url}")
            }
            Refusal::FontFetchAddressDenied { url } => {
                write!(f, "font fetch address is denied: {url}")
            }
            Refusal::FontStylesheetImportDepthExceeded { url, max_depth } => {
                write!(
                    f,
                    "font stylesheet import depth exceeded ({max_depth}): {url}"
                )
            }
            Refusal::FontFetchTooLarge { url, limit_bytes } => {
                write!(f, "font fetch exceeds {limit_bytes} bytes: {url}")
            }
            Refusal::FontFetchFailed { url, detail } => {
                write!(f, "font fetch failed for {url}: {detail}")
            }
            Refusal::FontStylesheetImportCycle { url } => {
                write!(f, "font stylesheet import cycle: {url}")
            }
            Refusal::FontFileReadFailed { path, detail } => {
                write!(f, "font file read failed for {path}: {detail}")
            }
            Refusal::FontCacheWriteFailed { path, detail } => {
                write!(f, "font cache write failed for {path}: {detail}")
            }
            Refusal::AdobeFontLicenceRestricted { url } => {
                write!(f, "Adobe Fonts bytes may not be extracted: {url}")
            }
            Refusal::InvalidColor { given } => write!(f, "not a colour: {given}"),
            Refusal::PlatformDirectoryUnavailable { detail } => {
                write!(f, "platform directory unavailable: {detail}")
            }
            Refusal::SceneParseFailed { detail } => {
                write!(f, "scene document is not readable: {detail}")
            }
            Refusal::DesignSourceUnreadable { detail } => {
                write!(f, "design system source is not readable: {detail}")
            }
            Refusal::SceneUnknownField { path } => {
                write!(f, "scene carries a field this schema does not know: {path}")
            }
            Refusal::UnsupportedPathGradient { object, paint } => write!(
                f,
                "object {object} carries a {paint} a path rasteriser cannot draw"
            ),
            Refusal::VectorTessellationFailed { object, detail } => {
                write!(f, "object {object} could not be tessellated: {detail}")
            }
            Refusal::SceneFontUnknown { font_id, object } => write!(
                f,
                "object {object} names font {font_id}, which the scene does not carry"
            ),
            Refusal::SceneAssetUnknown { asset_id, object } => write!(
                f,
                "object {object} names asset {asset_id}, which the scene does not carry"
            ),
            Refusal::SceneMaterialUnknown {
                material_id,
                object,
                element,
            } => write!(
                f,
                "object {object} assigns unknown material {material_id} to {element}"
            ),
            Refusal::MeshMaterialUnassigned { object, element } => {
                write!(
                    f,
                    "object {object} has no material assignment for {element}"
                )
            }
            Refusal::MeshModelAssetWrongKind { asset_id, object } => {
                write!(f, "mesh {object} names non-model asset {asset_id}")
            }
            Refusal::MeshModelInvalid { hash, detail } => {
                write!(f, "model {hash} is not readable glTF: {detail}")
            }
            Refusal::MeshMaterialElementsMismatch {
                object,
                declared,
                imported,
            } => write!(
                f,
                "model mesh {object} declares elements {declared:?}, but imports {imported:?}"
            ),
            Refusal::MeshMaterialRequiresLight {
                object,
                material_id,
            } => write!(
                f,
                "mesh {object} material {material_id} requires a scene light"
            ),
            Refusal::LightHasNoResponsiveMaterial { light_id } => {
                write!(
                    f,
                    "light {light_id} has no physically based material to affect"
                )
            }
            Refusal::SceneActiveCameraUnknown { camera_id } => {
                write!(f, "active camera {camera_id} is not a scene camera")
            }
            Refusal::UnknownPackageFormatVersion { received } => {
                write!(f, "unknown package format version: {received}")
            }
            Refusal::UnsafePackagePath { path } => write!(f, "unsafe package path: {path}"),
            Refusal::DuplicatePackagePath { path } => {
                write!(f, "duplicate package path under case policy: {path}")
            }
            Refusal::InvalidPackageHash { path } => {
                write!(f, "invalid SHA-256 package hash: {path}")
            }
            Refusal::PackageEntryMissing { path } => write!(f, "package entry missing: {path}"),
            Refusal::PackageEntryUnreadable { path, detail } => {
                write!(f, "package entry unreadable ({path}): {detail}")
            }
            Refusal::PackageFileLengthMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "package entry length mismatch ({path}): expected {expected}, got {actual}"
            ),
            Refusal::PackageFileHashMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "package entry SHA-256 mismatch ({path}): expected {expected}, got {actual}"
            ),
            Refusal::PackageScenePinMismatch { detail } => {
                write!(f, "package scene pin mismatch: {detail}")
            }
            Refusal::PackageAssetNotPackaged { asset_id, path } => {
                write!(f, "scene asset {asset_id} is not packaged at {path}")
            }
            Refusal::ProjectJsonCorrupt { project, detail } => {
                write!(f, "project JSON is corrupt ({project}): {detail}")
            }
            Refusal::UnknownProjectSchema {
                project,
                actual,
                supported,
            } => write!(
                f,
                "project {project} has unknown schema {actual}; supported schema is {supported}"
            ),
            Refusal::ProjectIdLocationMismatch {
                project_id,
                location,
            } => write!(
                f,
                "project id {project_id} does not match its location {location}"
            ),
            Refusal::AssetChunkOutOfOrder {
                hash,
                expected,
                received,
            } => write!(
                f,
                "asset {hash} expected chunk {expected}, received {received}"
            ),
            Refusal::AssetTransferAlreadyComplete { hash } => {
                write!(f, "asset {hash} transfer is already complete")
            }
            Refusal::EmptyAssetTransfer { hash } => {
                write!(f, "asset {hash} was declared with no chunks")
            }
            Refusal::AssetHashMismatch { expected, actual } => write!(
                f,
                "transferred bytes hash to {actual}, not the declared {expected}"
            ),
            Refusal::MediaTransportUnavailable { detail } => {
                write!(f, "media transport unavailable: {detail}")
            }
            Refusal::RundownCursorOutOfRange { cursor, len } => write!(
                f,
                "rundown cursor {cursor} is outside a rundown of {len} entries"
            ),
            Refusal::RundownEntryUnknown { entry_id } => {
                write!(f, "rundown has no entry {entry_id}")
            }
            Refusal::AutomationExecutionDeferred { trigger, matched } => write!(
                f,
                "automation trigger {trigger} matched ({matched}); execution is deferred, not performed"
            ),
            Refusal::ProjectNotFound { project } => {
                write!(f, "no project named {project}")
            }
            Refusal::SceneDuplicateObjectId { object_id } => {
                write!(f, "object id {object_id} appears more than once")
            }
            Refusal::SceneObjectUnknown { object_id } => {
                write!(f, "scene has no object {object_id}")
            }
            Refusal::ControlFieldTargetUnknown {
                object_id,
                property,
            } => write!(f, "template control target {object_id}.{property} is unavailable"),
            Refusal::ControlFieldDuplicate { field_id } => {
                write!(f, "template already declares control field {field_id}")
            }
            Refusal::ControlFieldUnknown { field_id } => {
                write!(f, "template has no control field {field_id}")
            }
            Refusal::ControlValueTypeMismatch {
                field_id,
                expected,
                actual,
            } => write!(
                f,
                "template control field {field_id} requires {expected}, not {actual}"
            ),
            Refusal::TakePageSceneMismatch {
                page_id,
                expected,
                actual,
            } => write!(
                f,
                "take page {page_id} belongs to scene {actual}, not template {expected}"
            ),
            Refusal::TextStyleFontUnknown { style_id, font_id } => {
                write!(f, "text style {style_id} names unknown font {font_id}")
            }
            Refusal::TextStyleDuplicate { style_id } => {
                write!(f, "scene declares text style {style_id} more than once")
            }
            Refusal::TextStyleUnknown { style_id } => {
                write!(f, "scene has no text style {style_id}")
            }
            Refusal::TextStyleTokenUnresolved { style_id, token } => {
                write!(f, "text style {style_id} cannot resolve token {token}")
            }
            Refusal::SceneObjectKindNotCreatable { kind, needs } => {
                write!(f, "cannot create a {kind} without {needs}")
            }
            Refusal::SceneObjectNameEmpty => {
                write!(f, "an object needs a name")
            }
            Refusal::TimelinePhaseOverlap { earlier, later } => {
                write!(f, "phases {earlier} and {later} claim the same frames")
            }
            Refusal::TimelinePhaseOutOfRange {
                phase,
                end_frame,
                duration_frames,
            } => write!(
                f,
                "phase {phase} ends at frame {end_frame}, past the scene's {duration_frames} frames"
            ),
            Refusal::TimelinePhaseInvalidSpan {
                phase,
                start_frame,
                end_frame,
            } => write!(
                f,
                "phase {phase} spans frames {start_frame} to {end_frame}, which contains no frames"
            ),
            Refusal::TimelinePhaseUnknown { phase } => {
                write!(f, "the timeline has no phase {phase}")
            }
            Refusal::KeyframeOutOfRange {
                object,
                property,
                frame,
                duration_frames,
            } => write!(
                f,
                "keyframe for {object}.{property} is at frame {frame}, outside the {duration_frames}-frame timeline"
            ),
            Refusal::DuplicateKeyframeFrame {
                object,
                property,
                frame,
            } => write!(
                f,
                "object {object} already has a keyframe for {property} at frame {frame}"
            ),
            Refusal::DuplicateAnimationChannel { object, property } => {
                write!(f, "object {object} has more than one animation channel for {property}")
            }
            Refusal::AnimationKeyOrderInvalid {
                object,
                property,
                previous,
                frame,
            } => write!(
                f,
                "keyframes for {object}.{property} move backwards from frame {previous} to {frame}"
            ),
            Refusal::AnimationPropertyUnsupported { object, property } => {
                write!(f, "object {object} cannot animate {property}")
            }
            Refusal::AnimationChannelUnknown { object, property } => {
                write!(f, "object {object} has no animation channel for {property}")
            }
            Refusal::KeyframeUnknown {
                object,
                property,
                frame,
            } => write!(
                f,
                "object {object} has no keyframe for {property} at frame {frame}"
            ),
            Refusal::InvalidKeyframeEasing {
                object,
                property,
                detail,
            } => write!(f, "invalid easing for {object}.{property}: {detail}"),
        }
    }
}

impl Refusal {
    /// The refusal's wire code: the `refusal` tag serde emits for it.
    ///
    /// One exhaustive match, in the crate that owns the enum, because three
    /// copies of this table had grown up outside it — the telemetry audit
    /// register, the conformance variant register, and the MCP capability
    /// surface each maintained their own. Each was individually correct and
    /// collectively a drift risk: a variant added to two of them and not the
    /// third produces a refusal that one surface can name and another cannot
    /// (invariant 27).
    ///
    /// The match is exhaustive, so a new variant cannot be added without
    /// naming it here, and every consumer inherits that guarantee.

    /// One instance of every variant.
    ///
    /// Enumeration a derive cannot provide: the variants carry data, so there
    /// is no way to list them without constructing them. This lived in the
    /// conformance suite, where it was invisible to every other consumer that
    /// needed the same list — the MCP capability surface among them.
    ///
    /// The values are placeholders. What matters is that every variant appears
    /// exactly once, which the conformance audit asserts by pairing this
    /// against the exhaustive `code_name` match: a variant missing here has no
    /// driver and no limitation, and fails that check.
    pub fn all_variants() -> Vec<Self> {
    vec![
            Self::RevisionMismatch {
                expected: Revision(1),
                actual: Revision(0),
            },
            Self::TierTooLow {
                actual: DeviceTier::T3,
            },
            Self::ReferenceUnlocked {
                state: ReferenceState::Unlocked,
            },
            Self::UnsupportedBlendMode {
                mode: material::BlendMode::Overlay,
            },
            Self::UnsupportedFitMode {
                mode: material::FitMode::NineSlice,
            },
            Self::MaterialParameterOutOfRange {
                material_id: "audit".into(),
                field: "opacity".into(),
            },
            Self::MaterialLightingOnUnlitKind {
                material_id: "audit".into(),
                kind: material::MaterialKind::Unlit,
            },
            Self::MaterialUnknownTextureSlot {
                material_id: "audit".into(),
                slot: "audit".into(),
            },
            Self::MaterialTextureAssetUnknown {
                material_id: "audit".into(),
                slot: "baseColor".into(),
                asset_id: "audit".into(),
            },
            Self::MaterialTextureAssetWrongKind {
                material_id: "audit".into(),
                slot: "baseColor".into(),
                asset_id: "audit".into(),
                actual: scene::AssetKind::Font,
            },
            Self::MaterialUnknown {
                material_id: "audit".into(),
            },
            Self::MaterialInUse {
                material_id: "audit".into(),
                user_count: 2,
            },
            Self::MaterialKindNeedsPrerequisite {
                kind: material::MaterialKind::Image,
                needs: "audit".into(),
            },
            Self::AssetMissing {
                hash: ContentHash("audit".into()),
            },
            Self::ProtocolMismatch {
                expected: 1,
                actual: 0,
            },
            Self::InvalidRate { num: 0, den: 1 },
            Self::PlatformNotCertified {
                platform: "audit".into(),
            },
            Self::UnknownTake {
                take_id: TakeId("audit".into()),
            },
            Self::FrameNotReachable {
                requested: 0,
                earliest: 1,
            },
            Self::MultipleClockDomains {
                existing: ClockSource::Genlocked,
                requested: ClockSource::Ptp,
            },
            Self::Unauthenticated,
            Self::TransportFailed {
                detail: "audit".into(),
            },
            Self::NotImplemented {
                what: "audit".into(),
            },
            Self::FontMissing {
                font_id: "audit".into(),
            },
            Self::FontUrlNotHttps {
                url: "audit".into(),
            },
            Self::FontUrlHasCredentials {
                url: "audit".into(),
            },
            Self::InvalidFontUrl {
                url: "audit".into(),
            },
            Self::ProjectNotFound {
                project: "audit".into(),
            },
            Self::FontEmbeddingRefused {
                font_id: "audit".into(),
            },
            Self::FontPathUnsafe {
                path: "audit".into(),
            },
            Self::FontPathOutsideRoot {
                path: "audit".into(),
            },
            Self::FontFetchHostNotTrusted {
                url: "audit".into(),
            },
            Self::FontFetchAddressDenied {
                url: "audit".into(),
            },
            Self::FontStylesheetImportDepthExceeded {
                url: "audit".into(),
                max_depth: 1,
            },
            Self::FontFetchTooLarge {
                url: "audit".into(),
                limit_bytes: 1,
            },
            Self::FontFetchFailed {
                url: "audit".into(),
                detail: "audit".into(),
            },
            Self::FontStylesheetImportCycle {
                url: "audit".into(),
            },
            Self::FontFileReadFailed {
                path: "audit".into(),
                detail: "audit".into(),
            },
            Self::FontCacheWriteFailed {
                path: "audit".into(),
                detail: "audit".into(),
            },
            Self::AdobeFontLicenceRestricted {
                url: "audit".into(),
            },
            Self::InvalidFontData {
                detail: "audit".into(),
            },
            Self::InvalidColor {
                given: "audit".into(),
            },
            Self::PlatformDirectoryUnavailable {
                detail: "audit".into(),
            },
            Self::SceneParseFailed {
                detail: "audit".into(),
            },
            Self::DesignSourceUnreadable {
                detail: "audit".into(),
            },
            Self::SceneUnknownField {
                path: "audit".into(),
            },
            Self::SceneFontUnknown {
                font_id: "audit".into(),
                object: "audit".into(),
            },
            Self::SceneAssetUnknown {
                asset_id: "audit".into(),
                object: "audit".into(),
            },
            Self::SceneDuplicateObjectId {
                object_id: "audit".into(),
            },
            Self::SceneObjectUnknown {
                object_id: "audit".into(),
            },
            Self::ControlFieldTargetUnknown {
                object_id: "audit".into(),
                property: "audit".into(),
            },
            Self::ControlFieldDuplicate {
                field_id: "audit".into(),
            },
            Self::ControlFieldUnknown {
                field_id: "audit".into(),
            },
            Self::ControlValueTypeMismatch {
                field_id: "audit".into(),
                expected: "text".into(),
                actual: "number".into(),
            },
            Self::TextStyleFontUnknown {
                style_id: "audit".into(),
                font_id: "audit".into(),
            },
            Self::TakePageSceneMismatch {
                page_id: "audit".into(),
                expected: "audit".into(),
                actual: "other".into(),
            },
            Self::TextStyleUnknown {
                style_id: "audit".into(),
            },
            Self::TextStyleTokenUnresolved {
                style_id: "audit".into(),
                token: "{palette.audit}".into(),
            },
            Self::TextStyleDuplicate {
                style_id: "audit".into(),
            },
            Self::SceneObjectKindNotCreatable {
                kind: "audit".into(),
                needs: "audit".into(),
            },
            Self::SceneObjectNameEmpty,
            Self::TimelinePhaseOverlap {
                earlier: "audit".into(),
                later: "audit".into(),
            },
            Self::TimelinePhaseOutOfRange {
                phase: "audit".into(),
                end_frame: 2,
                duration_frames: 1,
            },
            Self::TimelinePhaseInvalidSpan {
                phase: "audit".into(),
                start_frame: 1,
                end_frame: 1,
            },
            Self::TimelinePhaseUnknown {
                phase: "audit".into(),
            },
            Self::KeyframeOutOfRange {
                object: "audit".into(),
                property: "audit".into(),
                frame: 2,
                duration_frames: 1,
            },
            Self::DuplicateKeyframeFrame {
                object: "audit".into(),
                property: "audit".into(),
                frame: 1,
            },
            Self::DuplicateAnimationChannel {
                object: "audit".into(),
                property: "audit".into(),
            },
            Self::AnimationKeyOrderInvalid {
                object: "audit".into(),
                property: "audit".into(),
                previous: 2,
                frame: 1,
            },
            Self::AnimationPropertyUnsupported {
                object: "audit".into(),
                property: "audit".into(),
            },
            Self::AnimationChannelUnknown {
                object: "audit".into(),
                property: "audit".into(),
            },
            Self::KeyframeUnknown {
                object: "audit".into(),
                property: "audit".into(),
                frame: 1,
            },
            Self::InvalidKeyframeEasing {
                object: "audit".into(),
                property: "audit".into(),
                detail: "audit".into(),
            },
            Self::UnknownPackageFormatVersion { received: 0 },
            Self::UnsafePackagePath {
                path: "audit".into(),
            },
            Self::DuplicatePackagePath {
                path: "audit".into(),
            },
            Self::InvalidPackageHash {
                path: "audit".into(),
            },
            Self::PackageEntryMissing {
                path: "audit".into(),
            },
            Self::PackageEntryUnreadable {
                path: "audit".into(),
                detail: "audit".into(),
            },
            Self::PackageFileLengthMismatch {
                path: "audit".into(),
                expected: 1,
                actual: 0,
            },
            Self::PackageFileHashMismatch {
                path: "audit".into(),
                expected: ContentHash("expected".into()),
                actual: ContentHash("actual".into()),
            },
            Self::PackageScenePinMismatch {
                detail: "audit".into(),
            },
            Self::PackageAssetNotPackaged {
                asset_id: "audit".into(),
                path: "audit".into(),
            },
            Self::ProjectJsonCorrupt {
                project: "audit".into(),
                detail: "audit".into(),
            },
            Self::UnknownProjectSchema {
                project: "audit".into(),
                actual: 0,
                supported: 1,
            },
            Self::ProjectIdLocationMismatch {
                project_id: "audit".into(),
                location: "audit".into(),
            },
            Self::AssetChunkOutOfOrder {
                hash: ContentHash("audit".into()),
                expected: 1,
                received: 3,
            },
            Self::AssetTransferAlreadyComplete {
                hash: ContentHash("audit".into()),
            },
            Self::EmptyAssetTransfer {
                hash: ContentHash("audit".into()),
            },
            Self::AssetHashMismatch {
                expected: ContentHash("expected".into()),
                actual: ContentHash("actual".into()),
            },
            Self::MediaTransportUnavailable {
                detail: "audit".into(),
            },
            Self::RundownCursorOutOfRange { cursor: 9, len: 2 },
            Self::RundownEntryUnknown {
                entry_id: "audit".into(),
            },
            Self::AutomationExecutionDeferred {
                trigger: "audit".into(),
                matched: "audit".into(),
            },
        ]
    }

    pub const fn code_name(&self) -> &'static str {
        match self {
            Self::RevisionMismatch { .. } => "revisionMismatch",
            Self::TierTooLow { .. } => "tierTooLow",
            Self::ReferenceUnlocked { .. } => "referenceUnlocked",
            Self::UnsupportedBlendMode { .. } => "unsupportedBlendMode",
            Self::UnsupportedFitMode { .. } => "unsupportedFitMode",
            Self::UnsupportedCullMode { .. } => "unsupportedCullMode",
            Self::UnsupportedAlphaMode { .. } => "unsupportedAlphaMode",
            Self::UnsupportedDepthMode { .. } => "unsupportedDepthMode",
            Self::MaterialParameterOutOfRange { .. } => "materialParameterOutOfRange",
            Self::MaterialLightingOnUnlitKind { .. } => "materialLightingOnUnlitKind",
            Self::MaterialUnknownTextureSlot { .. } => "materialUnknownTextureSlot",
            Self::MaterialTextureAssetUnknown { .. } => "materialTextureAssetUnknown",
            Self::MaterialTextureAssetWrongKind { .. } => "materialTextureAssetWrongKind",
            Self::MaterialUnknown { .. } => "materialUnknown",
            Self::MaterialInUse { .. } => "materialInUse",
            Self::MaterialKindNeedsPrerequisite { .. } => "materialKindNeedsPrerequisite",
            Self::UnsupportedPathGradient { .. } => "unsupportedPathGradient",
            Self::VectorTessellationFailed { .. } => "vectorTessellationFailed",
            Self::AssetMissing { .. } => "assetMissing",
            Self::ProtocolMismatch { .. } => "protocolMismatch",
            Self::InvalidRate { .. } => "invalidRate",
            Self::PlatformNotCertified { .. } => "platformNotCertified",
            Self::UnknownTake { .. } => "unknownTake",
            Self::FrameNotReachable { .. } => "frameNotReachable",
            Self::MultipleClockDomains { .. } => "multipleClockDomains",
            Self::Unauthenticated => "unauthenticated",
            Self::TransportFailed { .. } => "transportFailed",
            Self::NotImplemented { .. } => "notImplemented",
            Self::FontMissing { .. } => "fontMissing",
            Self::FontUrlNotHttps { .. } => "fontUrlNotHttps",
            Self::FontUrlHasCredentials { .. } => "fontUrlHasCredentials",
            Self::InvalidFontUrl { .. } => "invalidFontUrl",
            Self::FontEmbeddingRefused { .. } => "fontEmbeddingRefused",
            Self::FontPathUnsafe { .. } => "fontPathUnsafe",
            Self::FontPathOutsideRoot { .. } => "fontPathOutsideRoot",
            Self::FontFetchHostNotTrusted { .. } => "fontFetchHostNotTrusted",
            Self::FontFetchAddressDenied { .. } => "fontFetchAddressDenied",
            Self::FontStylesheetImportDepthExceeded { .. } => "fontStylesheetImportDepthExceeded",
            Self::FontFetchTooLarge { .. } => "fontFetchTooLarge",
            Self::FontFetchFailed { .. } => "fontFetchFailed",
            Self::AdobeFontLicenceRestricted { .. } => "adobeFontLicenceRestricted",
            Self::InvalidFontData { .. } => "invalidFontData",
            Self::InvalidColor { .. } => "invalidColor",
            Self::PlatformDirectoryUnavailable { .. } => "platformDirectoryUnavailable",
            Self::ControlFieldTargetUnknown { .. } => "controlFieldTargetUnknown",
            Self::ControlFieldDuplicate { .. } => "controlFieldDuplicate",
            Self::ControlFieldUnknown { .. } => "controlFieldUnknown",
            Self::ControlValueTypeMismatch { .. } => "controlValueTypeMismatch",
            Self::TakePageSceneMismatch { .. } => "takePageSceneMismatch",
            Self::TextStyleFontUnknown { .. } => "textStyleFontUnknown",
            Self::TextStyleDuplicate { .. } => "textStyleDuplicate",
            Self::TextStyleUnknown { .. } => "textStyleUnknown",
            Self::TextStyleTokenUnresolved { .. } => "textStyleTokenUnresolved",
            Self::UnknownPackageFormatVersion { .. } => "unknownPackageFormatVersion",
            Self::UnsafePackagePath { .. } => "unsafePackagePath",
            Self::DuplicatePackagePath { .. } => "duplicatePackagePath",
            Self::InvalidPackageHash { .. } => "invalidPackageHash",
            Self::PackageEntryMissing { .. } => "packageEntryMissing",
            Self::PackageEntryUnreadable { .. } => "packageEntryUnreadable",
            Self::PackageFileLengthMismatch { .. } => "packageFileLengthMismatch",
            Self::PackageFileHashMismatch { .. } => "packageFileHashMismatch",
            Self::PackageScenePinMismatch { .. } => "packageScenePinMismatch",
            Self::PackageAssetNotPackaged { .. } => "packageAssetNotPackaged",
            Self::ProjectJsonCorrupt { .. } => "projectJsonCorrupt",
            Self::UnknownProjectSchema { .. } => "unknownProjectSchema",
            Self::ProjectIdLocationMismatch { .. } => "projectIdLocationMismatch",
            Self::SceneParseFailed { .. } => "sceneParseFailed",
            Self::DesignSourceUnreadable { .. } => "designSourceUnreadable",
            Self::SceneUnknownField { .. } => "sceneUnknownField",
            Self::SceneFontUnknown { .. } => "sceneFontUnknown",
            Self::SceneAssetUnknown { .. } => "sceneAssetUnknown",
            Self::SceneDuplicateObjectId { .. } => "sceneDuplicateObjectId",
            Self::SceneObjectUnknown { .. } => "sceneObjectUnknown",
            Self::SceneObjectKindNotCreatable { .. } => "sceneObjectKindNotCreatable",
            Self::SceneObjectNameEmpty => "sceneObjectNameEmpty",
            Self::TimelinePhaseOverlap { .. } => "timelinePhaseOverlap",
            Self::TimelinePhaseOutOfRange { .. } => "timelinePhaseOutOfRange",
            Self::TimelinePhaseInvalidSpan { .. } => "timelinePhaseInvalidSpan",
            Self::TimelinePhaseUnknown { .. } => "timelinePhaseUnknown",
            Self::KeyframeOutOfRange { .. } => "keyframeOutOfRange",
            Self::DuplicateKeyframeFrame { .. } => "duplicateKeyframeFrame",
            Self::DuplicateAnimationChannel { .. } => "duplicateAnimationChannel",
            Self::AnimationKeyOrderInvalid { .. } => "animationKeyOrderInvalid",
            Self::AnimationPropertyUnsupported { .. } => "animationPropertyUnsupported",
            Self::AnimationChannelUnknown { .. } => "animationChannelUnknown",
            Self::KeyframeUnknown { .. } => "keyframeUnknown",
            Self::InvalidKeyframeEasing { .. } => "invalidKeyframeEasing",
            Self::SceneMaterialUnknown { .. } => "sceneMaterialUnknown",
            Self::MeshMaterialUnassigned { .. } => "meshMaterialUnassigned",
            Self::MeshModelAssetWrongKind { .. } => "meshModelAssetWrongKind",
            Self::MeshModelInvalid { .. } => "meshModelInvalid",
            Self::MeshMaterialElementsMismatch { .. } => "meshMaterialElementsMismatch",
            Self::MeshMaterialRequiresLight { .. } => "meshMaterialRequiresLight",
            Self::LightHasNoResponsiveMaterial { .. } => "lightHasNoResponsiveMaterial",
            Self::SceneActiveCameraUnknown { .. } => "sceneActiveCameraUnknown",
            Self::UnknownOutputAdapter { .. } => "unknownOutputAdapter",
            Self::FontStylesheetImportCycle { .. } => "fontStylesheetImportCycle",
            Self::FontFileReadFailed { .. } => "fontFileReadFailed",
            Self::FontCacheWriteFailed { .. } => "fontCacheWriteFailed",
            Self::AssetChunkOutOfOrder { .. } => "assetChunkOutOfOrder",
            Self::AssetTransferAlreadyComplete { .. } => "assetTransferAlreadyComplete",
            Self::EmptyAssetTransfer { .. } => "emptyAssetTransfer",
            Self::AssetHashMismatch { .. } => "assetHashMismatch",
            Self::MediaTransportUnavailable { .. } => "mediaTransportUnavailable",
            Self::RundownCursorOutOfRange { .. } => "rundownCursorOutOfRange",
            Self::RundownEntryUnknown { .. } => "rundownEntryUnknown",
            Self::AutomationExecutionDeferred { .. } => "automationExecutionDeferred",
            Self::ProjectNotFound { .. } => "projectNotFound",
        }
    }
}

impl std::error::Error for Refusal {}

/// How urgently a structured refusal must be acted on (0.6). Not everything is
/// a hard rule, so the envelope carries severity alongside the code.
///
/// Lives in contracts rather than in the validator because the same triage
/// applies to every refusal surface — engine, validator and design system —
/// and three copies would drift (invariant 27).
///
/// Declared least-urgent first so the derived `Ord` reads as urgency:
/// `Error > Warning > Info`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RefusalSeverity {
    /// Reported only. Informational, no action required.
    Info,
    /// Allowed, but recorded. Reviewed when the system versions.
    Warning,
    /// The operation is refused. Publish, take and configure all stop here.
    Error,
}

/// The structured refusal envelope (0.6): the shape every refusal surface
/// returns, so a caller — human or agent — can act on it without parsing prose.
///
/// `Refusal` names *what* was refused; this envelope adds *where*, *what was
/// given*, *what is allowed* and *how urgent it is*. The `allowed` array is
/// what turns a failure into a successful retry: a refusal that names the
/// acceptable values is the difference between an agent that corrects itself
/// and one that guesses again (Part D principle 3, Part G.4).
///
/// Serialises identically in Rust and TypeScript because it is generated from
/// this one definition (invariant 22); the test below pins the exact JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StructuredRefusal {
    /// The named refusal. The machine-parseable reason.
    pub code: Refusal,
    /// The JSON path to the offending value, e.g. `objects[2].text.size`.
    /// Omitted on the wire when the refusal is not about one field.
    ///
    /// `#[ts(optional)]` keeps the generated TS in step with serde's
    /// `skip_serializing_if`: the key is absent, not `null`, so the TS field
    /// is `field?: string`, and the two attributes must change together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub field: Option<String>,
    /// The value that was given, as JSON, so the caller can show or log it
    /// verbatim. `Null` when there is no single given value.
    #[serde(default)]
    pub given: serde_json::Value,
    /// The values that would have been accepted. Omitted on the wire when
    /// there is no enumerable set — the fix is described by the code, not a
    /// list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allowed: Option<Vec<serde_json::Value>>,
    pub severity: RefusalSeverity,
}

impl StructuredRefusal {
    /// An error-severity refusal with no field context: the common case for
    /// engine refusals, which are about a request as a whole.
    pub fn error(code: Refusal) -> Self {
        Self {
            code,
            field: None,
            given: serde_json::Value::Null,
            allowed: None,
            severity: RefusalSeverity::Error,
        }
    }

    /// Attach the field path and the offending value.
    pub fn at(mut self, field: impl Into<String>, given: serde_json::Value) -> Self {
        self.field = Some(field.into());
        self.given = given;
        self
    }

    /// Attach the set of acceptable values.
    pub fn allowing(mut self, allowed: Vec<serde_json::Value>) -> Self {
        self.allowed = Some(allowed);
        self
    }

    /// Downgrade or set the severity.
    pub fn with_severity(mut self, severity: RefusalSeverity) -> Self {
        self.severity = severity;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_frame_rates_are_exact() {
        // The reason this type exists: 30000/1001 is not 29.97.
        assert_eq!(RationalRate::P29_97.num, 30000);
        assert_eq!(RationalRate::P29_97.den, 1001);
        let as_float = f64::from(RationalRate::P29_97.num) / f64::from(RationalRate::P29_97.den);
        assert_ne!(as_float, 29.97);
    }

    #[test]
    fn zero_terms_are_refused_not_clamped() {
        assert!(matches!(
            RationalRate::new(30, 0),
            Err(Refusal::InvalidRate { .. })
        ));
        assert!(matches!(
            RationalRate::new(0, 1),
            Err(Refusal::InvalidRate { .. })
        ));
    }

    #[test]
    fn only_t0_is_live_capable() {
        assert!(DeviceTier::T0.live_capable());
        for tier in [DeviceTier::T1, DeviceTier::T2, DeviceTier::T3] {
            assert!(!tier.live_capable(), "{tier:?} must never be live capable");
        }
    }

    #[test]
    fn a_structured_refusal_serialises_to_the_handoff_shape() {
        // 0.6: code, field, given, allowed, severity. The exact JSON is the
        // contract an agent parses, so it is pinned here — a field renamed or
        // dropped fails this test, and the generated TS is checked against it
        // by the codegen-staleness gate.
        let r = StructuredRefusal::error(Refusal::UnsupportedBlendMode {
            mode: material::BlendMode::Overlay,
        })
        .at("objects[3].material.blend", serde_json::json!("overlay"))
        .allowing(vec![
            serde_json::json!("normal"),
            serde_json::json!("add"),
            serde_json::json!("screen"),
        ]);

        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["code"]["refusal"], "unsupportedBlendMode");
        assert_eq!(v["code"]["mode"], "overlay");
        assert_eq!(v["field"], "objects[3].material.blend");
        assert_eq!(v["given"], "overlay");
        assert_eq!(v["allowed"], serde_json::json!(["normal", "add", "screen"]));
        assert_eq!(v["severity"], "error");

        // Round-trips: the same bytes come back as the same value.
        let back: StructuredRefusal = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn an_engine_refusal_defaults_to_error_with_no_field_noise() {
        let r = StructuredRefusal::error(Refusal::TierTooLow {
            actual: DeviceTier::T2,
        });
        let v = serde_json::to_value(&r).unwrap();
        // Empty field and allowed are omitted, not serialised as noise.
        assert!(v.get("field").is_none());
        assert!(v.get("allowed").is_none());
        assert_eq!(v["severity"], "error");
    }

    #[test]
    fn severity_orders_so_error_is_the_most_urgent() {
        assert!(RefusalSeverity::Error > RefusalSeverity::Warning);
        assert!(RefusalSeverity::Warning > RefusalSeverity::Info);
    }

    #[test]
    fn a_write_on_the_current_revision_advances_it() {
        // 0.8: matching if_revision applies the write and yields the next
        // revision, which becomes the new current.
        let current = Revision(7);
        let new = current.check_write(Revision(7)).unwrap();
        assert_eq!(new, Revision(8));
    }

    #[test]
    fn a_write_on_a_stale_revision_returns_the_current_one() {
        // 0.8's done-when: a conflict returns the current revision, so the
        // caller re-reads and retries rather than overwriting blind.
        let current = Revision(7);
        let conflict = current.check_write(Revision(3)).unwrap_err();
        assert_eq!(conflict.expected, Revision(3));
        assert_eq!(conflict.current, Revision(7));
    }

    #[test]
    fn a_loser_can_recover_and_win_the_retry() {
        // The reason the conflict carries current: the retry succeeds.
        let mut current = Revision(1);
        // Writer A and B both read revision 1. A wins.
        current = current.check_write(Revision(1)).unwrap();
        // B's write against the now-stale 1 conflicts, and B learns current=2.
        let conflict = current.check_write(Revision(1)).unwrap_err();
        let learned = conflict.current;
        // B re-reads at 2 and retries: now it applies.
        current = current.check_write(learned).unwrap();
        assert_eq!(current, Revision(3));
    }
}

//! Core contract types shared by all four planes.
//!
//! Source of truth for the generated TypeScript (invariant 22). Nothing here
//! may reference a transport, a runtime or a product.

#![forbid(unsafe_code)]

pub mod auth;
pub mod color;
pub mod design_system;
pub mod font;
pub mod material;
pub mod package;
pub mod platform;
pub mod scene;

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
            Refusal::AssetMissing { hash } => write!(f, "asset missing: {hash}"),
            Refusal::ProtocolMismatch { expected, actual } => {
                write!(f, "protocol mismatch: expected {expected}, got {actual}")
            }
            Refusal::InvalidRate { num, den } => write!(f, "invalid rate: {num}/{den}"),
            Refusal::PlatformNotCertified { platform } => {
                write!(f, "platform not a certification target: {platform}")
            }
            Refusal::UnknownTake { take_id } => write!(f, "unknown take: {take_id}"),
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
            Refusal::SceneUnknownField { path } => {
                write!(f, "scene carries a field this schema does not know: {path}")
            }
            Refusal::SceneFontUnknown { font_id, object } => write!(
                f,
                "object {object} names font {font_id}, which the scene does not carry"
            ),
            Refusal::SceneAssetUnknown { asset_id, object } => write!(
                f,
                "object {object} names asset {asset_id}, which the scene does not carry"
            ),
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

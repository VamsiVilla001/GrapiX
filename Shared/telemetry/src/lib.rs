//! Tracing, audit records and sanitised operations logging.
//!
//! One crate owns how the system emits observability data, so the engine, host
//! and conformance harness share field names and cannot grow incompatible log
//! vocabularies. Audit records answer an authorisation question structurally:
//! who asked for which request against which target, whether it was accepted
//! or refused, and under which engine epoch. Operations events instead record
//! the health of the transport itself.
//!
//! Secrets cross this boundary only in [`Redacted`]. Filtering a formatted log
//! line is the wrong shape: a blocklist can only recognise formats already
//! anticipated, while the first new formatter would disclose a credential.
//! `Redacted` keeps its value private and renders the same marker through both
//! `Debug` and `Display`. This follows the redacting token pattern in
//! `gx-control-transport` (invariant 54), but makes the guarantee available to
//! every field that may carry caller-controlled data.
//!
//! Full OpenTelemetry export remains outside this crate's current scope. The
//! typed events here establish the safe emission boundary an exporter will
//! consume later.

#![forbid(unsafe_code)]

use std::fmt;

use gx_contracts::{Epoch, Refusal};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// The visible marker for a deliberately withheld value.
pub const REDACTION_MARKER: &str = "<redacted>";

/// A value which may be retained for work but can never be formatted plainly.
///
/// The inner value is private and this type deliberately implements neither
/// `Deref` nor an accessor. A caller must make an explicit, audited domain
/// decision before it can become a public logging field.
#[must_use]
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    /// Mark a value as secret before it enters an observability record.
    pub fn new(value: T) -> Self {
        Self(value)
    }
}

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTION_MARKER)
    }
}

impl<T> fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTION_MARKER)
    }
}

/// A named observability field, either known public data or a secret.
///
/// The emitters accept this type rather than a rendered message. In
/// particular, [`Field::secret`] only accepts [`Redacted`], preserving the
/// redaction choice until `tracing` formats the field.
#[derive(Clone, Copy)]
pub enum Field<'a> {
    /// A value known not to be a credential.
    Public(&'a str),
    /// A credential-bearing value that must be rendered as the marker.
    Secret(&'a dyn fmt::Display),
}

impl<'a> Field<'a> {
    /// Name a value whose public visibility is part of the event contract.
    pub const fn public(value: &'a str) -> Self {
        Self::Public(value)
    }

    /// Carry a secret into an event without allowing it to be rendered.
    pub fn secret<T>(value: &'a Redacted<T>) -> Self {
        Self::Secret(value)
    }
}

impl fmt::Display for Field<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Public(value) => f.write_str(value),
            Self::Secret(value) => value.fmt(f),
        }
    }
}

/// The control-plane request an audit record describes.
#[derive(Clone, Copy, Debug)]
pub enum AuditRequestKind {
    Authenticate,
    Capability,
    Status,
    Cue,
    Take,
    Clear,
    ConfigureOutput,
}

impl AuditRequestKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Authenticate => "authenticate",
            Self::Capability => "capability",
            Self::Status => "status",
            Self::Cue => "cue",
            Self::Take => "take",
            Self::Clear => "clear",
            Self::ConfigureOutput => "configureOutput",
        }
    }
}

/// The resource a request addresses.
pub enum AuditTarget<'a> {
    /// A take request's stable identifier.
    Take(Field<'a>),
    /// An output configuration's stable identifier.
    Output(Field<'a>),
    /// The transport connection for connection-scoped requests.
    Connection(Field<'a>),
    /// A request which has no narrower resource than its subject.
    None,
}

impl AuditTarget<'_> {
    fn kind_and_value(&self) -> (&'static str, Option<Field<'_>>) {
        match self {
            Self::Take(value) => ("take", Some(*value)),
            Self::Output(value) => ("output", Some(*value)),
            Self::Connection(value) => ("connection", Some(*value)),
            Self::None => ("none", None),
        }
    }
}

/// A successful authorisation decision or the named condition that refused it.
pub enum AuditOutcome<'a> {
    Accepted,
    Refused(&'a Refusal),
}

impl AuditOutcome<'_> {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Refused(_) => "refused",
        }
    }

    fn refusal_name(&self) -> &'static str {
        match self {
            Self::Accepted => "none",
            Self::Refused(refusal) => refusal_name(refusal),
        }
    }
}

/// An authorisation decision with its identity, request, target and epoch.
pub struct AuditRecord<'a> {
    pub subject: Field<'a>,
    pub role: Field<'a>,
    pub request: AuditRequestKind,
    pub target: AuditTarget<'a>,
    pub outcome: AuditOutcome<'a>,
    pub engine_epoch: Epoch,
}

/// An operational occurrence, distinct from an authorisation decision.
pub enum OperationsEvent<'a> {
    Authentication {
        connection: Field<'a>,
        outcome: AuditOutcome<'a>,
    },
    ConnectionClosed {
        connection: Field<'a>,
        reason: Field<'a>,
    },
    ListenerAcceptFailed {
        reason: Field<'a>,
    },
    ListenerStopped {
        reason: Field<'a>,
    },
}

/// Emit one typed observability event.
///
/// There is intentionally no `message: String` parameter. Event identity and
/// every potentially caller-controlled value stay named until the subscriber
/// formats them, so a credential cannot reach an operations line by bypassing
/// [`Redacted`].
pub fn emit(event: LogEvent<'_>) {
    match event {
        LogEvent::Audit(record) => {
            let (target_kind, target) = record.target.kind_and_value();
            match target {
                Some(target) => tracing::info!(
                    event = "audit",
                    subject = %record.subject,
                    role = %record.role,
                    request_kind = record.request.as_str(),
                    target_kind,
                    target = %target,
                    outcome = record.outcome.as_str(),
                    refusal = record.outcome.refusal_name(),
                    engine_epoch = record.engine_epoch.0,
                    "audit"
                ),
                None => tracing::info!(
                    event = "audit",
                    subject = %record.subject,
                    role = %record.role,
                    request_kind = record.request.as_str(),
                    target_kind,
                    outcome = record.outcome.as_str(),
                    refusal = record.outcome.refusal_name(),
                    engine_epoch = record.engine_epoch.0,
                    "audit"
                ),
            }
        }
        LogEvent::Operations(OperationsEvent::Authentication {
            connection,
            outcome,
        }) => tracing::info!(
            event = "operations.authentication",
            connection = %connection,
            outcome = outcome.as_str(),
            refusal = outcome.refusal_name(),
            "operations"
        ),
        LogEvent::Operations(OperationsEvent::ConnectionClosed { connection, reason }) => {
            tracing::info!(
                event = "operations.connectionClosed",
                connection = %connection,
                reason = %reason,
                "operations"
            );
        }
        LogEvent::Operations(OperationsEvent::ListenerAcceptFailed { reason }) => {
            tracing::warn!(
                event = "operations.listenerAcceptFailed",
                reason = %reason,
                "operations"
            );
        }
        LogEvent::Operations(OperationsEvent::ListenerStopped { reason }) => {
            tracing::error!(
                event = "operations.listenerStopped",
                reason = %reason,
                "operations"
            );
        }
    }
}

/// A typed audit record or operations event accepted by [`emit`].
pub enum LogEvent<'a> {
    Audit(AuditRecord<'a>),
    Operations(OperationsEvent<'a>),
}

fn refusal_name(refusal: &Refusal) -> &'static str {
    match refusal {
        Refusal::RevisionMismatch { .. } => "revisionMismatch",
        Refusal::TierTooLow { .. } => "tierTooLow",
        Refusal::ReferenceUnlocked { .. } => "referenceUnlocked",
        Refusal::UnsupportedBlendMode { .. } => "unsupportedBlendMode",
        Refusal::UnsupportedFitMode { .. } => "unsupportedFitMode",
        Refusal::AssetMissing { .. } => "assetMissing",
        Refusal::ProtocolMismatch { .. } => "protocolMismatch",
        Refusal::InvalidRate { .. } => "invalidRate",
        Refusal::PlatformNotCertified { .. } => "platformNotCertified",
        Refusal::UnknownTake { .. } => "unknownTake",
        Refusal::FrameNotReachable { .. } => "frameNotReachable",
        Refusal::MultipleClockDomains { .. } => "multipleClockDomains",
        Refusal::Unauthenticated => "unauthenticated",
        Refusal::TransportFailed { .. } => "transportFailed",
        Refusal::NotImplemented { .. } => "notImplemented",
        Refusal::FontMissing { .. } => "fontMissing",
        Refusal::FontUrlNotHttps { .. } => "fontUrlNotHttps",
        Refusal::FontUrlHasCredentials { .. } => "fontUrlHasCredentials",
        Refusal::InvalidFontUrl { .. } => "invalidFontUrl",
        Refusal::FontEmbeddingRefused { .. } => "fontEmbeddingRefused",
        Refusal::FontPathUnsafe { .. } => "fontPathUnsafe",
        Refusal::FontPathOutsideRoot { .. } => "fontPathOutsideRoot",
        Refusal::FontFetchHostNotTrusted { .. } => "fontFetchHostNotTrusted",
        Refusal::FontFetchAddressDenied { .. } => "fontFetchAddressDenied",
        Refusal::FontStylesheetImportDepthExceeded { .. } => "fontStylesheetImportDepthExceeded",
        Refusal::FontFetchTooLarge { .. } => "fontFetchTooLarge",
        Refusal::FontFetchFailed { .. } => "fontFetchFailed",
        Refusal::AdobeFontLicenceRestricted { .. } => "adobeFontLicenceRestricted",
        Refusal::InvalidFontData { .. } => "invalidFontData",
        Refusal::InvalidColor { .. } => "invalidColor",
        Refusal::PlatformDirectoryUnavailable { .. } => "platformDirectoryUnavailable",
        Refusal::UnknownPackageFormatVersion { .. } => "unknownPackageFormatVersion",
        Refusal::UnsafePackagePath { .. } => "unsafePackagePath",
        Refusal::DuplicatePackagePath { .. } => "duplicatePackagePath",
        Refusal::InvalidPackageHash { .. } => "invalidPackageHash",
        Refusal::PackageEntryMissing { .. } => "packageEntryMissing",
        Refusal::PackageEntryUnreadable { .. } => "packageEntryUnreadable",
        Refusal::PackageFileLengthMismatch { .. } => "packageFileLengthMismatch",
        Refusal::PackageFileHashMismatch { .. } => "packageFileHashMismatch",
        Refusal::PackageScenePinMismatch { .. } => "packageScenePinMismatch",
        Refusal::PackageAssetNotPackaged { .. } => "packageAssetNotPackaged",
        Refusal::ProjectJsonCorrupt { .. } => "projectJsonCorrupt",
        Refusal::UnknownProjectSchema { .. } => "unknownProjectSchema",
        Refusal::ProjectIdLocationMismatch { .. } => "projectIdLocationMismatch",
        Refusal::SceneParseFailed { .. } => "sceneParseFailed",
        Refusal::SceneUnknownField { .. } => "sceneUnknownField",
        Refusal::SceneFontUnknown { .. } => "sceneFontUnknown",
        Refusal::SceneAssetUnknown { .. } => "sceneAssetUnknown",
        Refusal::FontStylesheetImportCycle { .. } => "fontStylesheetImportCycle",
        Refusal::FontFileReadFailed { .. } => "fontFileReadFailed",
        Refusal::FontCacheWriteFailed { .. } => "fontCacheWriteFailed",
    }
}

/// Initialise the global tracing subscriber.
///
/// Idempotent within a process: a second call is a no-op rather than a panic,
/// so a library test and a binary can both call it. The filter honours
/// `RUST_LOG` and defaults to `info`.
///
/// Returns whether this call installed the subscriber (false if one was
/// already set), so a caller that cares can tell.
pub fn init() -> bool {
    try_init_with(std::io::stdout)
}

/// Initialise with a specific writer. Separated from `init` so a test can
/// capture observability records into a buffer and prove their contents.
pub fn try_init_with<W>(writer: W) -> bool
where
    W: for<'a> MakeWriter<'a> + Send + Sync + 'static,
{
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_target(true)
        .try_init()
        .is_ok()
}

/// The engine's per-frame span (ADR B.5: committed vs presented frame).
///
/// A constructor rather than an inline `tracing::info_span!` so the span name
/// and field names are defined once. A series built on `frame` / `committed`
/// breaks loudly here if either is renamed, not silently in a dashboard.
#[must_use]
pub fn frame_span(frame: u64, committed: u64) -> tracing::Span {
    tracing::info_span!("frame", frame, committed)
}

/// The span for a take being resolved and committed.
#[must_use]
pub fn take_span(take_id: &str) -> tracing::Span {
    tracing::info_span!("take", take_id)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::sync::{Arc, Mutex};

    /// A writer that captures everything written to it, so the test can prove
    /// a span reached the collector rather than hoping stdout looked right.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .expect("capture poisoned")
                .extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// Run a block under a fresh subscriber and return what it captured.
    fn with_captured(emit: impl FnOnce()) -> String {
        let capture = Capture::default();
        let buffer = Arc::clone(&capture.0);
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(EnvFilter::new("info"))
            .with_writer(capture)
            .with_target(false)
            .without_time()
            .finish();
        tracing::subscriber::with_default(subscriber, emit);
        let bytes = buffer.lock().expect("capture poisoned").clone();
        String::from_utf8(bytes).expect("tracing output is utf8")
    }

    fn capture_output(emit_events: impl FnOnce()) -> String {
        with_captured(emit_events)
    }

    #[test]
    fn audit_and_operations_events_never_write_a_credential() {
        // 2.10's done-when is negative. Exercise every event and every
        // request/target kind with a plaintext credential in all fields that
        // could carry caller-controlled data; a silent subscriber cannot pass
        // because the redaction marker must also be present.
        const PLAINTEXT_CREDENTIAL: &str = "gx1-credential-must-never-reach-a-log";
        let credential = Redacted::new(PLAINTEXT_CREDENTIAL);
        let refusal = Refusal::FontUrlHasCredentials {
            url: PLAINTEXT_CREDENTIAL.to_owned(),
        };

        let output = capture_output(|| {
            let secret = || Field::secret(&credential);
            for (request, target) in [
                (
                    AuditRequestKind::Authenticate,
                    AuditTarget::Connection(secret()),
                ),
                (AuditRequestKind::Capability, AuditTarget::None),
                (AuditRequestKind::Status, AuditTarget::Connection(secret())),
                (AuditRequestKind::Cue, AuditTarget::Take(secret())),
                (AuditRequestKind::Take, AuditTarget::Take(secret())),
                (AuditRequestKind::Clear, AuditTarget::Take(secret())),
                (
                    AuditRequestKind::ConfigureOutput,
                    AuditTarget::Output(secret()),
                ),
            ] {
                emit(LogEvent::Audit(AuditRecord {
                    subject: secret(),
                    role: secret(),
                    request,
                    target,
                    outcome: AuditOutcome::Refused(&refusal),
                    engine_epoch: Epoch(73),
                }));
            }

            emit(LogEvent::Operations(OperationsEvent::Authentication {
                connection: secret(),
                outcome: AuditOutcome::Refused(&refusal),
            }));
            emit(LogEvent::Operations(OperationsEvent::ConnectionClosed {
                connection: secret(),
                reason: secret(),
            }));
            emit(LogEvent::Operations(
                OperationsEvent::ListenerAcceptFailed { reason: secret() },
            ));
            emit(LogEvent::Operations(OperationsEvent::ListenerStopped {
                reason: secret(),
            }));
        });

        assert!(
            !output.contains(PLAINTEXT_CREDENTIAL),
            "a credential must appear nowhere in audit or operations output: {output:?}"
        );
        assert!(
            output.contains(REDACTION_MARKER),
            "the capture must contain a redaction marker rather than pass empty: {output:?}"
        );
        for event in [
            "event=\"audit\"",
            "event=\"operations.authentication\"",
            "event=\"operations.connectionClosed\"",
            "event=\"operations.listenerAcceptFailed\"",
            "event=\"operations.listenerStopped\"",
        ] {
            assert!(
                output.contains(event),
                "every typed event kind must reach the collector; missing {event:?} from {output:?}"
            );
        }
        assert!(
            output.contains("refusal=\"fontUrlHasCredentials\""),
            "a refusal must be logged by its stable name, not formatted payload: {output:?}"
        );
    }

    #[test]
    fn a_span_reaches_a_collector() {
        // 0.5's done-when: not "tracing is a dependency", but a span actually
        // arriving at a collector, with its fields.
        let output = with_captured(|| {
            let span = frame_span(4242, 4240);
            let _enter = span.enter();
            tracing::info!(late_frames = 2, "late frames dropped, never queued");
        });

        assert!(
            output.contains("frame"),
            "the frame span must reach the collector, got: {output:?}"
        );
        assert!(
            output.contains("4242"),
            "the span fields must reach the collector, got: {output:?}"
        );
        assert!(
            output.contains("late frames dropped"),
            "the event must reach the collector, got: {output:?}"
        );
    }
}

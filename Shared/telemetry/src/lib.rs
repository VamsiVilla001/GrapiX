//! Tracing and observability skeleton (build plan 0.5; ADR B.5).
//!
//! One crate owns how the whole system emits spans, so the engine, the host
//! and the conformance harness instrument identically rather than each growing
//! its own logging. This is deliberately a *skeleton*: it establishes the
//! tracing pipeline and proves a span reaches a collector. Full OpenTelemetry
//! export (the OTLP collector named in ADR B.5) lands with the observability
//! series it serves, before the first soak run — wiring an exporter now, with
//! nothing to observe yet, would be scaffolding dressed as a feature.
//!
//! What this establishes:
//! - one `init` that installs a subscriber, so every binary instruments the
//!   same way;
//! - the span vocabulary the engine will emit (`frame`, `take`, `committed`),
//!   as typed span constructors rather than free-text, so a metric series can
//!   be built on field names that cannot drift;
//! - a test that a span provably reaches a collector, which is 0.5's "done
//!   when".

#![forbid(unsafe_code)]

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

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
/// capture spans into a buffer and assert on them — which is exactly how 0.5's
/// "a span reaches a collector" is proven.
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

    #[test]
    fn a_span_reaches_a_collector() {
        // 0.5's done-when: not "tracing is a dependency", but a span actually
        // arriving at a collector, with its fields.
        let capture = Capture::default();
        let buffer = Arc::clone(&capture.0);

        // Use a per-test subscriber rather than the global one: tests run in
        // one process and the global subscriber can be set only once.
        let filter = EnvFilter::new("info");
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(capture)
            .with_target(false)
            .without_time()
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let span = frame_span(4242, 4240);
            let _enter = span.enter();
            tracing::info!(late_frames = 2, "late frames dropped, never queued");
        });

        let output = String::from_utf8(buffer.lock().expect("capture poisoned").clone())
            .expect("tracing output is utf8");
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

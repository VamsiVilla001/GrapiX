//! Typed scene-preparation diagnostics.
//!
//! Rationale (memory.md rule 10, "report unsupported native features
//! explicitly"): scene preparation used to accumulate free-text `Vec<String>`
//! warnings, and Take-readiness was decided by substring-matching those
//! strings for `"not rendered"` / `"skipped"` / `"missing material"`. That
//! coupled an operational safety decision to prose, which failed in both
//! directions:
//!
//! * **Over-blocking.** `"rounded corners are not rendered yet (drawn sharp)"`
//!   contains `"not rendered"`, so any rect with a corner radius blocked Take
//!   even though nothing was missing from the frame.
//! * **Under-blocking.** A warning phrased `"ignored"` or `"falls back to"`
//!   matched nothing and silently allowed Take.
//!
//! Severity is now carried explicitly on each diagnostic and Take-readiness is
//! derived from it. Every diagnostic also carries a stable machine-readable
//! `code` so controllers and the editor can react to a specific condition
//! without parsing English.

use serde::Serialize;

/// How badly a diagnostic affects the rendered frame.
///
/// Ordering is meaningful and is what Take-readiness is derived from:
/// `Info < Degraded < Omitted < Invalid`, and anything at or above
/// [`DiagnosticSeverity::Omitted`] blocks Take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    /// Rendered exactly as authored. Informational only.
    Info,
    /// Rendered, but with reduced fidelity. Nothing authored is missing from
    /// the frame, so this does not block Take.
    Degraded,
    /// Specific authored content is absent from the frame.
    Omitted,
    /// The frame as a whole does not represent the scene (for example it is
    /// framed by a camera the author did not choose), so no part of it can be
    /// trusted on air.
    Invalid,
}

impl DiagnosticSeverity {
    /// Whether a diagnostic at this severity makes the scene unsafe to Take.
    pub fn blocks_take(self) -> bool {
        self >= DiagnosticSeverity::Omitted
    }
}

/// One machine-readable statement about how the native renderer handled a
/// scene.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneDiagnostic {
    /// Stable dotted identifier, e.g. `object.type.unsupported`. Never
    /// localized and never reworded for style: controllers match on this.
    pub code: String,
    pub severity: DiagnosticSeverity,
    /// Operator-facing English. Safe to reword.
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
}

/// Collector used throughout scene preparation.
///
/// [`DiagnosticSink::push`] is deliberately shaped like `Vec::<String>::push`
/// so that preparation code which has not yet been migrated to typed codes
/// keeps compiling unchanged. Those legacy strings are classified with the
/// historical substring rule, which preserves previous behaviour exactly
/// rather than silently downgrading a real blocker to a warning while the
/// migration is in progress.
#[derive(Debug, Default)]
pub struct DiagnosticSink {
    items: Vec<SceneDiagnostic>,
}

/// The pre-typed classification rule, retained *only* for legacy call sites.
///
/// Migrating a call site to [`DiagnosticSink::emit`] takes it off this path.
fn classify_legacy(message: &str) -> DiagnosticSeverity {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("not rendered")
        || normalized.contains("skipped")
        || normalized.contains("missing material")
    {
        DiagnosticSeverity::Omitted
    } else {
        DiagnosticSeverity::Degraded
    }
}

impl DiagnosticSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an untyped warning, classified by the historical substring rule.
    ///
    /// Shaped like `Vec::push` on purpose; see the struct docs.
    pub fn push(&mut self, message: String) {
        let severity = classify_legacy(&message);
        self.items.push(SceneDiagnostic {
            code: "legacy.unclassified".into(),
            severity,
            message,
            object_id: None,
            object_type: None,
        });
    }

    /// Record a diagnostic with an explicit code and severity.
    pub fn emit(
        &mut self,
        code: impl Into<String>,
        severity: DiagnosticSeverity,
        message: impl Into<String>,
    ) {
        self.items.push(SceneDiagnostic {
            code: code.into(),
            severity,
            message: message.into(),
            object_id: None,
            object_type: None,
        });
    }

    /// Record a diagnostic attributed to a specific scene object.
    pub fn emit_for_object(
        &mut self,
        code: impl Into<String>,
        severity: DiagnosticSeverity,
        message: impl Into<String>,
        object_id: impl Into<String>,
        object_type: impl Into<String>,
    ) {
        self.items.push(SceneDiagnostic {
            code: code.into(),
            severity,
            message: message.into(),
            object_id: Some(object_id.into()),
            object_type: Some(object_type.into()),
        });
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Every diagnostic message, in emission order. This is the backwards
    /// compatible `warnings` list.
    pub fn messages(&self) -> Vec<String> {
        self.items.iter().map(|item| item.message.clone()).collect()
    }

    /// Messages for diagnostics severe enough to make Take unsafe.
    pub fn blockers(&self) -> Vec<String> {
        self.items
            .iter()
            .filter(|item| item.severity.blocks_take())
            .map(|item| item.message.clone())
            .collect()
    }

    pub fn diagnostics(&self) -> &[SceneDiagnostic] {
        &self.items
    }

    /// Consume the sink into `(diagnostics, warnings, take_blockers)`.
    pub fn into_parts(self) -> (Vec<SceneDiagnostic>, Vec<String>, Vec<String>) {
        let warnings = self.messages();
        let blockers = self.blockers();
        (self.items, warnings, blockers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_orders_from_harmless_to_untrustworthy() {
        assert!(DiagnosticSeverity::Info < DiagnosticSeverity::Degraded);
        assert!(DiagnosticSeverity::Degraded < DiagnosticSeverity::Omitted);
        assert!(DiagnosticSeverity::Omitted < DiagnosticSeverity::Invalid);
    }

    #[test]
    fn only_omitted_and_worse_block_take() {
        assert!(!DiagnosticSeverity::Info.blocks_take());
        assert!(!DiagnosticSeverity::Degraded.blocks_take());
        assert!(DiagnosticSeverity::Omitted.blocks_take());
        assert!(DiagnosticSeverity::Invalid.blocks_take());
    }

    #[test]
    fn typed_degraded_diagnostics_do_not_block_take_regardless_of_wording() {
        let mut sink = DiagnosticSink::new();
        // Deliberately contains the legacy magic substring. An explicit
        // severity must win over the prose.
        sink.emit(
            "rect.radius.unsupported",
            DiagnosticSeverity::Degraded,
            "rounded corners are not rendered yet (drawn sharp)",
        );

        assert_eq!(sink.messages().len(), 1);
        assert!(sink.blockers().is_empty());
    }

    #[test]
    fn legacy_pushes_keep_their_previous_classification() {
        let mut sink = DiagnosticSink::new();
        sink.push("text object is NOT rendered".into());
        sink.push("canvas background is not a supported hex color".into());

        assert_eq!(sink.messages().len(), 2);
        assert_eq!(
            sink.blockers(),
            vec!["text object is NOT rendered".to_string()],
            "the substring rule must still catch unmigrated omissions"
        );
    }

    /// The editor consumes this shape via `RendererSceneDiagnostic` in
    /// packages/renderer-protocol. Changing it is a protocol change and must
    /// happen in the same commit on both sides (memory.md rule 7).
    #[test]
    fn wire_shape_matches_the_typescript_contract() {
        let mut sink = DiagnosticSink::new();
        sink.emit_for_object(
            "camera.active.unsupported",
            DiagnosticSeverity::Invalid,
            "framing will not match Preview",
            "cam_1",
            "camera",
        );
        sink.emit(
            "rect.radius.unsupported",
            DiagnosticSeverity::Degraded,
            "drawn sharp",
        );

        let json = serde_json::to_value(sink.diagnostics()).expect("diagnostics must serialize");
        let items = json.as_array().expect("an array");

        assert_eq!(items[0]["code"], "camera.active.unsupported");
        assert_eq!(items[0]["severity"], "invalid");
        assert_eq!(items[0]["objectId"], "cam_1", "camelCase on the wire");
        assert_eq!(items[0]["objectType"], "camera");

        assert_eq!(items[1]["severity"], "degraded");
        assert!(
            items[1].get("objectId").is_none(),
            "scene-wide diagnostics omit object attribution rather than sending null"
        );
    }

    #[test]
    fn object_attribution_is_preserved() {
        let mut sink = DiagnosticSink::new();
        sink.emit_for_object(
            "object.type.unsupported",
            DiagnosticSeverity::Omitted,
            "text is not rendered",
            "text_1",
            "text",
        );

        let diagnostic = &sink.diagnostics()[0];
        assert_eq!(diagnostic.object_id.as_deref(), Some("text_1"));
        assert_eq!(diagnostic.object_type.as_deref(), Some("text"));
    }
}

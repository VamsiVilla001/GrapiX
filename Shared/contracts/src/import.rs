//! The import compatibility report (build plan 7.2).
//!
//! An importer that silently drops what it cannot express is the same fault as
//! a renderer that silently substitutes a blend mode: the result looks
//! plausible and is wrong, and nobody finds out until it is on air. So import
//! carries the discipline invariant 18 applies to rendering — **every
//! departure from the source is named** — and this module is the shape that
//! naming takes.
//!
//! The four tiers are ported from 1.x rather than invented here (ADR-0002
//! A.4). Its importer counted exactly this ladder — `native`,
//! `genericContainers`, `flattened`, and a separate `rasterizedObjects` list —
//! and its `DesignImportIssue` carried the per-object reasons. What 2.0 adds
//! is that the ladder is a closed enum instead of four independent counters,
//! and that a report can be *checked*: an object that landed below `Native`
//! without saying why is a defect the report itself refuses.
//!
//! This lives in contracts, not in the Editor, because three consumers read
//! it: the import pipeline writes it, the fidelity gate (7.3) stores it beside
//! the template, and the MCP surface returns it. Three copies would drift
//! (invariant 27).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ContentHash, RefusalSeverity};

/// How faithfully one source object survived import.
///
/// Declared **least** faithful first, so the derived `Ord` reads as fidelity:
/// `Native > Container > Flattened > Rasterized`. The comparison is the point
/// — "nothing fell below `Flattened`" is a sentence an import gate can
/// assert, and it is only expressible if the ladder is ordered.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum ImportTier {
    /// Became pixels. Vector scalability and editability are gone. That is a
    /// property of the result rather than a rendering choice, which is why it
    /// is the lowest tier and not a warning hung on a higher one.
    Rasterized,
    /// Collapsed into a simpler representation: a group of shapes became one
    /// path, a layer effect was baked into a fill. Still vector, but the
    /// source's structure is gone and cannot be recovered by editing.
    Flattened,
    /// Structure was preserved but no native kind matched, so it landed as a
    /// generic container. Children are intact; the parent's own semantics are
    /// not.
    Container,
    /// Became a first-class object kind (1.2's catalogue) with its authored
    /// properties intact. The only tier that claims full fidelity.
    Native,
}

/// One departure from the source document.
///
/// `reason` is required and free-form; `replaced_with` is what the document
/// now contains. Both are present because "unsupported effect" alone does not
/// tell a designer what they are now looking at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Substitution {
    /// What the source had, in the source's own vocabulary.
    pub source_feature: String,
    /// What the imported document has instead.
    pub replaced_with: String,
    /// Why the substitution was necessary.
    pub reason: String,
    /// How much it matters. Shares the one severity vocabulary with every
    /// other refusal surface (invariant 27) rather than inventing a second.
    pub severity: RefusalSeverity,
}

/// One source object's fate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    /// The object's identity in the source document, so a designer can find it
    /// in the application it came from.
    pub source_id: String,
    pub source_name: String,
    /// Where it landed on the fidelity ladder.
    pub tier: ImportTier,
    /// The scene object it became, when it became one. Absent means it was
    /// dropped entirely — which is only permitted with a substitution saying
    /// so, per [`ImportReport::validate`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub object_id: Option<String>,
    /// Every departure from the source for this object.
    #[serde(default)]
    pub substitutions: Vec<Substitution>,
}

/// A report is malformed in a way that would let a substitution go unnamed.
///
/// Not a `Refusal`: this is the report failing its own contract, caught by the
/// importer before the report is shown to anyone, rather than a decision
/// communicated to a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportReportError {
    /// An object landed below `Native`, or was dropped, without a reason.
    ///
    /// This is the done-when of 7.2 made checkable: "every substitution named
    /// in the report" is only true if a lossy outcome cannot exist without
    /// one.
    UnexplainedLoss {
        source_id: String,
        tier: ImportTier,
    },
    /// The source was not retained, so the import cannot be re-run or audited.
    SourceNotRetained,
}

impl std::fmt::Display for ImportReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexplainedLoss { source_id, tier } => write!(
                f,
                "source object {source_id} landed at {tier:?} with no substitution explaining why"
            ),
            Self::SourceNotRetained => {
                f.write_str("the source document was not retained, so the import cannot be audited")
            }
        }
    }
}

impl std::error::Error for ImportReportError {}

/// What an import produced, and everything it could not carry across.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// The source's format, in its own name: `figma`, `psd`, `ai`, `svg`.
    pub source_format: String,
    pub source_name: String,
    /// The retained source's content address.
    ///
    /// 7.2 requires the source be kept. It is held by hash rather than by path
    /// for the same reason every other asset is (invariant 31): a path can be
    /// relinked underneath the report, and then the report describes an import
    /// of something else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_hash: Option<ContentHash>,
    pub entries: Vec<ImportEntry>,
}

impl ImportReport {
    /// Check that the report honours its own contract.
    ///
    /// Two rules, both from 7.2's done-when. The source must be retained, and
    /// nothing may be lost without a named reason. Calling this is what makes
    /// "every substitution named" an enforced property instead of an
    /// intention.
    pub fn validate(&self) -> Result<(), ImportReportError> {
        if self.source_hash.is_none() {
            return Err(ImportReportError::SourceNotRetained);
        }
        for entry in &self.entries {
            let lossy = entry.tier < ImportTier::Native || entry.object_id.is_none();
            if lossy && entry.substitutions.is_empty() {
                return Err(ImportReportError::UnexplainedLoss {
                    source_id: entry.source_id.clone(),
                    tier: entry.tier,
                });
            }
        }
        Ok(())
    }

    /// Every substitution across every object, in report order.
    pub fn substitutions(&self) -> impl Iterator<Item = &Substitution> {
        self.entries.iter().flat_map(|entry| &entry.substitutions)
    }

    /// The worst tier anything landed on, or `Native` for an empty import.
    ///
    /// An import gate asserts against this rather than counting objects: "this
    /// template rasterised something" is the question worth failing on.
    pub fn worst_tier(&self) -> ImportTier {
        self.entries
            .iter()
            .map(|entry| entry.tier)
            .min()
            .unwrap_or(ImportTier::Native)
    }

    /// The most urgent severity any substitution carried.
    pub fn worst_severity(&self) -> Option<RefusalSeverity> {
        self.substitutions().map(|s| s.severity).max()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(tier: ImportTier, substitutions: Vec<Substitution>) -> ImportEntry {
        ImportEntry {
            source_id: "node-1".into(),
            source_name: "Logo".into(),
            tier,
            object_id: Some("logo".into()),
            substitutions,
        }
    }

    fn substitution(severity: RefusalSeverity) -> Substitution {
        Substitution {
            source_feature: "layer effect: inner shadow".into(),
            replaced_with: "baked into the fill".into(),
            reason: "no native inner-shadow object exists".into(),
            severity,
        }
    }

    fn report(entries: Vec<ImportEntry>) -> ImportReport {
        ImportReport {
            source_format: "figma".into(),
            source_name: "lower-third.fig".into(),
            source_hash: Some(ContentHash("abc".into())),
            entries,
        }
    }

    #[test]
    fn fidelity_ordering_reads_native_highest() {
        // The gate asserts "nothing fell below X", so the ordering is load
        // bearing rather than cosmetic.
        assert!(ImportTier::Native > ImportTier::Container);
        assert!(ImportTier::Container > ImportTier::Flattened);
        assert!(ImportTier::Flattened > ImportTier::Rasterized);
    }

    #[test]
    fn a_lossy_object_without_a_reason_is_refused() {
        // 7.2's done-when: every substitution named. An object that dropped a
        // tier and said nothing is exactly the silent loss this prevents.
        let error = report(vec![entry(ImportTier::Flattened, Vec::new())])
            .validate()
            .expect_err("an unexplained demotion must be caught");
        assert!(matches!(
            error,
            ImportReportError::UnexplainedLoss {
                tier: ImportTier::Flattened,
                ..
            }
        ));
    }

    #[test]
    fn a_dropped_object_without_a_reason_is_refused_even_at_native() {
        // Absent `object_id` means nothing was produced. Landing "natively"
        // and producing nothing is a contradiction the report must not carry.
        let mut dropped = entry(ImportTier::Native, Vec::new());
        dropped.object_id = None;
        let error = report(vec![dropped])
            .validate()
            .expect_err("a dropped object must be explained");
        assert!(matches!(error, ImportReportError::UnexplainedLoss { .. }));
    }

    #[test]
    fn a_faithful_object_needs_no_substitution() {
        report(vec![entry(ImportTier::Native, Vec::new())])
            .validate()
            .expect("a native object that kept everything has nothing to explain");
    }

    #[test]
    fn an_unretained_source_is_refused() {
        let mut without = report(vec![entry(ImportTier::Native, Vec::new())]);
        without.source_hash = None;
        assert_eq!(
            without.validate(),
            Err(ImportReportError::SourceNotRetained),
            "7.2 requires the source be kept so the import can be audited"
        );
    }

    #[test]
    fn worst_tier_and_severity_summarise_the_whole_import() {
        let r = report(vec![
            entry(ImportTier::Native, Vec::new()),
            entry(
                ImportTier::Rasterized,
                vec![substitution(RefusalSeverity::Warning)],
            ),
            entry(
                ImportTier::Container,
                vec![substitution(RefusalSeverity::Info)],
            ),
        ]);
        r.validate().expect("every demotion is explained");
        assert_eq!(r.worst_tier(), ImportTier::Rasterized);
        assert_eq!(r.worst_severity(), Some(RefusalSeverity::Warning));
        assert_eq!(r.substitutions().count(), 2);
    }
}

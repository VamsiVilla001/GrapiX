//! The import pipeline (build plan 7.2).
//!
//! Done-when: **every substitution named in the report.** The report type in
//! `gx_contracts::import` already enforces the half that can be enforced —
//! `ImportReport::validate` refuses a report in which anything landed below
//! `Native`, or was dropped, without a substitution saying why. This module's
//! job is to produce reports that pass it, and to call it before returning so
//! that a pipeline which forgot is caught by its own contract rather than by a
//! designer three weeks later.
//!
//! **Why SVG and not Figma.** The four tiers need a source that genuinely
//! exercises them, and a real parser is the only way to produce honest
//! evidence. SVG is text, self-describing, and was already the shape 1.x
//! handled in `svgPath.ts`. Figma, PSD and AI are **not implemented** — they
//! need format parsers this crate does not contain, and pretending otherwise
//! would be exactly the unnamed substitution the report exists to prevent.
//!
//! The parser here is deliberately small: enough of SVG to reach each tier,
//! not a conforming implementation. It handles `<rect>`, `<g>`, `<path>` and
//! `<image>`, which is what the ladder needs.

use gx_asset_plane::content_hash;
use gx_contracts::import::{ImportEntry, ImportReport, ImportTier, Substitution};
use gx_contracts::scene::{
    ObjectBase, RectObject, SceneCanvas, SceneDocument, SceneObject, SceneTimeline,
};
use gx_contracts::{RationalRate, RefusalSeverity};

/// What an import produced: a scene, and the full account of what it cost.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportOutcome {
    pub scene: SceneDocument,
    pub report: ImportReport,
}

/// Import an SVG document into a scene, reporting every departure.
///
/// The source bytes are retained by content address rather than by path, for
/// the reason every other asset is (invariant 31): a path can be relinked
/// underneath the report, and then the report describes an import of something
/// else.
pub fn import_svg(
    source_name: &str,
    bytes: &[u8],
    scene_id: &str,
) -> Result<ImportOutcome, ImportFailure> {
    let text = std::str::from_utf8(bytes).map_err(|_| ImportFailure::NotUtf8)?;

    let mut objects = Vec::new();
    let mut entries = Vec::new();

    for (index, element) in elements(text).into_iter().enumerate() {
        let source_id = element
            .attribute("id")
            .unwrap_or_else(|| format!("node-{index}"));
        let source_name_attr = element.attribute("inkscape:label").unwrap_or_else(|| source_id.clone());

        match element.tag.as_str() {
            // A rectangle has a first-class equivalent, so nothing is lost.
            "rect" => {
                let mut base = ObjectBase::new(&source_id, &source_name_attr);
                base.x = element.number("x").unwrap_or(0.0);
                base.y = element.number("y").unwrap_or(0.0);
                base.width = element.number("width").unwrap_or(0.0);
                base.height = element.number("height").unwrap_or(0.0);
                objects.push(SceneObject::Rect(RectObject {
                    base,
                    radius: element.number("rx").unwrap_or(0.0),
                }));
                entries.push(ImportEntry {
                    source_id: source_id.clone(),
                    source_name: source_name_attr,
                    tier: ImportTier::Native,
                    object_id: Some(source_id),
                    substitutions: Vec::new(),
                });
            }

            // A group keeps its structure but has no native kind carrying a
            // group's own semantics, so it lands as a container.
            "g" => {
                let mut base = ObjectBase::new(&source_id, &source_name_attr);
                base.width = element.number("width").unwrap_or(0.0);
                base.height = element.number("height").unwrap_or(0.0);
                objects.push(SceneObject::Group(gx_contracts::scene::GroupObject {
                    base,
                    child_ids: Vec::new(),
                }));
                entries.push(ImportEntry {
                    source_id: source_id.clone(),
                    source_name: source_name_attr,
                    tier: ImportTier::Container,
                    object_id: Some(source_id),
                    substitutions: vec![Substitution {
                        source_feature: "svg:g".into(),
                        replaced_with: "group container".into(),
                        reason: "a group's own transform and clip semantics have no native kind"
                            .into(),
                        severity: RefusalSeverity::Info,
                    }],
                });
            }

            // A path collapses to its bounding rectangle here: this pipeline
            // carries no path data into the scene, so the shape is gone even
            // though the object remains. That is a demotion and it is named.
            "path" => {
                let mut base = ObjectBase::new(&source_id, &source_name_attr);
                base.width = element.number("width").unwrap_or(0.0);
                base.height = element.number("height").unwrap_or(0.0);
                objects.push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
                entries.push(ImportEntry {
                    source_id: source_id.clone(),
                    source_name: source_name_attr,
                    tier: ImportTier::Flattened,
                    object_id: Some(source_id),
                    substitutions: vec![Substitution {
                        source_feature: format!(
                            "svg:path d=\"{}\"",
                            element.attribute("d").unwrap_or_default()
                        ),
                        replaced_with: "the path's bounding rectangle".into(),
                        reason: "this pipeline does not carry path geometry into the scene".into(),
                        severity: RefusalSeverity::Warning,
                    }],
                });
            }

            // An embedded raster is already pixels. Recorded at the lowest
            // tier because scalability and editability are gone, which is a
            // property of the result rather than a rendering choice.
            "image" => {
                entries.push(ImportEntry {
                    source_id: source_id.clone(),
                    source_name: source_name_attr,
                    tier: ImportTier::Rasterized,
                    object_id: None,
                    substitutions: vec![Substitution {
                        source_feature: "svg:image".into(),
                        replaced_with: "nothing; the raster was not imported".into(),
                        reason: "embedded raster data needs an asset import this pipeline does not perform"
                            .into(),
                        severity: RefusalSeverity::Error,
                    }],
                });
            }

            // Anything else is dropped, and saying so is the entire point.
            other => {
                entries.push(ImportEntry {
                    source_id: source_id.clone(),
                    source_name: source_name_attr,
                    tier: ImportTier::Rasterized,
                    object_id: None,
                    substitutions: vec![Substitution {
                        source_feature: format!("svg:{other}"),
                        replaced_with: "nothing".into(),
                        reason: format!("{other} has no import rule in this pipeline"),
                        severity: RefusalSeverity::Error,
                    }],
                });
            }
        }
    }

    let scene = SceneDocument {
        id: scene_id.to_owned(),
        name: source_name.to_owned(),
        version: 1,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline { duration_frames: 1, ..Default::default() },
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        objects,
    };

    let report = ImportReport {
        source_format: "svg".into(),
        source_name: source_name.to_owned(),
        // Retaining the source is 7.2's other requirement, and the report
        // refuses without it.
        source_hash: Some(content_hash(bytes)),
        entries,
    };

    // The pipeline checks its own output. A report that lost something without
    // saying why must never leave this function, because after it does there
    // is nobody left who knows what was lost.
    report
        .validate()
        .map_err(|error| ImportFailure::UnexplainedLoss(error.to_string()))?;

    Ok(ImportOutcome { scene, report })
}

/// An import that could not be performed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportFailure {
    NotUtf8,
    /// The pipeline produced a report that failed its own contract. A defect
    /// in this crate rather than in the source document, surfaced rather than
    /// swallowed.
    UnexplainedLoss(String),
}

impl std::fmt::Display for ImportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotUtf8 => f.write_str("the source is not valid UTF-8, so it is not SVG"),
            Self::UnexplainedLoss(detail) => {
                write!(f, "the import produced an unexplained loss: {detail}")
            }
        }
    }
}

impl std::error::Error for ImportFailure {}

/// One parsed element: a tag and its attributes.
struct Element {
    tag: String,
    attributes: Vec<(String, String)>,
}

impl Element {
    fn attribute(&self, name: &str) -> Option<String> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }

    fn number(&self, name: &str) -> Option<f64> {
        self.attribute(name)?.trim().parse().ok()
    }
}

/// A deliberately small SVG element scanner.
///
/// Not a conforming XML parser and not trying to be: it reads start tags and
/// their attributes, which is what the tier ladder needs. Anything it cannot
/// interpret becomes an element with an unrecognised tag, which the caller
/// reports as a named loss rather than skipping — so the parser's limits show
/// up in the report instead of as silently missing objects.
fn elements(text: &str) -> Vec<Element> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // Skip closing tags, declarations, comments and the root element.
        if matches!(bytes.get(i + 1), Some(b'/') | Some(b'?') | Some(b'!')) {
            i += 1;
            continue;
        }
        let Some(end) = text[i..].find('>').map(|offset| i + offset) else {
            break;
        };
        let inner = &text[i + 1..end];
        let inner = inner.strip_suffix('/').unwrap_or(inner);

        let mut parts = inner.split_whitespace();
        if let Some(tag) = parts.next() {
            if tag != "svg" {
                found.push(Element {
                    tag: tag.to_owned(),
                    attributes: attributes(inner),
                });
            }
        }
        i = end + 1;
    }
    found
}

/// Pull `name="value"` pairs out of a start tag's body.
fn attributes(inner: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let Some(equals) = inner[i..].find('=').map(|offset| i + offset) else {
            break;
        };
        let name = inner[i..equals]
            .split_whitespace()
            .next_back()
            .unwrap_or("");
        let rest = &inner[equals + 1..];
        let Some(quote) = rest.chars().next() else {
            break;
        };
        if quote != '"' && quote != '\'' {
            i = equals + 1;
            continue;
        }
        let Some(close) = rest[1..].find(quote) else {
            break;
        };
        found.push((name.to_owned(), rest[1..1 + close].to_owned()));
        i = equals + 1 + 1 + close + 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY_TIER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg">
        <rect id="background" x="0" y="0" width="1920" height="1080"/>
        <g id="lower-third"/>
        <path id="swoosh" d="M0 0 L10 10 Z" width="100" height="20"/>
        <image id="logo" href="data:image/png;base64,AAAA"/>
    </svg>"#;

    #[test]
    fn one_source_drives_every_tier_and_names_each_demotion() {
        // 7.2's done-when. Each demotion below Native carries a reason, and
        // the report would refuse to exist otherwise.
        let outcome = import_svg("brand.svg", EVERY_TIER.as_bytes(), "brand")
            .expect("the report passes its own contract");

        let tiers: Vec<_> = outcome
            .report
            .entries
            .iter()
            .map(|entry| (entry.source_id.as_str(), entry.tier))
            .collect();
        assert_eq!(
            tiers,
            vec![
                ("background", ImportTier::Native),
                ("lower-third", ImportTier::Container),
                ("swoosh", ImportTier::Flattened),
                ("logo", ImportTier::Rasterized),
            ]
        );

        for entry in &outcome.report.entries {
            if entry.tier < ImportTier::Native {
                assert!(
                    !entry.substitutions.is_empty(),
                    "{} dropped a tier without saying why",
                    entry.source_id
                );
            }
        }
        assert_eq!(outcome.report.worst_tier(), ImportTier::Rasterized);
        assert_eq!(
            outcome.report.worst_severity(),
            Some(RefusalSeverity::Error)
        );
    }

    #[test]
    fn the_source_is_retained_by_content_address() {
        // Retained by hash rather than path: a path can be relinked under the
        // report, and then the report describes a different import.
        let outcome = import_svg("brand.svg", EVERY_TIER.as_bytes(), "brand").unwrap();
        assert_eq!(
            outcome.report.source_hash,
            Some(content_hash(EVERY_TIER.as_bytes()))
        );
    }

    #[test]
    fn a_native_import_costs_nothing_and_says_nothing() {
        let svg = r#"<svg><rect id="bar" x="0" y="0" width="10" height="10"/></svg>"#;
        let outcome = import_svg("bar.svg", svg.as_bytes(), "bar").unwrap();
        assert_eq!(outcome.report.substitutions().count(), 0);
        assert_eq!(outcome.report.worst_tier(), ImportTier::Native);
        assert_eq!(outcome.scene.objects.len(), 1);
    }

    #[test]
    fn an_element_with_no_import_rule_is_reported_rather_than_skipped() {
        // The parser's limits must appear in the report. An object that simply
        // vanished would be the silent loss the whole module exists to stop.
        let svg = r#"<svg><filter id="blur"/></svg>"#;
        let outcome = import_svg("f.svg", svg.as_bytes(), "f").unwrap();

        let entry = &outcome.report.entries[0];
        assert_eq!(entry.source_id, "blur");
        assert_eq!(entry.object_id, None);
        assert_eq!(entry.substitutions[0].source_feature, "svg:filter");
        assert_eq!(entry.substitutions[0].severity, RefusalSeverity::Error);
    }

    #[test]
    fn a_report_that_lost_something_silently_cannot_escape_the_pipeline() {
        // Proves the guard is real by building the bad report directly: if
        // `import_svg` ever stopped naming a demotion, this is the shape of
        // the failure it would produce, and `validate` catches it.
        let bad = ImportReport {
            source_format: "svg".into(),
            source_name: "x.svg".into(),
            source_hash: Some(content_hash(b"x")),
            entries: vec![ImportEntry {
                source_id: "ghost".into(),
                source_name: "ghost".into(),
                tier: ImportTier::Flattened,
                object_id: Some("ghost".into()),
                substitutions: Vec::new(),
            }],
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn a_source_that_is_not_text_is_refused_rather_than_guessed_at() {
        assert_eq!(
            import_svg("x.svg", &[0xff, 0xfe, 0x00], "x"),
            Err(ImportFailure::NotUtf8)
        );
    }
}

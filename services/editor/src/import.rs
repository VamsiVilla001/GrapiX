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
use gx_contracts::provenance::{AssetOrigin, AssetProvenance, ProvenanceTool};
use gx_contracts::scene::{
    AssetKind, AssetLibraryItem, BezierPath, FillRule, ObjectBase, RectObject, SceneCanvas,
    SceneDocument, SceneObject, SceneTimeline, ShapeObject,
};
use gx_contracts::{RationalRate, RefusalSeverity};

/// What an import produced: a scene, and the full account of what it cost.
/// Every command surface carries the report beside the scene as an
/// `Imported` effect, so a scene is never shown without what it lost.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportOutcome {
    pub scene: SceneDocument,
    pub report: ImportReport,
}

/// The tool an imported source's provenance names (11.39).
pub const IMPORT_TOOL: &str = "GrapiX import";

/// The library record for a retained source: kind `svg`, addressed by its
/// content hash, filed under `assets/imports/`. The scene carries it so the
/// report's `source_hash` names an asset the graphic owns, and saving the
/// graphic into a project takes the bytes with it like any other asset.
pub fn source_asset(source_name: &str, bytes: &[u8]) -> AssetLibraryItem {
    retained_source(source_name, bytes, SourceKind::Svg)
}

/// What kind of source an import retains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Svg,
    /// The text of a Figma `get_metadata` reply, as the user's agent read it.
    FigmaMetadata,
    /// A Figma frame as an agent wrote it into the typed frame shape (canonical JSON).
    FigmaFrame,
}

/// The library record for a retained source of any kind (7.2, 18.2).
pub fn retained_source(source_name: &str, bytes: &[u8], kind: SourceKind) -> AssetLibraryItem {
    let hash = content_hash(bytes);
    let (asset_kind, mime, extension) = match kind {
        SourceKind::Svg => (AssetKind::Svg, "image/svg+xml", "svg"),
        SourceKind::FigmaMetadata => (AssetKind::Unknown, "application/xml", "xml"),
        SourceKind::FigmaFrame => (AssetKind::Json, "application/json", "json"),
    };
    // A file name that is not one canonical component would address a path
    // the library does not own; the hash-named fallback never can.
    let file_name = if gx_contracts::platform::is_canonical_filename(source_name) {
        source_name.to_owned()
    } else {
        format!("{}.{extension}", &hash.0[..16])
    };
    AssetLibraryItem {
        asset_id: format!("import_{}", &hash.0[..16]),
        name: source_name.to_owned(),
        kind: asset_kind,
        path: format!("assets/imports/{file_name}"),
        checksum: Some(hash),
        mime_type: Some(mime.into()),
        size_bytes: Some(bytes.len() as u64),
        status: None,
        provenance: AssetProvenance {
            origin: Some(AssetOrigin::Human),
            tool: Some(ProvenanceTool {
                name: IMPORT_TOOL.into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            }),
            sources: vec![source_name.to_owned()],
            ..AssetProvenance::default()
        },
        color_space: None,
    }
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

    for (index, element) in elements(text)?.into_iter().enumerate() {
        let source_id = element
            .attribute("id")
            .unwrap_or_else(|| format!("node-{index}"));
        let source_name_attr = element
            .attribute("inkscape:label")
            .unwrap_or_else(|| source_id.clone());

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
                    clip_child_id: None,
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

            // A path is a shape (11.114): its data becomes cubic subpaths, the first the
            // shape's own and the rest compound paths, with the `fill-rule` and a simple
            // `fill`. Only data that cannot be read at all collapses to its bounding
            // rectangle, and that demotion is named with the reason.
            "path" => {
                let data = element.attribute("d").unwrap_or_default();
                match svg_shape(&element, &data, &source_id, &source_name_attr) {
                    Ok((shape, notes)) => {
                        objects.push(SceneObject::Shape(shape));
                        entries.push(ImportEntry {
                            source_id: source_id.clone(),
                            source_name: source_name_attr,
                            tier: ImportTier::Native,
                            object_id: Some(source_id),
                            substitutions: notes
                                .into_iter()
                                .map(|(feature, replaced_with, reason)| Substitution {
                                    source_feature: feature,
                                    replaced_with,
                                    reason,
                                    severity: RefusalSeverity::Info,
                                })
                                .collect(),
                        });
                    }
                    Err(why) => {
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
                                source_feature: format!("svg:path d=\"{data}\""),
                                replaced_with: "the path's bounding rectangle".into(),
                                reason: why,
                                severity: RefusalSeverity::Warning,
                            }],
                        });
                    }
                }
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
        // SVG composites in sRGB (its default `color-interpolation`), so the
        // imported scene declares the space its source was drawn in (3.15).
        // Saving it into a linear project refuses by name rather than
        // re-blending it silently.
        working_color_space: gx_contracts::color::WorkingColorSpace::Srgb,
        color_depth: gx_contracts::color::ColorDepth::NEW_PROJECT,
        id: scene_id.to_owned(),
        name: source_name.to_owned(),
        version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 1,
            ..Default::default()
        },
        data_context: Default::default(),
        // The source itself, retained with the graphic (7.2).
        assets: vec![source_asset(source_name, bytes)],
        fonts: Vec::new(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        path_links: Vec::new(),
        guides: Vec::new(),
        scene_label: None,
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
    /// The text is not a whole SVG document: no `<svg>` root, a tag that
    /// never closes, or a root that is never closed. A truncated file would
    /// otherwise import as whatever came before the cut, with no report of
    /// what was lost after it.
    Malformed(String),
    /// The pipeline produced a report that failed its own contract. A defect
    /// in this crate rather than in the source document, surfaced rather than
    /// swallowed.
    UnexplainedLoss(String),
}

impl std::fmt::Display for ImportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotUtf8 => f.write_str("the source is not valid UTF-8, so it is not SVG"),
            Self::Malformed(detail) => {
                write!(f, "the source is not a whole document: {detail}")
            }
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

/// A shape from an SVG `<path>`: its subpaths, the fill rule and a simple fill, and what was changed on the way
/// (as `(feature, replaced with, reason)`). `Err` carries why the data could not become a shape at all.
fn svg_shape(
    element: &Element,
    data: &str,
    id: &str,
    name: &str,
) -> Result<(ShapeObject, Vec<(String, String, String)>), String> {
    use gx_contracts::color::{ColorValue, Rgba};
    let parsed = gx_contracts::svg_path::parse(data)
        .map_err(|error| format!("the path data could not be read ({error})"))?;
    let mut notes: Vec<(String, String, String)> = Vec::new();
    let usable = |p: &BezierPath| p.vertices.len() >= if p.closed { 3 } else { 2 };
    let dropped = parsed.subpaths.iter().filter(|p| !usable(p)).count();
    let mut subpaths: Vec<BezierPath> = parsed.subpaths.into_iter().filter(usable).collect();
    if subpaths.is_empty() {
        return Err("the path has no segment to draw".into());
    }
    if dropped > 0 {
        notes.push((
            "svg:path subpath".into(),
            "left out".into(),
            format!("{dropped} subpath(s) with too few points to draw"),
        ));
    }
    for note in parsed.notes {
        notes.push(("svg:path A".into(), "cubic curves".into(), note));
    }
    let path = subpaths.remove(0);
    let (mut low, mut high) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
    for vertex in std::iter::once(&path).chain(&subpaths).flat_map(|p| &p.vertices) {
        low = (low.0.min(vertex.x), low.1.min(vertex.y));
        high = (high.0.max(vertex.x), high.1.max(vertex.y));
    }
    let mut base = ObjectBase::new(id, name);
    base.width = high.0 - low.0;
    base.height = high.1 - low.1;
    // A fill that is not a hex colour or `none` is not read: the shape takes the default grey, and the report says so.
    let mut fill_enabled = true;
    base.fill = Some(ColorValue::Solid {
        color: Rgba::srgb(0.5, 0.5, 0.5, 1.0),
    });
    if let Some(fill) = element.attribute("fill") {
        let fill = fill.trim().to_ascii_lowercase();
        if fill == "none" {
            fill_enabled = false;
        } else if let Some((r, g, b)) = hex_colour(&fill) {
            base.fill = Some(ColorValue::Solid {
                color: Rgba::srgb(r, g, b, 1.0),
            });
        } else {
            notes.push((
                format!("svg:path fill=\"{fill}\""),
                "the default grey".into(),
                "only hex colours and none are read as a fill".into(),
            ));
        }
    }
    let fill_rule = match element.attribute("fill-rule").as_deref().map(str::trim) {
        Some("evenodd") => FillRule::Evenodd,
        _ => FillRule::Nonzero,
    };
    Ok((
        ShapeObject {
            base,
            path,
            compound_paths: (!subpaths.is_empty()).then_some(subpaths),
            fill_enabled,
            stroke_enabled: false,
            fill_rule,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
            contour_ids: None,
        },
        notes,
    ))
}

/// `#rgb` or `#rrggbb` as 0 to 1 channels.
fn hex_colour(text: &str) -> Option<(f64, f64, f64)> {
    let digits = text.strip_prefix('#')?;
    let channel = |s: &str| u8::from_str_radix(s, 16).ok().map(|v| f64::from(v) / 255.0);
    match digits.len() {
        3 => {
            let d: Vec<String> = digits.chars().map(|c| format!("{c}{c}")).collect();
            Some((channel(&d[0])?, channel(&d[1])?, channel(&d[2])?))
        }
        6 => Some((channel(&digits[0..2])?, channel(&digits[2..4])?, channel(&digits[4..6])?)),
        _ => None,
    }
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
fn elements(text: &str) -> Result<Vec<Element>, ImportFailure> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    // Whether the root was seen, and whether it closes itself (`<svg/>`).
    let mut root: Option<bool> = None;

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
            return Err(ImportFailure::Malformed(format!(
                "the tag opened at byte {i} is never closed"
            )));
        };
        let inner = &text[i + 1..end];
        let self_closing = inner.ends_with('/');
        let inner = inner.strip_suffix('/').unwrap_or(inner);

        let mut parts = inner.split_whitespace();
        if let Some(tag) = parts.next() {
            if tag == "svg" {
                root.get_or_insert(self_closing);
            } else {
                found.push(Element {
                    tag: tag.to_owned(),
                    attributes: attributes(inner),
                });
            }
        }
        i = end + 1;
    }
    match root {
        None => Err(ImportFailure::Malformed(
            "there is no <svg> root element".into(),
        )),
        Some(false) if !text.contains("</svg>") => Err(ImportFailure::Malformed(
            "the <svg> root is never closed, so the file is cut short".into(),
        )),
        Some(_) => Ok(found),
    }
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
        <path id="swoosh" d="M0 0 L10" width="100" height="20"/>
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
    fn a_path_becomes_a_shape_with_its_holes_fill_rule_and_colour() {
        // 11.114: a square with a square hole, evenodd, a hex fill, and an arc that is turned into cubics.
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
            <path id="frame" fill="#ff8000" fill-rule="evenodd"
                  d="M0 0 L100 0 L100 100 L0 100 Z M25 25 L25 75 L75 75 L75 25 Z"/>
            <path id="dome" fill="none" d="M0 0 A50 50 0 0 1 100 0"/>
            <path id="odd" fill="url(#g)" d="M0 0 L10 0 L10 10 Z"/>
        </svg>"##;
        let outcome = import_svg("paths.svg", svg.as_bytes(), "paths").unwrap();
        let shape = |id: &str| {
            outcome
                .scene
                .objects
                .iter()
                .find_map(|o| match o {
                    SceneObject::Shape(s) if s.base.id == id => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| panic!("{id} is a shape"))
        };
        let frame = shape("frame");
        assert!(frame.path.closed && frame.path.vertices.len() == 4);
        assert_eq!(frame.compound_paths.as_ref().map(Vec::len), Some(1));
        assert_eq!(frame.fill_rule, FillRule::Evenodd);
        assert_eq!((frame.base.width, frame.base.height), (100.0, 100.0));
        assert!(frame.fill_enabled);
        assert!(matches!(&frame.base.fill, Some(gx_contracts::color::ColorValue::Solid { color }) if (color.r - 1.0).abs() < 1e-9));
        let dome = shape("dome");
        assert!(!dome.fill_enabled, "fill none");
        assert!(dome.path.vertices.len() >= 3, "a half turn is at least two cubics");
        let tiers: Vec<_> = outcome.report.entries.iter().map(|e| (e.source_id.as_str(), e.tier)).collect();
        assert_eq!(
            tiers,
            vec![("frame", ImportTier::Native), ("dome", ImportTier::Native), ("odd", ImportTier::Native)]
        );
        // What was changed is said: the arc, and the fill that is not read.
        let said = |id: &str| outcome.report.entries.iter().find(|e| e.source_id == id).unwrap().substitutions.clone();
        assert!(said("dome")[0].reason.contains("arcs were turned into cubic curves"));
        assert!(said("odd")[0].source_feature.contains("url(#g)"));
        assert!(said("frame").is_empty());
        outcome.report.validate().unwrap();
    }

    #[test]
    fn path_data_that_cannot_be_read_is_flattened_with_the_reason() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><path id="bad" d="M0 0 L5" width="10" height="10"/><path id="empty" d="M5 5" width="1" height="1"/></svg>"#;
        let outcome = import_svg("bad.svg", svg.as_bytes(), "bad").unwrap();
        for (id, says) in [("bad", "could not be read"), ("empty", "no segment")] {
            let entry = outcome.report.entries.iter().find(|e| e.source_id == id).unwrap();
            assert_eq!(entry.tier, ImportTier::Flattened, "{id}");
            assert!(entry.substitutions[0].reason.contains(says), "{id}: {}", entry.substitutions[0].reason);
        }
        outcome.report.validate().unwrap();
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
    fn a_cut_short_or_rootless_source_is_refused_rather_than_half_imported() {
        for (svg, says) in [
            ("<svg><rect id=\"a\"/><rect", "never closed"),
            ("<svg><rect id=\"a\"/>", "cut short"),
            ("<rect id=\"a\"/>", "no <svg> root"),
        ] {
            let error = import_svg("cut.svg", svg.as_bytes(), "cut").expect_err(svg);
            assert!(
                matches!(&error, ImportFailure::Malformed(_)),
                "{svg}: {error:?}"
            );
            assert!(error.to_string().contains(says), "{svg}: {error}");
        }
        assert!(
            import_svg("empty.svg", b"<svg/>", "empty").is_ok(),
            "an empty but whole document imports"
        );
    }

    #[test]
    fn a_source_that_is_not_text_is_refused_rather_than_guessed_at() {
        assert_eq!(
            import_svg("x.svg", &[0xff, 0xfe, 0x00], "x"),
            Err(ImportFailure::NotUtf8)
        );
    }
}

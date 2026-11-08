//! Design-system ingest, review and the versioned store (build plan 10.1–10.5).
//!
//! Part G's rule for this whole area is that **a wrong token set is worse than
//! no token set, because everything downstream trusts it**. Three consequences
//! are structural here rather than advisory:
//!
//! - **Nothing auto-commits.** Ingest returns a [`DesignSystemDraft`]. Only
//!   [`DesignSystemStore::confirm`] turns a draft into a version, and it takes
//!   the confirming human's name as an argument it refuses to invent.
//! - **Ingest is lossless.** The mapped tokens are the enforceable projection;
//!   the complete source document is retained beside them, so re-export is a
//!   read rather than a re-import of something already narrowed.
//! - **What could not be expressed is named, with its value.** A path and a
//!   message cannot tell a reviewer whether the draft discards a load-bearing
//!   rule. The original value travels with the complaint.
//!
//! A version is a directory, exactly as G.3 lays out, and it is immutable:
//! `confirm` refuses to write a version that already exists rather than
//! replacing it, so "v4, never an edit to v3" is enforced by the filesystem
//! and not by convention.

use std::path::{Path, PathBuf};

use gx_contracts::color::Rgba;
use gx_contracts::design_system::{
    DesignSystem, DesignSystemDraft, DesignSystemSource, DesignSystemSourceKind, DraftVisualTokens,
    MotionTokens, Named, NamedEasing, TokenMapping, UnexpressibleToken, VisualTokens,
};
use gx_contracts::Refusal;
use serde::Serialize;
use serde_json::Value;

use crate::project::EditorError;

/// The importer version stamped into provenance.
///
/// Recorded because a draft's fidelity is a property of the code that produced
/// it: when the mapper improves, "which versions predate that fix" has to be a
/// query rather than an investigation.
pub const IMPORTER_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// 10.1 — W3C Design Tokens JSON
// ---------------------------------------------------------------------------

/// Read a source document, keeping the bytes it arrived as.
///
/// Parsing here rather than in the caller is what gives the ingest functions'
/// `Result` a real use: a malformed brand pack is refused by name instead of
/// arriving as an empty token set that looks like a source containing nothing.
fn read_source(bytes: &[u8]) -> Result<(Value, String), Refusal> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| Refusal::DesignSourceUnreadable {
            detail: error.to_string(),
        })?
        .to_owned();
    let value = serde_json::from_str(&text).map_err(|error| Refusal::DesignSourceUnreadable {
        detail: error.to_string(),
    })?;
    Ok((value, text))
}

/// Ingest a W3C Design Tokens document (10.1).
///
/// The traversal follows the specification's shape: a token is an object
/// carrying `$value`, any other object is a group, and `$type` is inherited
/// from the nearest ancestor that declares one. Everything the token contract
/// cannot hold is reported rather than dropped.
///
/// Takes bytes rather than a parsed value so the retained source and its hash
/// are the file itself. See [`DesignSystemSource`].
pub fn ingest_w3c(name: &str, bytes: &[u8]) -> Result<DesignSystemDraft, Refusal> {
    let (document, text) = read_source(bytes)?;
    let mut builder = DraftBuilder::default();
    walk_w3c(&document, &mut Vec::new(), None, &mut builder);
    Ok(builder.finish(
        name,
        DesignSystemSourceKind::W3c,
        bytes,
        text,
        String::new(),
    ))
}

fn walk_w3c(
    node: &Value,
    path: &mut Vec<String>,
    inherited_type: Option<&str>,
    out: &mut DraftBuilder,
) {
    let Some(object) = node.as_object() else {
        return;
    };

    // `$type` is inherited by descendants, so a group may type its children.
    let declared_type = object.get("$type").and_then(Value::as_str);
    let effective_type = declared_type.or(inherited_type);

    if let Some(value) = object.get("$value") {
        out.offer(&path.join("."), effective_type, value);
        return;
    }

    for (key, child) in object {
        // `$description`, `$extensions` and friends are metadata, not tokens.
        if key.starts_with('$') {
            continue;
        }
        path.push(key.clone());
        walk_w3c(child, path, effective_type, out);
        path.pop();
    }
}

// ---------------------------------------------------------------------------
// 10.2 — Figma and Claude Design
// ---------------------------------------------------------------------------

/// Ingest a Figma variables + published styles export (10.2).
///
/// Figma's REST shapes are mapped onto the same token vocabulary: variables
/// carry `resolvedType` and a per-mode value set, published styles carry a
/// `styleType` and the paint or type description behind it. A variable with
/// several modes cannot collapse into one token, and that is reported by name
/// rather than resolved by picking the first.
pub fn ingest_figma(name: &str, bytes: &[u8]) -> Result<DesignSystemDraft, Refusal> {
    let (document, text) = read_source(bytes)?;
    let mut builder = DraftBuilder::default();

    if let Some(variables) = document.get("variables").and_then(Value::as_object) {
        for (id, variable) in variables {
            let label = variable
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id.as_str());
            let source_path = format!("variables.{label}");
            let declared = variable.get("resolvedType").and_then(Value::as_str);

            let Some(modes) = variable.get("valuesByMode").and_then(Value::as_object) else {
                out_unexpressible(
                    &mut builder,
                    &source_path,
                    declared.unwrap_or("variable"),
                    "the variable carries no resolved value for any mode",
                    variable.clone(),
                );
                continue;
            };

            if modes.len() > 1 {
                // Several modes are several brands. Collapsing them would be a
                // silent substitution (invariant 18).
                out_unexpressible(
                    &mut builder,
                    &source_path,
                    declared.unwrap_or("variable"),
                    "the variable resolves differently per mode and tokens hold one value",
                    Value::Object(modes.clone()),
                );
                continue;
            }

            let Some((_, value)) = modes.iter().next() else {
                out_unexpressible(
                    &mut builder,
                    &source_path,
                    declared.unwrap_or("variable"),
                    "the variable carries no resolved value for any mode",
                    variable.clone(),
                );
                continue;
            };

            builder.offer(&source_path, figma_type(declared), &figma_value(value));
        }
    }

    if let Some(styles) = document.get("styles").and_then(Value::as_object) {
        for (id, style) in styles {
            let label = style
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id.as_str());
            let source_path = format!("styles.{label}");
            let style_type = style.get("styleType").and_then(Value::as_str).unwrap_or("");

            match style_type {
                "FILL" => match single_solid_paint(style) {
                    Some(colour) => builder.offer(&source_path, Some("color"), &colour),
                    None => out_unexpressible(
                        &mut builder,
                        &source_path,
                        "FILL",
                        "only a single solid paint maps to a palette token",
                        style.clone(),
                    ),
                },
                "TEXT" => {
                    // A type style is a composite: family, size, weight,
                    // spacing. The enforceable contract holds a legibility
                    // floor, not a type ramp, so this is named rather than
                    // half-mapped.
                    out_unexpressible(
                        &mut builder,
                        &source_path,
                        "TEXT",
                        "a composite type style has no single-value token form",
                        style.clone(),
                    );
                }
                other => out_unexpressible(
                    &mut builder,
                    &source_path,
                    other,
                    "this published style kind has no token representation",
                    style.clone(),
                ),
            }
        }
    }

    Ok(builder.finish(
        name,
        DesignSystemSourceKind::Figma,
        bytes,
        text,
        String::new(),
    ))
}

/// Ingest a Claude Design export: tokens plus a brief (10.2).
///
/// The token half is W3C-shaped, which is what makes this a thin adapter
/// rather than a second mapper. The brief is layer 2 in G.1 and is carried
/// through verbatim: it is prose for a human and a model to read, and
/// rewriting it here would be editorialising a brand's own words.
pub fn ingest_claude_design(name: &str, bytes: &[u8]) -> Result<DesignSystemDraft, Refusal> {
    let (document, text) = read_source(bytes)?;
    let tokens = document.get("tokens").unwrap_or(&Value::Null).clone();
    let mut builder = DraftBuilder::default();
    walk_w3c(&tokens, &mut vec!["tokens".into()], None, &mut builder);

    let brief = document
        .get("brief")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    Ok(builder.finish(
        name,
        DesignSystemSourceKind::ClaudeDesign,
        bytes,
        text,
        brief,
    ))
}

// ---------------------------------------------------------------------------
// The shared mapper
// ---------------------------------------------------------------------------

#[derive(Default)]
struct DraftBuilder {
    palette: Vec<Named<Rgba>>,
    spacing: Vec<f64>,
    min_text_size: Option<f64>,
    /// Every declared font size, with the value it came from. The contract
    /// holds one legibility floor, and which size that is can only be known
    /// once the whole document has been read.
    font_sizes: Vec<(String, f64, Value)>,
    duration: Vec<Named<f64>>,
    easing: Vec<NamedEasing>,
    stagger: Vec<Named<f64>>,
    mappings: Vec<TokenMapping>,
    unexpressible: Vec<UnexpressibleToken>,
}

fn out_unexpressible(
    builder: &mut DraftBuilder,
    source_path: &str,
    source_type: &str,
    reason: &str,
    value: Value,
) {
    builder.unexpressible.push(UnexpressibleToken {
        source_path: source_path.to_owned(),
        source_type: source_type.to_owned(),
        reason: reason.to_owned(),
        value,
    });
}

impl DraftBuilder {
    /// Offer one source value to the token contract.
    ///
    /// Every path ends in exactly one of two places: a mapping or an entry on
    /// the unexpressible list. There is no third outcome, which is what makes
    /// the report trustworthy — a value that silently matched nothing would
    /// make "did it capture our brand?" unanswerable.
    fn offer(&mut self, source_path: &str, declared_type: Option<&str>, value: &Value) {
        // Sources disagree about the group separator: W3C nests with `.`, and
        // Figma names groups with `/`. The token name is the last segment
        // under either convention, so a Figma variable does not end up named
        // `brand/primary` while its W3C equivalent is named `primary`.
        let leaf = source_path.rsplit(['.', '/']).next().unwrap_or(source_path);

        match declared_type {
            Some("color") => match colour_from(value) {
                Ok(colour) => {
                    self.palette.push(Named {
                        name: leaf.to_owned(),
                        value: colour,
                    });
                    self.map(source_path, &format!("visual.palette.{leaf}"));
                }
                Err(reason) => {
                    out_unexpressible(self, source_path, "color", &reason, value.clone())
                }
            },
            Some("dimension") => match dimension_px(value) {
                Ok(px) => {
                    self.spacing.push(px);
                    self.map(source_path, &format!("visual.spacing.{leaf}"));
                }
                Err(reason) => {
                    out_unexpressible(self, source_path, "dimension", &reason, value.clone())
                }
            },
            Some("duration") => match duration_ms(value) {
                Ok(ms) => {
                    // A stagger is a duration by type and a stagger by role.
                    // The source's own grouping is the only signal available,
                    // and mis-routing puts an interval on the wrong scale — so
                    // this matches a whole path SEGMENT. A substring test
                    // would capture `duration.staggered-entry`, which is a
                    // duration whose name merely starts the same way.
                    let is_stagger = source_path
                        .split(['.', '/'])
                        .any(|segment| segment.eq_ignore_ascii_case("stagger"));
                    if is_stagger {
                        self.stagger.push(Named {
                            name: leaf.to_owned(),
                            value: ms,
                        });
                        self.map(source_path, &format!("motion.stagger.{leaf}"));
                    } else {
                        self.duration.push(Named {
                            name: leaf.to_owned(),
                            value: ms,
                        });
                        self.map(source_path, &format!("motion.duration.{leaf}"));
                    }
                }
                Err(reason) => {
                    out_unexpressible(self, source_path, "duration", &reason, value.clone())
                }
            },
            Some("cubicBezier") => match cubic_bezier(value) {
                Ok(points) => {
                    self.easing.push(NamedEasing::Bezier {
                        name: leaf.to_owned(),
                        value: points,
                    });
                    self.map(source_path, &format!("motion.easing.{leaf}"));
                }
                Err(reason) => {
                    out_unexpressible(self, source_path, "cubicBezier", &reason, value.clone())
                }
            },
            Some("fontSize") => match dimension_px(value) {
                // Which size becomes the floor cannot be decided here: a
                // smaller one may still arrive, and recording a mapping now
                // would leave the report claiming a token was captured when a
                // later size displaced it. Collected, decided in `finish`.
                Ok(px) => self
                    .font_sizes
                    .push((source_path.to_owned(), px, value.clone())),
                Err(reason) => {
                    out_unexpressible(self, source_path, "fontSize", &reason, value.clone())
                }
            },
            Some(other) => out_unexpressible(
                self,
                source_path,
                other,
                "this token type has no GrapiX equivalent",
                value.clone(),
            ),
            None => out_unexpressible(
                self,
                source_path,
                "untyped",
                "the source declares no type, and a type is never inferred",
                value.clone(),
            ),
        }
    }

    fn map(&mut self, source_path: &str, token_path: &str) {
        self.mappings.push(TokenMapping {
            source_path: source_path.to_owned(),
            token_path: token_path.to_owned(),
        });
    }

    fn finish(
        mut self,
        name: &str,
        kind: DesignSystemSourceKind,
        source_bytes: &[u8],
        document: String,
        brief: String,
    ) -> DesignSystemDraft {
        // The legibility floor, decided once the whole ramp is known. The
        // smallest declared size is the only part of a type ramp the contract
        // can carry; every size it displaces is reported by name, so the
        // mappings never claim a value the draft did not keep (10.3).
        let mut font_sizes = std::mem::take(&mut self.font_sizes);
        font_sizes.sort_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        if let Some((floor_path, floor_px, _)) = font_sizes.first().cloned() {
            self.min_text_size = Some(floor_px);
            self.map(&floor_path, "visual.minTextSize");
            for (path, _, value) in font_sizes.into_iter().skip(1) {
                out_unexpressible(
                    &mut self,
                    &path,
                    "fontSize",
                    "the token contract holds a legibility floor, not a type ramp",
                    value,
                );
            }
        }

        // Deterministic order: a draft built twice from the same bytes must be
        // the same draft, or the provenance hash means nothing.
        self.spacing
            .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        self.spacing.dedup();
        self.palette.sort_by(|a, b| a.name.cmp(&b.name));
        self.duration.sort_by(|a, b| a.name.cmp(&b.name));
        self.stagger.sort_by(|a, b| a.name.cmp(&b.name));
        self.easing.sort_by_key(easing_name);
        self.mappings
            .sort_by(|a, b| a.source_path.cmp(&b.source_path));
        self.unexpressible
            .sort_by(|a, b| a.source_path.cmp(&b.source_path));

        // Over the source bytes themselves, through the same content-hash
        // helper the asset store uses. A hash over a re-serialisation would
        // identify our re-print of the file rather than the file, and a second
        // hex renderer beside the canonical one is the drift invariant 27
        // names.
        let sha256 = gx_asset_plane::store::content_hash(source_bytes);

        DesignSystemDraft {
            name: name.to_owned(),
            visual: DraftVisualTokens {
                palette: self.palette,
                spacing: self.spacing,
                min_text_size: self.min_text_size,
            },
            motion: MotionTokens {
                duration: self.duration,
                easing: self.easing,
                stagger: self.stagger,
            },
            brief,
            mappings: self.mappings,
            unexpressible: self.unexpressible,
            source: DesignSystemSource {
                kind,
                sha256,
                document,
            },
        }
    }
}

fn easing_name(easing: &NamedEasing) -> String {
    match easing {
        NamedEasing::Bezier { name, .. } | NamedEasing::Hold { name } => name.clone(),
    }
}

fn colour_from(value: &Value) -> Result<Rgba, String> {
    match value {
        Value::String(hex) => Rgba::from_css_hex(hex).map_err(|refusal| refusal.to_string()),
        // The 2024 draft's object form: components plus a named space. Only
        // sRGB is accepted, because tagging a wide-gamut source as sRGB is the
        // silent substitution invariant 18 forbids.
        Value::Object(map) => {
            let space = map.get("colorSpace").and_then(Value::as_str).unwrap_or("");
            if space != "srgb" {
                return Err(format!(
                    "colour space {space:?} is not one of the tagged source spaces"
                ));
            }
            let components = map
                .get("components")
                .and_then(Value::as_array)
                .ok_or_else(|| "the colour carries no components".to_owned())?;
            if components.len() < 3 {
                return Err("a colour needs three components".to_owned());
            }
            let channel = |index: usize| -> Result<f64, String> {
                components[index]
                    .as_f64()
                    .ok_or_else(|| "a colour component is not a number".to_owned())
            };
            let alpha = map.get("alpha").and_then(Value::as_f64).unwrap_or(1.0);
            Ok(Rgba::srgb(channel(0)?, channel(1)?, channel(2)?, alpha))
        }
        _ => Err("a colour is a hex string or a component object".to_owned()),
    }
}

/// `16px`, `1rem` or a bare number, in scene units.
///
/// `rem` resolves against the CSS 16px root because that is what the value
/// meant in its source document; leaving it as 1.0 would silently rescale a
/// whole spacing ramp.
fn dimension_px(value: &Value) -> Result<f64, String> {
    let text = match value {
        Value::Number(number) => {
            return number
                .as_f64()
                .ok_or_else(|| "the dimension is not a finite number".to_owned())
                .and_then(|magnitude| finite_non_negative(magnitude, "the dimension"))
        }
        Value::String(text) => text.clone(),
        Value::Object(map) => {
            let unit = map.get("unit").and_then(Value::as_str).unwrap_or("px");
            let magnitude = map
                .get("value")
                .and_then(Value::as_f64)
                .ok_or_else(|| "the dimension carries no numeric value".to_owned())?;
            return scale_unit(magnitude, unit);
        }
        _ => return Err("a dimension is a number, a string or an object".to_owned()),
    };

    let trimmed = text.trim();
    let split = trimmed
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+')
        .unwrap_or(trimmed.len());
    let (magnitude, unit) = trimmed.split_at(split);
    let magnitude: f64 = magnitude
        .parse()
        .map_err(|_| format!("{trimmed:?} is not a dimension"))?;
    scale_unit(magnitude, unit.trim())
}

/// Reject a magnitude that cannot be a brand value.
///
/// NaN and infinity would poison the spacing sort and the deduplication that
/// depends on it; a negative step is not a scale entry and a negative duration
/// is not a time. Refusing here keeps a wrong number off the token set, where
/// it would silently rescale a ramp rather than announce itself.
fn finite_non_negative(magnitude: f64, what: &str) -> Result<f64, String> {
    if !magnitude.is_finite() {
        return Err(format!("{what} is not a finite number"));
    }
    if magnitude < 0.0 {
        return Err(format!("{what} is negative"));
    }
    Ok(magnitude)
}

fn scale_unit(magnitude: f64, unit: &str) -> Result<f64, String> {
    match unit {
        "" | "px" => finite_non_negative(magnitude, "the dimension"),
        "rem" | "em" => finite_non_negative(magnitude * 16.0, "the dimension"),
        other => Err(format!(
            "unit {other:?} has no scene-unit meaning without a document context"
        )),
    }
}

fn duration_ms(value: &Value) -> Result<f64, String> {
    let magnitude = match value {
        Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| "the duration is not a finite number".to_owned())?,
        Value::String(text) => {
            let trimmed = text.trim();
            // `ms` is tested before the bare `s` suffix, or every millisecond
            // value would parse as seconds with a trailing `m`.
            if let Some(ms) = trimmed.strip_suffix("ms") {
                ms.trim()
                    .parse()
                    .map_err(|_| format!("{trimmed:?} is not a duration"))?
            } else if let Some(seconds) = trimmed.strip_suffix('s') {
                seconds
                    .trim()
                    .parse::<f64>()
                    .map(|value| value * 1000.0)
                    .map_err(|_| format!("{trimmed:?} is not a duration"))?
            } else {
                return Err(format!("{trimmed:?} carries no time unit"));
            }
        }
        Value::Object(map) => {
            let unit = map.get("unit").and_then(Value::as_str).unwrap_or("ms");
            let magnitude = map
                .get("value")
                .and_then(Value::as_f64)
                .ok_or_else(|| "the duration carries no numeric value".to_owned())?;
            match unit {
                "ms" => magnitude,
                "s" => magnitude * 1000.0,
                other => return Err(format!("time unit {other:?} is not understood")),
            }
        }
        _ => return Err("a duration is a number, a string or an object".to_owned()),
    };
    finite_non_negative(magnitude, "the duration")
}

fn cubic_bezier(value: &Value) -> Result<[f64; 4], String> {
    let points = value
        .as_array()
        .ok_or_else(|| "a cubic bezier is an array of four numbers".to_owned())?;
    if points.len() != 4 {
        return Err("a cubic bezier has exactly four control values".to_owned());
    }
    let mut out = [0.0; 4];
    for (slot, point) in out.iter_mut().zip(points) {
        *slot = point
            .as_f64()
            .ok_or_else(|| "a bezier control value is not a number".to_owned())?;
    }
    Ok(out)
}

fn figma_type(resolved: Option<&str>) -> Option<&str> {
    match resolved {
        Some("COLOR") => Some("color"),
        Some("FLOAT") => Some("dimension"),
        Some("STRING") => Some("string"),
        Some("BOOLEAN") => Some("boolean"),
        other => other,
    }
}

/// Figma expresses colour as 0–1 components; the mapper speaks the token
/// object form, so this adapts rather than duplicating the colour rules.
fn figma_value(value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    let (Some(r), Some(g), Some(b)) = (
        map.get("r").and_then(Value::as_f64),
        map.get("g").and_then(Value::as_f64),
        map.get("b").and_then(Value::as_f64),
    ) else {
        return value.clone();
    };
    serde_json::json!({
        "colorSpace": "srgb",
        "components": [r, g, b],
        "alpha": map.get("a").and_then(Value::as_f64).unwrap_or(1.0),
    })
}

fn single_solid_paint(style: &Value) -> Option<Value> {
    let paints = style.get("paints")?.as_array()?;
    let [paint] = paints.as_slice() else {
        return None;
    };
    if paint.get("type")?.as_str()? != "SOLID" {
        return None;
    }
    Some(figma_value(paint.get("color")?))
}

// ---------------------------------------------------------------------------
// 10.4 — the versioned, immutable store
// ---------------------------------------------------------------------------

// `Provenance` is a wire shape returned by `designsystem.list_versions`, so it
// lives in contracts and is generated into TypeScript from there (invariant
// 22). It is re-exported rather than redefined: a second copy beside the store
// is the drift invariant 27 names.
pub use gx_contracts::design_system::Provenance;

/// The design-system directory inside one project (G.3).
#[derive(Debug, Clone)]
pub struct DesignSystemStore {
    root: PathBuf,
}

impl DesignSystemStore {
    /// The store beneath a project directory.
    pub fn at(project_directory: impl Into<PathBuf>) -> Self {
        Self {
            root: project_directory.into().join("design-system"),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn version_directory(&self, version: u32) -> PathBuf {
        self.root.join(format!("v{version}"))
    }

    /// Where a version is assembled before it is moved into place.
    ///
    /// A leading `.` keeps it out of [`Self::versions`], which only accepts
    /// `v<n>`: a half-built version must never be counted as a confirmed one.
    fn candidate_directory(&self, version: u32) -> PathBuf {
        self.root.join(format!(".v{version}-candidate"))
    }

    /// Every confirmed version, ascending.
    ///
    /// A directory counts only when its name is exactly the name this store
    /// writes. `u32::from_str` accepts `v007` and `v+7`, which would report a
    /// version whose directory `version_directory` can never name — so the
    /// parsed number is re-rendered and compared, the same re-derive-and-
    /// compare idiom the platform filename validator uses. Version 0 is
    /// refused because the store starts at 1 and never writes it.
    pub fn versions(&self) -> Result<Vec<u32>, EditorError> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(EditorError::Io {
                    path: self.root.clone(),
                    source,
                })
            }
        };

        let mut versions = Vec::new();
        for entry in entries {
            // A directory entry that cannot be read is propagated rather than
            // dropped: silently skipping one lowers `current_version`, which
            // would let the next confirm reuse a version number.
            let entry = entry.map_err(|source| EditorError::Io {
                path: self.root.clone(),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| EditorError::Io {
                path: entry.path(),
                source,
            })?;
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(digits) = name.strip_prefix('v') else {
                continue;
            };
            let Ok(version) = digits.parse::<u32>() else {
                continue;
            };
            if version > 0 && format!("v{version}") == name {
                versions.push(version);
            }
        }
        versions.sort_unstable();
        Ok(versions)
    }

    /// The active version, or `None` before the first confirmation.
    pub fn current_version(&self) -> Result<Option<u32>, EditorError> {
        Ok(self.versions()?.last().copied())
    }

    /// Confirm a draft as the next version (10.4).
    ///
    /// `confirmed_by` is required and must be non-empty: G.2's "never
    /// auto-accept" is only real if the store cannot record a confirmation
    /// nobody made. A draft missing the legibility floor is refused here
    /// rather than defaulted, because a guessed floor would be enforced
    /// against every scene as though a human had chosen it.
    pub fn confirm(
        &self,
        draft: &DesignSystemDraft,
        confirmed_by: &str,
    ) -> Result<DesignSystem, EditorError> {
        if confirmed_by.trim().is_empty() {
            return Err(Refusal::NotImplemented {
                what: "a design system version records who confirmed it; no name was given"
                    .to_owned(),
            }
            .into());
        }

        let Some(min_text_size) = draft.visual.min_text_size else {
            return Err(Refusal::NotImplemented {
                what: "the draft carries no minimum text size, and one is never inferred"
                    .to_owned(),
            }
            .into());
        };

        let version = self
            .current_version()?
            .map_or(Some(1), |current| current.checked_add(1))
            .ok_or_else(|| {
                EditorError::from(Refusal::NotImplemented {
                    what: "design system version numbers are exhausted".to_owned(),
                })
            })?;
        let directory = self.version_directory(version);

        let system = DesignSystem {
            name: draft.name.clone(),
            version,
            visual: VisualTokens {
                palette: draft.visual.palette.clone(),
                spacing: draft.visual.spacing.clone(),
                min_text_size,
            },
            motion: draft.motion.clone(),
        };

        let provenance = Provenance {
            source_kind: draft.source.kind,
            source_sha256: draft.source.sha256.clone(),
            importer_version: IMPORTER_VERSION,
            confirmed_by: confirmed_by.to_owned(),
        };

        // A version is built beside its destination and moved into place in
        // one step. Four separate writes into the final directory are each
        // atomic but the *set* is not: a crash between them leaves a directory
        // that `versions()` counts and `current_version()` returns, holding a
        // token set with no record of who confirmed it — enforced against
        // every scene on the strength of a half-written directory.
        //
        // The same rename is the compare-and-swap that makes concurrent
        // confirms safe. `create_dir` on the destination fails if it already
        // exists, so two callers racing for v4 cannot interleave their files;
        // the loser is told the version exists, by name (invariant 17).
        let candidate = self.candidate_directory(version);
        let _ = std::fs::remove_dir_all(&candidate);
        std::fs::create_dir_all(&candidate).map_err(|source| EditorError::Io {
            path: candidate.clone(),
            source,
        })?;

        let staged = (|| -> Result<(), EditorError> {
            self.write_json(&candidate.join("tokens.json"), &system)?;
            self.write_json(&candidate.join("provenance.json"), &provenance)?;
            gx_fs::write_atomic(&candidate.join("brief.md"), draft.brief.as_bytes())
                .map_err(EditorError::Write)?;
            // The source record carries the document as the text it arrived
            // as, beside the hash taken over those same bytes. One file, so a
            // reader cannot find the kind without the bytes it describes.
            self.write_json(&candidate.join("source.json"), &draft.source)
        })();

        if let Err(error) = staged {
            let _ = std::fs::remove_dir_all(&candidate);
            return Err(error);
        }

        match std::fs::rename(&candidate, &directory) {
            Ok(()) => {}
            Err(source) => {
                let _ = std::fs::remove_dir_all(&candidate);
                // A rename onto an existing directory is the race resolving,
                // not a disk fault. Distinguished by asking what is actually
                // there rather than by trusting the error code, which differs
                // between platforms.
                if directory.exists() {
                    return Err(Refusal::NotImplemented {
                        what: format!("design system v{version} already exists and is immutable"),
                    }
                    .into());
                }
                return Err(EditorError::Io {
                    path: directory.clone(),
                    source,
                });
            }
        }

        // Read back what landed rather than returning what was intended. The
        // caller is told what a reader will see, which is the same discipline
        // the package writer applies to a manifest.
        self.load(version)
    }

    fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), EditorError> {
        let bytes = serde_json::to_vec_pretty(value).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(path, &bytes).map_err(EditorError::Write)
    }

    /// Read one confirmed version.
    pub fn load(&self, version: u32) -> Result<DesignSystem, EditorError> {
        let path = self.version_directory(version).join("tokens.json");
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io {
            path: path.clone(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(EditorError::Serialize)
    }

    /// Read one version's provenance.
    pub fn provenance(&self, version: u32) -> Result<Provenance, EditorError> {
        let path = self.version_directory(version).join("provenance.json");
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io {
            path: path.clone(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(EditorError::Serialize)
    }

    /// Read one version's retained source document.
    pub fn source(&self, version: u32) -> Result<DesignSystemSource, EditorError> {
        let path = self.version_directory(version).join("source.json");
        let bytes = std::fs::read(&path).map_err(|source| EditorError::Io {
            path: path.clone(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(EditorError::Serialize)
    }
}

// ---------------------------------------------------------------------------
// 10.5 — drift across published templates
// ---------------------------------------------------------------------------
//
// The drift types live in contracts, not here. Building the report needs both
// the current design-system version (this crate) and the published takes that
// carry a stamp (`gx-playout`), and no product crate may depend on another
// (invariant 1). Contracts is the only place both sides can legally see, and
// a drift report is a wire shape besides, so it is generated into TypeScript
// from there rather than hand-mirrored (invariant 22).
pub use gx_contracts::design_system::{drift_report, DriftEntry, DriftReport, StampedTemplate};

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A source document as the bytes a file would hold.
    fn bytes_of(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("a test document serialises")
    }

    fn scratch(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gx-design-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("scratch directory");
        path
    }

    fn w3c_document() -> Value {
        serde_json::json!({
            "brand": {
                "$type": "color",
                "primary": { "$value": "#1e88e5" },
                "ink": { "$value": { "colorSpace": "srgb", "components": [0.1, 0.1, 0.1], "alpha": 1.0 } }
            },
            "space": {
                "$type": "dimension",
                "tight": { "$value": "8px" },
                "base": { "$value": "16px" },
                "loose": { "$value": "1rem" }
            },
            "motion": {
                "duration": {
                    "$type": "duration",
                    "snap": { "$value": "160ms" },
                    "base": { "$value": { "value": 0.4, "unit": "s" } }
                },
                "stagger": {
                    "$type": "duration",
                    "tight": { "$value": "40ms" }
                },
                "easing": {
                    "$type": "cubicBezier",
                    "brand-in": { "$value": [0.2, 0.0, 0.0, 1.0] }
                }
            },
            "type": {
                "$type": "fontSize",
                "caption": { "$value": "18px" },
                "body": { "$value": "24px" }
            }
        })
    }

    #[test]
    fn a_w3c_document_maps_its_values_and_round_trips_without_loss() {
        // 10.1's done-when. "Round-trips without loss" is the load-bearing
        // half: the enforceable projection is narrower than the source, so
        // losslessness is a property of the retained document, not of the
        // token set.
        let document = w3c_document();
        let source = bytes_of(&document);
        let draft = ingest_w3c("Brand", &source).expect("the document ingests");

        // The retained source is the file itself, so re-export is a read
        // rather than a re-serialisation of something already narrowed.
        assert_eq!(
            draft.source.document.as_bytes(),
            source.as_slice(),
            "the complete source must survive ingest"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&draft.source.document).unwrap(),
            document,
            "and it must still parse back to what was supplied"
        );

        let names: Vec<&str> = draft
            .visual
            .palette
            .iter()
            .map(|token| token.name.as_str())
            .collect();
        assert_eq!(names, vec!["ink", "primary"]);

        // #1e88e5 is sRGB by notation, and the tag is read off the notation
        // rather than inferred.
        let primary = draft
            .visual
            .palette
            .iter()
            .find(|token| token.name == "primary")
            .expect("the primary colour mapped");
        assert_eq!(
            primary.value.space,
            gx_contracts::color::SourceColorSpace::Srgb
        );

        // 1rem is 16px, so `loose` collapses onto `base` rather than becoming
        // a second, wrongly-scaled step.
        assert_eq!(draft.visual.spacing, vec![8.0, 16.0]);

        // 0.4s is 400ms. A unit that was not converted would put a duration
        // three orders of magnitude out.
        let base = draft
            .motion
            .duration
            .iter()
            .find(|token| token.name == "base")
            .expect("the base duration mapped");
        assert_eq!(base.value, 400.0);

        // A stagger is a duration by type and a stagger by role.
        assert_eq!(draft.motion.stagger.len(), 1);
        assert_eq!(draft.motion.stagger[0].name, "tight");

        assert!(matches!(
            draft.motion.easing.as_slice(),
            [NamedEasing::Bezier { name, value }]
                if name == "brand-in" && *value == [0.2, 0.0, 0.0, 1.0]
        ));

        // The legibility floor is the smallest declared size, and the rest of
        // the ramp is reported rather than silently dropped.
        assert_eq!(draft.visual.min_text_size, Some(18.0));
    }

    #[test]
    fn a_displaced_font_size_is_reported_rather_than_left_claiming_a_mapping() {
        // 10.3's done-when, at its sharpest. The contract carries one
        // legibility floor, so only one declared size can map. Whichever sizes
        // lose must appear on the unexpressible list — and exactly one mapping
        // may claim `visual.minTextSize`.
        //
        // The failure this pins: deciding the floor as each size arrives
        // records a mapping for a value that a later, smaller size displaces.
        // The displaced value is then neither mapped nor reported, and the
        // draft claims to have captured a size it discarded.
        let document = serde_json::json!({
            "type": {
                "$type": "fontSize",
                "body": { "$value": "24px" },
                "caption": { "$value": "18px" },
                "legal": { "$value": "21px" }
            }
        });

        let draft = ingest_w3c("Brand", &bytes_of(&document)).expect("the document ingests");

        assert_eq!(draft.visual.min_text_size, Some(18.0));

        let claiming_floor: Vec<&str> = draft
            .mappings
            .iter()
            .filter(|mapping| mapping.token_path == "visual.minTextSize")
            .map(|mapping| mapping.source_path.as_str())
            .collect();
        assert_eq!(
            claiming_floor,
            vec!["type.caption"],
            "exactly the surviving size may claim the floor"
        );

        let reported: Vec<&str> = draft
            .unexpressible
            .iter()
            .filter(|entry| entry.source_type == "fontSize")
            .map(|entry| entry.source_path.as_str())
            .collect();
        assert_eq!(
            reported,
            vec!["type.body", "type.legal"],
            "every displaced size must be named, not silently dropped"
        );
    }

    #[test]
    fn a_value_that_cannot_be_a_brand_value_is_refused_rather_than_mapped() {
        // Every one of these would otherwise land in the token set as a
        // plausible-looking number. A wrong number is the expensive case: it
        // rescales a ramp silently instead of announcing itself (invariant 18).
        let document = serde_json::json!({
            "space": {
                "$type": "dimension",
                "negative": { "$value": "-8px" },
                "unitless-junk": { "$value": "1.5.5px" },
                "exponent": { "$value": "1e3px" },
                "viewport": { "$value": "3vw" }
            },
            "motion": {
                "duration": {
                    "$type": "duration",
                    "backwards": { "$value": "-100ms" },
                    "unitless": { "$value": "250" }
                },
                "stagger": { "$type": "duration", "tight": { "$value": "40ms" } }
            },
            "timing": {
                "$type": "duration",
                "staggered-entry": { "$value": "90ms" }
            }
        });

        let draft = ingest_w3c("Brand", &bytes_of(&document)).expect("the document ingests");

        assert!(
            draft.visual.spacing.is_empty(),
            "no malformed dimension may reach the scale, got {:?}",
            draft.visual.spacing
        );

        for path in [
            "space.negative",
            "space.unitless-junk",
            "space.exponent",
            "space.viewport",
            "motion.duration.backwards",
        ] {
            assert!(
                draft
                    .unexpressible
                    .iter()
                    .any(|entry| entry.source_path == path),
                "{path} must be reported by name"
            );
        }

        // A bare number carries no unit, and a duration without one is not a
        // time. It is refused rather than assumed to be milliseconds.
        assert!(draft
            .unexpressible
            .iter()
            .any(|entry| entry.source_path == "motion.duration.unitless"));

        // `timing.staggered-entry` merely starts with the same letters. It is
        // a duration, and matching a whole path segment is what keeps it one.
        let stagger_names: Vec<&str> = draft
            .motion
            .stagger
            .iter()
            .map(|token| token.name.as_str())
            .collect();
        assert_eq!(stagger_names, vec!["tight"]);
        assert!(
            draft
                .motion
                .duration
                .iter()
                .any(|token| token.name == "staggered-entry"),
            "a duration whose name merely starts with 'stagger' stays a duration"
        );
    }

    #[test]
    fn the_provenance_hash_identifies_the_source_file() {
        // The same bytes must produce the same draft and the same hash, or
        // "is this the file we confirmed?" is unanswerable.
        let source = bytes_of(&w3c_document());
        let first = ingest_w3c("Brand", &source).unwrap();
        let second = ingest_w3c("Brand", &source).unwrap();
        assert_eq!(first, second);

        // And the retained document is the source, byte for byte, rather than
        // a re-print of the parse — that is what makes re-export lossless.
        assert_eq!(
            first.source.document.as_bytes(),
            source.as_slice(),
            "the retained source must be the bytes supplied"
        );

        // A differently-spelled file is a different file. The hash answers
        // "is this the artefact we confirmed?", not "is this equivalent to
        // something we once parsed?" — two brand packs that agree after
        // parsing can still differ in what a reviewer would open and read.
        let respelled = br##"{"brand":{"$type":"color","primary":{"$value":"#1e88e5"}}}"##;
        let reprinted = serde_json::to_vec_pretty(
            &serde_json::from_slice::<Value>(respelled).expect("valid JSON"),
        )
        .expect("the reprint serialises");
        assert_ne!(
            respelled.as_slice(),
            reprinted.as_slice(),
            "the two spellings must actually differ for this to prove anything"
        );
        let from_file = ingest_w3c("Brand", respelled).unwrap();
        let from_reprint = ingest_w3c("Brand", &reprinted).unwrap();
        assert_eq!(
            from_file.visual.palette, from_reprint.visual.palette,
            "they parse to the same tokens"
        );
        assert_ne!(
            from_file.source.sha256, from_reprint.source.sha256,
            "yet provenance distinguishes the files"
        );
    }

    #[test]
    fn an_unreadable_source_is_refused_by_name() {
        // Taking bytes is what gives ingest's `Result` a real use: before, a
        // malformed brand pack could only arrive as an empty token set, which
        // is indistinguishable from a source that genuinely held nothing.
        let error = ingest_w3c("Brand", b"{ not json").expect_err("malformed JSON is refused");
        assert!(
            matches!(error, Refusal::DesignSourceUnreadable { .. }),
            "expected DesignSourceUnreadable, got {error}"
        );

        let error = ingest_w3c("Brand", &[0xff, 0xfe]).expect_err("non-UTF-8 is refused");
        assert!(matches!(error, Refusal::DesignSourceUnreadable { .. }));
    }

    #[test]
    fn every_value_the_tokens_cannot_hold_is_named_with_its_value() {
        // 10.3's done-when: the report must name what the source held and
        // tokens cannot. A count is not enough — a reviewer needs the value to
        // judge whether a load-bearing rule is being discarded.
        let document = serde_json::json!({
            "effect": {
                "$type": "shadow",
                "card": { "$value": { "offsetX": "0px", "blur": "4px" } }
            },
            "grid": { "columns": { "$value": 12 } },
            "space": { "$type": "dimension", "odd": { "$value": "3vw" } }
        });

        let draft = ingest_w3c("Brand", &bytes_of(&document)).expect("the document ingests");

        let paths: Vec<&str> = draft
            .unexpressible
            .iter()
            .map(|entry| entry.source_path.as_str())
            .collect();
        assert_eq!(paths, vec!["effect.card", "grid.columns", "space.odd"]);

        let shadow = &draft.unexpressible[0];
        assert_eq!(shadow.source_type, "shadow");
        assert_eq!(shadow.value, document["effect"]["card"]["$value"]);

        // An untyped token is reported as untyped rather than guessed at:
        // inferring a type is the silent substitution invariant 18 forbids.
        assert_eq!(draft.unexpressible[1].source_type, "untyped");

        // A unit with no scene meaning is named, not approximated.
        assert!(draft.unexpressible[2].reason.contains("vw"));

        assert!(
            draft.visual.palette.is_empty() && draft.visual.spacing.is_empty(),
            "nothing unexpressible may leak into the token set"
        );
    }

    #[test]
    fn figma_variables_and_published_styles_map() {
        // 10.2's done-when: variables and published styles mapped.
        let document = serde_json::json!({
            "variables": {
                "VariableID:1": {
                    "name": "brand/primary",
                    "resolvedType": "COLOR",
                    "valuesByMode": { "1:0": { "r": 0.1, "g": 0.5, "b": 0.9, "a": 1.0 } }
                },
                "VariableID:2": {
                    "name": "space/base",
                    "resolvedType": "FLOAT",
                    "valuesByMode": { "1:0": 16.0 }
                },
                "VariableID:3": {
                    "name": "brand/themed",
                    "resolvedType": "COLOR",
                    "valuesByMode": {
                        "1:0": { "r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0 },
                        "1:1": { "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0 }
                    }
                }
            },
            "styles": {
                "S:1": {
                    "name": "Brand/Accent",
                    "styleType": "FILL",
                    "paints": [{ "type": "SOLID", "color": { "r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0 } }]
                },
                "S:2": {
                    "name": "Heading/H1",
                    "styleType": "TEXT",
                    "style": { "fontFamily": "Inter", "fontSize": 48 }
                }
            }
        });

        let draft = ingest_figma("Brand", &bytes_of(&document)).expect("the export ingests");

        let palette: Vec<&str> = draft
            .visual
            .palette
            .iter()
            .map(|token| token.name.as_str())
            .collect();
        assert_eq!(palette, vec!["Accent", "primary"]);
        assert_eq!(draft.visual.spacing, vec![16.0]);

        // A multi-mode variable is several brands. Collapsing it to the first
        // mode would be a silent substitution, so it is refused by name.
        let themed = draft
            .unexpressible
            .iter()
            .find(|entry| entry.source_path == "variables.brand/themed")
            .expect("the multi-mode variable is reported");
        assert!(themed.reason.contains("per mode"));

        // A composite type style has no single-value token form.
        assert!(draft
            .unexpressible
            .iter()
            .any(|entry| entry.source_path == "styles.Heading/H1"));
    }

    #[test]
    fn a_claude_design_export_carries_its_brief_through_verbatim() {
        // The brief is layer 2 in G.1: prose for a human and a model. Editing
        // it here would be editorialising a brand's own words.
        let document = serde_json::json!({
            "brief": "Confident, never loud. Motion supports hierarchy.",
            "tokens": {
                "brand": { "$type": "color", "primary": { "$value": "#101820" } }
            }
        });

        let draft =
            ingest_claude_design("Brand", &bytes_of(&document)).expect("the export ingests");
        assert_eq!(
            draft.brief,
            "Confident, never loud. Motion supports hierarchy."
        );
        assert_eq!(draft.visual.palette.len(), 1);
        assert_eq!(draft.source.kind, DesignSystemSourceKind::ClaudeDesign);
    }

    fn confirmable_draft() -> DesignSystemDraft {
        ingest_w3c("Brand", &bytes_of(&w3c_document())).expect("the document ingests")
    }

    #[test]
    fn a_draft_becomes_v1_only_when_a_human_confirms_it() {
        // 10.4's done-when: human confirmation before v1.
        let root = scratch("confirm");
        let store = DesignSystemStore::at(&root);

        assert_eq!(store.current_version().unwrap(), None);

        let draft = confirmable_draft();
        let anonymous = store
            .confirm(&draft, "   ")
            .expect_err("a version records who confirmed it");
        assert!(
            anonymous.to_string().contains("who confirmed"),
            "got {anonymous}"
        );
        assert_eq!(
            store.current_version().unwrap(),
            None,
            "a refused confirmation must not have created a version"
        );

        let system = store.confirm(&draft, "head-of-design").expect("v1 lands");
        assert_eq!(system.version, 1);
        assert_eq!(store.current_version().unwrap(), Some(1));

        let provenance = store.provenance(1).expect("provenance is recorded");
        assert_eq!(provenance.confirmed_by, "head-of-design");
        assert_eq!(provenance.source_sha256, draft.source.sha256);
        assert_eq!(provenance.importer_version, IMPORTER_VERSION);

        // The retained source is readable from the store, which is what makes
        // the round trip a property of the version and not just of the draft.
        assert_eq!(store.source(1).unwrap().document, draft.source.document);
        assert_eq!(store.load(1).unwrap(), system);

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_confirmed_version_is_complete_or_absent_never_half_written() {
        // A version directory is evidence that a human confirmed a token set.
        // Four separate writes into the final directory are each atomic but
        // the set is not: a crash between them would leave a directory that
        // `versions()` counts and `current_version()` returns, holding tokens
        // enforced against every scene with no record of who accepted them.
        //
        // So a version is assembled beside its destination and moved in one
        // step. Every confirmed version therefore carries all four files, and
        // a leftover candidate is never mistaken for one.
        let root = scratch("atomic");
        let store = DesignSystemStore::at(&root);
        store
            .confirm(&confirmable_draft(), "head-of-design")
            .expect("v1 lands");

        for file in ["tokens.json", "provenance.json", "source.json", "brief.md"] {
            assert!(
                store.root().join("v1").join(file).is_file(),
                "a confirmed version must carry {file}"
            );
        }

        // A half-built version left behind by a crash must not be counted.
        // The candidate name is deliberately outside the `v<n>` shape.
        std::fs::create_dir_all(store.root().join(".v2-candidate")).unwrap();
        std::fs::write(
            store.root().join(".v2-candidate").join("tokens.json"),
            b"{}",
        )
        .unwrap();
        assert_eq!(
            store.current_version().unwrap(),
            Some(1),
            "an abandoned candidate is not a confirmed version"
        );

        // And the next confirm still takes the next number rather than
        // colliding with the wreckage.
        let second = store
            .confirm(&confirmable_draft(), "head-of-design")
            .unwrap();
        assert_eq!(second.version, 2);

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn only_the_stores_own_version_names_are_counted() {
        // `u32::from_str` accepts `v007` and `v+7`, both of which would report
        // a version whose directory the store can never name — `versions()`
        // would claim a version that `load()` cannot read. Version 0 is not a
        // version either: the store starts at 1 and never writes it.
        let root = scratch("names");
        let store = DesignSystemStore::at(&root);
        store.confirm(&confirmable_draft(), "designer").unwrap();

        for bogus in ["v007", "v+7", "v0", "vnext", "notaversion"] {
            std::fs::create_dir_all(store.root().join(bogus)).unwrap();
        }

        assert_eq!(
            store.versions().unwrap(),
            vec![1],
            "only names this store writes may count as versions"
        );

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_draft_with_no_legibility_floor_cannot_be_confirmed() {
        // The importer may not invent a threshold that would then be enforced
        // against every scene as though a human had chosen it.
        let root = scratch("no-floor");
        let store = DesignSystemStore::at(&root);

        let document = serde_json::json!({
            "brand": { "$type": "color", "primary": { "$value": "#101820" } }
        });
        let draft = ingest_w3c("Brand", &bytes_of(&document)).unwrap();
        assert_eq!(draft.visual.min_text_size, None);

        let error = store
            .confirm(&draft, "head-of-design")
            .expect_err("a missing floor is refused rather than defaulted");
        assert!(
            error.to_string().contains("minimum text size"),
            "got {error}"
        );

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn a_new_brand_pack_is_a_new_version_and_never_an_edit() {
        // G.3: versioned and immutable, like packages. v3 must still read as
        // v3 after v4 lands, because every stamped package points at it.
        let root = scratch("immutable");
        let store = DesignSystemStore::at(&root);

        let first = store.confirm(&confirmable_draft(), "designer").unwrap();
        assert_eq!(first.version, 1);

        let mut revised = confirmable_draft();
        revised.visual.palette.clear();
        revised.visual.min_text_size = Some(21.0);
        let second = store.confirm(&revised, "designer").unwrap();
        assert_eq!(second.version, 2);

        let v1 = store.load(1).expect("v1 still reads");
        assert_eq!(v1, first, "confirming v2 must not have edited v1 in place");
        assert_eq!(store.versions().unwrap(), vec![1, 2]);

        std::fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn the_drift_report_lists_every_template_behind_the_current_version() {
        // 10.5's done-when. An unstamped package predates stamping, which is a
        // different statement from "behind", and conflating them would put a
        // template on a re-publish list for a reason nobody can verify.
        let templates = vec![
            StampedTemplate {
                template_id: "lower-third".into(),
                design_system_version: Some(3),
            },
            StampedTemplate {
                template_id: "bug".into(),
                design_system_version: Some(4),
            },
            StampedTemplate {
                template_id: "astons".into(),
                design_system_version: Some(1),
            },
            StampedTemplate {
                template_id: "legacy-ticker".into(),
                design_system_version: None,
            },
        ];

        let report = drift_report(4, &templates);

        let behind: Vec<(&str, Option<u32>)> = report
            .behind
            .iter()
            .map(|entry| (entry.template_id.as_str(), entry.versions_behind))
            .collect();
        assert_eq!(
            behind,
            vec![("astons", Some(3)), ("lower-third", Some(1))],
            "every template behind the current version, and how far"
        );

        assert_eq!(report.unstamped.len(), 1);
        assert_eq!(report.unstamped[0].template_id, "legacy-ticker");
        assert!(
            !report.behind.iter().any(|entry| entry.template_id == "bug"),
            "a template on the current version is not drift"
        );
    }
}

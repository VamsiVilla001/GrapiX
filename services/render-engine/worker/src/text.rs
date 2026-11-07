//! Text preparation through `cosmic-text` (build plan 3.6).
//!
//! Only packaged, content-addressed font bytes enter the font database. The
//! system font database is never loaded, so a missing face cannot turn into a
//! platform-dependent substitution. Shaping, bidi resolution, fallback and
//! OpenType layout all happen once when a scene is published.
//!
//! Glyphs are drawn as their real outlines (3.13): each glyph's outline is
//! taken from the packaged face at publish, tessellated once in the text's own
//! coordinates, and placed every frame through the same transform as a vector
//! shape, so rotation, scale and anchor apply to text too. Advance-width
//! rectangles were a substitution and are gone.

use std::collections::HashMap;
use std::sync::Arc;

use cosmic_text::{fontdb, Align, Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache};
use lyon::math::point;
use lyon::path::Path;
use lyon::tessellation::{BuffersBuilder, FillOptions, FillTessellator, FillVertex, VertexBuffers};
use swash::zeno::{Command, Point as OutlinePoint};
use gx_contracts::font::{FontDefinition, FontLoadStatus, FontSource, FontStyle};
use gx_contracts::scene::{AssetKind, SceneDocument, SceneObject, TextCase, TextDirection, TextLayout};
use gx_contracts::{ContentHash, Refusal};

use crate::mesh::AssetBytes;

/// One glyph positioned by the scene's declared fonts.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedGlyph {
    pub face_id: String,
    pub glyph_id: u16,
    pub source_start: usize,
    pub source_end: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub bidi_level: u8,
}

/// One text object after case, bidi, fallback and OpenType shaping.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedTextObject {
    pub object_id: String,
    pub text: String,
    pub glyphs: Vec<PreparedGlyph>,
    pub width: f32,
    pub height: f32,
    /// Every glyph's outline, tessellated once at publish, in the text's own
    /// coordinates (origin at the box's top-left, y down).
    pub vertices: Vec<[f32; 2]>,
    /// Triangle indices into [`Self::vertices`].
    pub indices: Vec<u32>,
}

/// Text-side state built once for a published scene.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreparedTexts {
    pub objects: Vec<PreparedTextObject>,
}

/// Rasterise prepared text objects onto the working-space surface. Every
/// glyph was shaped, outlined and tessellated at publication; this places its
/// triangles through the object's transform and fills them.
///
/// The fill colour is taken from the text object's base.  A gradient fill
/// would require a fill rule we do not implement in the software path, so it
/// is refused by name rather than approximated (invariant 18).
pub fn rasterise_texts(
    prepared: &PreparedTexts,
    document: &SceneDocument,
    effective: &[gx_contracts::scene::ResolvedObject],
    surface: &mut crate::rasterise::RasterSurface,
) -> Result<(), Refusal> {
    rasterise_selected(prepared, None, document, effective, surface)
}

/// Rasterise one prepared text object, for composing in draw order.
pub fn rasterise_text(
    prepared: &PreparedTexts,
    object_id: &str,
    document: &SceneDocument,
    effective: &[gx_contracts::scene::ResolvedObject],
    surface: &mut crate::rasterise::RasterSurface,
) -> Result<(), Refusal> {
    rasterise_selected(prepared, Some(object_id), document, effective, surface)
}

fn rasterise_selected(
    prepared: &PreparedTexts,
    only: Option<&str>,
    document: &SceneDocument,
    effective: &[gx_contracts::scene::ResolvedObject],
    surface: &mut crate::rasterise::RasterSurface,
) -> Result<(), Refusal> {
    for text_object in prepared
        .objects
        .iter()
        .filter(|text_object| only.is_none_or(|id| text_object.object_id == id))
    {
        let Some(resolved) = effective
            .iter()
            .find(|r| r.id == text_object.object_id)
        else {
            continue;
        };
        if !resolved.visible || resolved.opacity <= 0.0 {
            continue;
        }

        let authored = document
            .objects
            .iter()
            .find_map(|o| match o {
                SceneObject::Text(t) if t.base.id == text_object.object_id => Some(t),
                _ => None,
            });
        let Some(text) = authored else { continue };

        let fill = match &text.base.fill {
            Some(gx_contracts::color::ColorValue::Solid { color }) => {
                crate::colour_pipeline::WorkingRgba::from_source(*color, document.working_color_space)
            }
            Some(gx_contracts::color::ColorValue::LinearGradient { .. })
            | Some(gx_contracts::color::ColorValue::RadialGradient { .. }) => {
                return Err(Refusal::UnsupportedPathGradient {
                    object: text_object.object_id.clone(),
                    paint: "text fill".into(),
                });
            }
            Some(gx_contracts::color::ColorValue::None) | None => {
                crate::colour_pipeline::WorkingRgba::transparent()
            }
        };

        // 3.22: with effects, opacity applies after them (`prepared::compose`).
        let opacity = if text.base.effects().is_empty() { resolved.opacity as f32 } else { 1.0 };
        if opacity <= 0.0 {
            continue;
        }

        let glyph_fill = crate::colour_pipeline::WorkingRgba {
            r: fill.r * opacity,
            g: fill.g * opacity,
            b: fill.b * opacity,
            a: fill.a * opacity,
        };
        if glyph_fill.a <= 0.0 {
            continue;
        }

        // One union per text object, so overlapping glyphs composite once.
        let mut triangles = Vec::with_capacity(text_object.indices.len() / 3);
        for triangle in text_object.indices.chunks_exact(3) {
            let mut corners = [crate::rasterise::PathVertex { x: 0.0, y: 0.0 }; 3];
            for (corner, &index) in corners.iter_mut().zip(triangle) {
                let Some(&[x, y]) = text_object.vertices.get(index as usize) else {
                    return Err(Refusal::VectorTessellationFailed {
                        object: text_object.object_id.clone(),
                        detail: "a glyph triangle indexes past its vertices".into(),
                    });
                };
                let at = crate::rasterise::transform(&text.base.anchor, resolved, f64::from(x), f64::from(y))?;
                *corner = crate::rasterise::PathVertex { x: at.x, y: at.y };
            }
            triangles.push(corners);
        }
        crate::rasterise::fill_union(surface, &triangles, glyph_fill);
    }
    Ok(())
}

/// Shape every text object without consulting system fonts.
pub fn prepare_texts(
    document: &SceneDocument,
    asset_bytes: &AssetBytes,
) -> Result<PreparedTexts, Refusal> {
    let mut objects = Vec::new();
    for object in &document.objects {
        let SceneObject::Text(text) = object else {
            continue;
        };
        let primary = document
            .font(&text.font_id)
            .ok_or_else(|| Refusal::SceneFontUnknown {
                font_id: text.font_id.clone(),
                object: text.base.id.clone(),
            })?;
        if !primary.enabled || primary.status != FontLoadStatus::Ready {
            return Err(Refusal::FontMissing {
                font_id: primary.font_id.clone(),
            });
        }

        let mut definitions = vec![primary];
        for family in &primary.fallback_families {
            let fallback = document
                .fonts
                .iter()
                .find(|candidate| candidate.enabled && candidate.family == *family)
                .ok_or_else(|| Refusal::FontMissing {
                    font_id: family.clone(),
                })?;
            if fallback.status != FontLoadStatus::Ready {
                return Err(Refusal::FontMissing {
                    font_id: fallback.font_id.clone(),
                });
            }
            if !definitions
                .iter()
                .any(|definition| definition.font_id == fallback.font_id)
            {
                definitions.push(fallback);
            }
        }

        objects.push(shape_object(document, text, &definitions, asset_bytes)?);
    }
    Ok(PreparedTexts { objects })
}

fn shape_object(
    document: &SceneDocument,
    text: &gx_contracts::scene::TextObject,
    definitions: &[&FontDefinition],
    asset_bytes: &AssetBytes,
) -> Result<PreparedTextObject, Refusal> {
    let mut database = fontdb::Database::new();
    let mut face_names = HashMap::new();
    let mut primary_family = None;

    for definition in definitions {
        load_definition(
            document,
            definition,
            asset_bytes,
            &mut database,
            &mut face_names,
            &mut primary_family,
            definition.font_id == text.font_id,
        )?;
    }

    let primary_family = primary_family.ok_or_else(|| Refusal::FontMissing {
        font_id: text.font_id.clone(),
    })?;
    let mut font_system = FontSystem::new_with_locale_and_db("en-US".into(), database);
    let font_size = finite_positive(text.size, 1.0);
    let line_height = match text.line_height {
        Some(multiple) => finite_positive(multiple * text.size, font_size),
        // Absent means the font's own metrics (the contract), not 1.2 × size.
        None => font_line_height(&mut font_system, &primary_family, font_size).ok_or_else(|| {
            Refusal::FontMissing {
                font_id: text.font_id.clone(),
            }
        })?,
    };
    let mut buffer = Buffer::new(&mut font_system, Metrics::new(font_size, line_height));
    let (width, height) = match text.layout {
        TextLayout::Point => (None, None),
        // Overflow is Visible here (Hidden and Clip refuse in `support.rs`), so
        // every line draws: the box height must not cut lines off.
        TextLayout::Paragraph => (Some(finite_non_negative(text.base.width)), None),
    };
    buffer.set_size(&mut font_system, width, height);

    let source = apply_case(&text.text, text.text_case);
    let shaped_source = apply_direction(&source, text.direction);
    let mut attrs = Attrs::new().family(Family::Name(&primary_family));
    if text.letter_spacing != 0.0 {
        // The contract's tracking is in thousandths of an em; cosmic-text's is
        // in em.
        attrs = attrs.letter_spacing((text.letter_spacing / 1000.0) as f32);
    }
    let align = match text.align {
        gx_contracts::scene::TextAlign::Left => Some(Align::Left),
        gx_contracts::scene::TextAlign::Center => Some(Align::Center),
        gx_contracts::scene::TextAlign::Right => Some(Align::Right),
    };
    buffer.set_text(
        &mut font_system,
        &shaped_source,
        &attrs,
        Shaping::Advanced,
        align,
    );

    let mut glyphs = Vec::new();
    let mut measured_width = 0.0_f32;
    let mut measured_height = 0.0_f32;
    let mut outlines = SwashCache::new();
    let mut geometry: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let mut tessellator = FillTessellator::new();
    for run in buffer.layout_runs() {
        measured_width = measured_width.max(run.line_w);
        measured_height = measured_height.max(run.line_top + run.line_height);
        for glyph in run.glyphs {
            let Some(face_id) = face_names.get(&glyph.font_id) else {
                return Err(Refusal::FontMissing {
                    font_id: text.font_id.clone(),
                });
            };
            if glyph.glyph_id == 0 {
                return Err(Refusal::FontMissing {
                    font_id: text.font_id.clone(),
                });
            }
            glyphs.push(PreparedGlyph {
                face_id: face_id.clone(),
                glyph_id: glyph.glyph_id,
                source_start: glyph.start,
                source_end: glyph.end,
                x: glyph.x,
                y: run.line_y + glyph.y,
                width: glyph.w,
                bidi_level: glyph.level.number(),
            });

            // The glyph's pen position, as cosmic-text places it.
            let pen_x = glyph.x + glyph.font_size * glyph.x_offset;
            let pen_y = run.line_y + glyph.y - glyph.font_size * glyph.y_offset;
            let key = glyph.physical((0.0, 0.0), 1.0).cache_key;
            let Some(commands) = outlines.get_outline_commands(&mut font_system, key) else {
                return Err(Refusal::ScenePropertyNotDrawable {
                    object: text.base.id.clone(),
                    property: format!("glyph {} has no outline", glyph.glyph_id),
                    owner: "3.18".into(),
                });
            };
            if commands.is_empty() {
                continue; // whitespace
            }
            let path = outline_path(commands, pen_x, pen_y);
            tessellator
                .tessellate_path(
                    &path,
                    &FillOptions::non_zero().with_tolerance(0.02),
                    &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| {
                        let at = vertex.position();
                        [at.x, at.y]
                    }),
                )
                .map_err(|error| Refusal::VectorTessellationFailed {
                    object: text.base.id.clone(),
                    detail: error.to_string(),
                })?;
        }
    }

    Ok(PreparedTextObject {
        object_id: text.base.id.clone(),
        text: source,
        glyphs,
        width: measured_width,
        height: measured_height,
        vertices: geometry.vertices,
        indices: geometry.indices,
    })
}

/// A glyph outline as a lyon path in the text's own coordinates. Outlines are
/// y-up from the glyph's pen position; text space is y-down from the box's
/// top-left.
fn outline_path(commands: &[Command], pen_x: f32, pen_y: f32) -> Path {
    let at = |p: OutlinePoint| point(pen_x + p.x, pen_y - p.y);
    let mut builder = Path::builder();
    let mut open = false;
    for command in commands {
        match *command {
            Command::MoveTo(p) => {
                if open {
                    builder.end(false);
                }
                builder.begin(at(p));
                open = true;
            }
            Command::LineTo(p) if open => {
                builder.line_to(at(p));
            }
            Command::QuadTo(c, p) if open => {
                builder.quadratic_bezier_to(at(c), at(p));
            }
            Command::CurveTo(c1, c2, p) if open => {
                builder.cubic_bezier_to(at(c1), at(c2), at(p));
            }
            Command::Close if open => {
                builder.end(true);
                open = false;
            }
            _ => {}
        }
    }
    if open {
        builder.end(false);
    }
    builder.build()
}

/// The primary face's own line spacing in pixels at `size`: ascent plus
/// descent plus line gap, which is what the contract means by an absent
/// line height.
fn font_line_height(font_system: &mut FontSystem, family: &str, size: f32) -> Option<f32> {
    let families = [fontdb::Family::Name(family)];
    let query = fontdb::Query { families: &families, ..fontdb::Query::default() };
    let id = font_system.db().query(&query)?;
    let font = font_system.get_font(id, fontdb::Weight::NORMAL)?;
    let metrics = font.as_swash().metrics(&[]);
    let units = f32::from(metrics.units_per_em);
    (units > 0.0).then(|| (metrics.ascent + metrics.descent + metrics.leading) / units * size)
}

#[allow(clippy::too_many_arguments)]
fn load_definition(
    document: &SceneDocument,
    definition: &FontDefinition,
    asset_bytes: &AssetBytes,
    database: &mut fontdb::Database,
    face_names: &mut HashMap<fontdb::ID, String>,
    primary_family: &mut Option<String>,
    is_primary: bool,
) -> Result<(), Refusal> {
    if definition.faces.is_empty() {
        return Err(Refusal::FontMissing {
            font_id: definition.font_id.clone(),
        });
    }
    for face in &definition.faces {
        if face.status.is_some_and(|status| status != FontLoadStatus::Ready) {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        }
        let FontSource::File { asset_id, .. } = &face.source else {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        };
        let asset = document.asset(asset_id).ok_or_else(|| Refusal::SceneAssetUnknown {
            asset_id: asset_id.clone(),
            object: definition.font_id.clone(),
        })?;
        if asset.kind != AssetKind::Font {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        }
        let hash = asset.checksum.as_ref().ok_or_else(|| Refusal::FontMissing {
            font_id: definition.font_id.clone(),
        })?;
        let bytes = asset_bytes.get(hash).ok_or_else(|| Refusal::AssetMissing {
            hash: hash.clone(),
        })?;
        // WOFF/WOFF2 are delivery wrappers; fontdb reads only sfnt. The
        // container module is the one decoder the ingest path also verified
        // with, so a font that ingested is a font that loads here.
        let sfnt: Arc<Vec<u8>> = Arc::new(gx_asset_plane::fonts::container::sfnt_bytes(bytes)?.into_owned());
        let mut ids: Vec<fontdb::ID> = database
            .load_font_source(fontdb::Source::Binary(sfnt.clone()))
            .into_iter()
            .collect();
        if ids.is_empty() {
            // fontdb refuses a face that names no family; the bytes must
            // still be a font before the declaration may name them.
            gx_asset_plane::fonts::metadata::inspect_declared_font(&sfnt, &face.family).map_err(|_| {
                Refusal::InvalidFontData {
                    detail: format!("font {} contains no readable face", face.face_id),
                }
            })?;
            ids.push(declared_face(database, None, fontdb::Source::Binary(sfnt.clone()), face)?);
        }
        for id in ids {
            let named = database
                .face(id)
                .and_then(|info| info.families.first())
                .map(|family| family.0.trim().to_owned())
                .filter(|family| !family.is_empty());
            let (id, loaded_family) = match named {
                Some(family) => (id, family),
                None => {
                    let source = fontdb::Source::Binary(sfnt.clone());
                    (declared_face(database, Some(id), source, face)?, face.family.trim().to_owned())
                }
            };
            if is_primary && primary_family.is_none() {
                *primary_family = Some(loaded_family);
            }
            face_names.insert(id, face.face_id.clone());
        }
    }
    Ok(())
}

/// File a face under the family its definition declares, when its file names
/// none. Adobe Fonts kit files carry an empty family name (the kit's
/// stylesheet declares it): fontdb refuses a face with no name at all, and
/// would file every blank-named face under the same empty family, where one
/// font's text could be drawn in another's face. Weight and style come from
/// the declaration as well, as the stylesheet stated them.
fn declared_face(
    database: &mut fontdb::Database,
    loaded: Option<fontdb::ID>,
    source: fontdb::Source,
    face: &gx_contracts::font::FontFaceDefinition,
) -> Result<fontdb::ID, Refusal> {
    let family = face.family.trim();
    if family.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: format!("font {} carries no family name", face.face_id),
        });
    }
    let existing = loaded.and_then(|id| {
        let info = database.face(id).cloned();
        database.remove_face(id);
        info
    });
    let mut info = existing.unwrap_or(fontdb::FaceInfo {
        id: fontdb::ID::dummy(),
        source,
        index: 0,
        families: Vec::new(),
        post_script_name: String::new(),
        style: fontdb::Style::Normal,
        weight: fontdb::Weight::NORMAL,
        stretch: fontdb::Stretch::Normal,
        monospaced: false,
    });
    info.families = vec![(family.to_owned(), fontdb::Language::English_UnitedStates)];
    info.post_script_name = family.replace(' ', "-");
    info.weight = fontdb::Weight(face.weight);
    info.style = match face.style {
        FontStyle::Normal => fontdb::Style::Normal,
        FontStyle::Italic => fontdb::Style::Italic,
        FontStyle::Oblique => fontdb::Style::Oblique,
    };
    Ok(database.push_face_info(info))
}

fn apply_case(text: &str, text_case: TextCase) -> String {
    match text_case {
        TextCase::Original | TextCase::SmallCaps => text.to_owned(),
        TextCase::Upper => text.to_uppercase(),
        TextCase::Lower => text.to_lowercase(),
        TextCase::Title => text
            .split_inclusive(char::is_whitespace)
            .map(|word| {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect(),
    }
}

fn apply_direction(text: &str, direction: TextDirection) -> String {
    match direction {
        TextDirection::Auto => text.to_owned(),
        TextDirection::Ltr => format!("\u{202a}{text}\u{202c}"),
        TextDirection::Rtl => format!("\u{202b}{text}\u{202c}"),
    }
}

fn finite_positive(value: f64, fallback: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.min(f32::MAX as f64) as f32
    } else {
        fallback
    }
}

fn finite_non_negative(value: f64) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.min(f32::MAX as f64) as f32
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::font::{EmbeddingPolicy, FontFaceDefinition, FontFormat};
    use gx_contracts::scene::{
        AssetLibraryItem, ObjectBase, SceneCanvas, SceneTimeline, TextObject,
    };
    use gx_contracts::{RationalRate, Revision};

    const INTER: &[u8] = include_bytes!("../tests/fixtures/Inter-Regular.ttf");
    const HEBREW: &[u8] = include_bytes!("../tests/fixtures/NotoSansHebrew.ttf");

    fn font(id: &str, family: &str, asset_id: &str, fallbacks: Vec<String>) -> FontDefinition {
        FontDefinition {
            font_id: id.into(),
            family: family.into(),
            display_name: family.into(),
            faces: vec![FontFaceDefinition {
                face_id: format!("{id}-regular"),
                family: family.into(),
                weight: 400,
                style: FontStyle::Normal,
                stretch: None,
                unicode_range: None,
                source: FontSource::File {
                    asset_id: asset_id.into(),
                    format: FontFormat::Ttf,
                    original_url: None,
                    stylesheet_url: None,
                },
                status: Some(FontLoadStatus::Ready),
                error_message: None,
            }],
            fallback_families: fallbacks,
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    fn text_object(value: &str, font_id: &str) -> SceneObject {
        let mut base = ObjectBase::new("title", "Title");
        base.width = 800.0;
        base.height = 120.0;
        SceneObject::Text(TextObject {
            base,
            text: value.into(),
            font_id: font_id.into(),
            size: 48.0,
            layout: TextLayout::Paragraph,
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: TextDirection::Auto,
            text_case: TextCase::Original,
            decoration: Default::default(),
            overflow: Default::default(),
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        })
    }

    fn scene(value: &str, font_id: &str, fonts: Vec<FontDefinition>) -> SceneDocument {
        let assets = fonts
            .iter()
            .flat_map(|font| font.faces.iter())
            .filter_map(|face| match &face.source {
                FontSource::File { asset_id, .. } => Some(AssetLibraryItem {
                    asset_id: asset_id.clone(),
                    name: asset_id.clone(),
                    kind: AssetKind::Font,
                    path: format!("assets/{asset_id}.ttf"),
                    checksum: Some(ContentHash(asset_id.clone())),
                    mime_type: Some("font/ttf".into()),
                    size_bytes: None,
                    status: None,
                    provenance: Default::default(),
                }),
                _ => None,
            })
            .collect();
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: "text-scene".into(),
            name: "Text scene".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline { duration_frames: 1, ..Default::default() },
            data_context: Default::default(),
            assets,
            fonts,
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: vec![text_object(value, font_id)],
        }
    }

    #[test]
    fn missing_font_refuses_before_shaping() {
        let document = scene("On air", "missing", Vec::new());
        assert!(matches!(
            prepare_texts(&document, &AssetBytes::new()),
            Err(Refusal::SceneFontUnknown { font_id, .. }) if font_id == "missing"
        ));
    }

    #[test]
    fn advanced_shaping_uses_opentype_bidi_and_declared_fallback_only() {
        let fonts = vec![
            font("inter", "Inter", "inter", vec!["Noto Sans Hebrew".into()]),
            font("hebrew", "Noto Sans Hebrew", "hebrew", Vec::new()),
        ];
        let document = scene("office אבג", "inter", fonts);
        let bytes = AssetBytes::from([
            (ContentHash("inter".into()), INTER.to_vec()),
            (ContentHash("hebrew".into()), HEBREW.to_vec()),
        ]);
        let prepared = prepare_texts(&document, &bytes).expect("declared fonts shape");
        let text = &prepared.objects[0];
        assert!(text.glyphs.iter().any(|glyph| glyph.source_end - glyph.source_start > 1), "OpenType ligature was not formed");
        assert!(text.glyphs.iter().any(|glyph| glyph.bidi_level % 2 == 1), "RTL run was not resolved");
        assert!(text.glyphs.iter().any(|glyph| glyph.face_id == "hebrew-regular"), "declared Hebrew fallback was not used");
    }

    fn lit_area(document: &SceneDocument, assets: &AssetBytes) -> (usize, [f32; 4]) {
        let prepared = prepare_texts(document, assets).expect("the text shapes");
        let resolution = gx_contracts::scene::resolve_hierarchy(&document.objects);
        let mut surface =
            crate::rasterise::RasterSurface::transparent(document.canvas.width, document.canvas.height);
        rasterise_texts(&prepared, document, &resolution.effective, &mut surface).expect("the text draws");
        let width = surface.width() as usize;
        let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut count = 0;
        for (index, pixel) in surface.pixels().iter().enumerate() {
            if pixel.a > 0.5 {
                count += 1;
                let (x, y) = ((index % width) as f32, (index / width) as f32);
                bounds = [bounds[0].min(x), bounds[1].min(y), bounds[2].max(x), bounds[3].max(y)];
            }
        }
        (count, bounds)
    }

    fn white_text(value: &str, size: f64, edit: impl Fn(&mut TextObject)) -> (SceneDocument, AssetBytes) {
        let mut document = scene(value, "inter", vec![font("inter", "Inter", "inter", Vec::new())]);
        for object in &mut document.objects {
            if let SceneObject::Text(text) = object {
                text.size = size;
                text.base.x = 600.0;
                text.base.y = 400.0;
                text.base.fill = Some(gx_contracts::color::ColorValue::Solid {
                    color: gx_contracts::color::Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                });
                edit(text);
            }
        }
        (document, AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]))
    }

    /// 3.13: text draws as real glyph outlines, not advance rectangles. An
    /// Inter "I" at 200 px is a stem about 0.09 em wide and one cap height
    /// tall, a few thousand pixels; its advance rectangle would be over
    /// ten thousand.
    #[test]
    fn a_glyph_draws_its_outline_not_its_advance_rectangle() {
        let (document, assets) = white_text("I", 200.0, |_| {});
        let (count, [x0, y0, x1, y1]) = lit_area(&document, &assets);
        assert!((1500..=4500).contains(&count), "an I lit {count} pixels");
        assert!((10.0..=30.0).contains(&(x1 - x0)), "stem width {}", x1 - x0);
        assert!((130.0..=160.0).contains(&(y1 - y0)), "cap height {}", y1 - y0);
    }

    /// 3.13: text takes the object's rotation like any shape; a quarter turn
    /// swaps the glyph's width and height.
    #[test]
    fn text_rotates_with_its_object() {
        let (document, assets) = white_text("I", 200.0, |text| text.base.rotation = 90.0);
        let (count, [x0, y0, x1, y1]) = lit_area(&document, &assets);
        assert!((1500..=4500).contains(&count), "a rotated I lit {count} pixels");
        assert!((130.0..=160.0).contains(&(x1 - x0)), "rotated width {}", x1 - x0);
        assert!((10.0..=30.0).contains(&(y1 - y0)), "rotated height {}", y1 - y0);
    }

    /// Letter spacing is drawn: 100 thousandths of an em at 100 px adds about
    /// 10 px per glyph.
    #[test]
    fn letter_spacing_widens_the_run_by_the_tracking() {
        let shaped = |tracking: f64| {
            let (document, assets) = white_text("ABCD", 100.0, |text| text.letter_spacing = tracking);
            prepare_texts(&document, &assets).expect("shapes").objects[0].width
        };
        let added = shaped(100.0) - shaped(0.0);
        assert!((30.0..=45.0).contains(&added), "tracking added {added} px");
    }

    /// An absent line height is the font's own metrics, read here straight
    /// from the font file rather than through the font system.
    #[test]
    fn an_absent_line_height_follows_the_fonts_metrics() {
        let metrics = swash::FontRef::from_index(INTER, 0).expect("Inter parses").metrics(&[]);
        let expected = (metrics.ascent + metrics.descent + metrics.leading) / f32::from(metrics.units_per_em) * 100.0;
        let (document, assets) = white_text("A\nB", 100.0, |_| {});
        let height = prepare_texts(&document, &assets).expect("shapes").objects[0].height;
        assert!((height - 2.0 * expected).abs() <= 1.0, "two lines {height}, metrics line {expected}");
        let (document, assets) = white_text("A\nB", 100.0, |text| text.line_height = Some(1.5));
        let height = prepare_texts(&document, &assets).expect("shapes").objects[0].height;
        assert!((height - 300.0).abs() <= 1.0, "two lines at 1.5 gave {height}");
    }

    /// An sfnt whose family names (IDs 1 and 16) are present but empty, as
    /// Adobe Fonts serves kit files.
    fn blank_family_names(sfnt: &[u8]) -> Vec<u8> {
        let mut out = sfnt.to_vec();
        let be16 = |b: &[u8], at: usize| usize::from(u16::from_be_bytes([b[at], b[at + 1]]));
        let record = (0..be16(&out, 4))
            .map(|i| 12 + 16 * i)
            .find(|&r| &out[r..r + 4] == b"name")
            .expect("the fixture has a name table");
        let offset = u32::from_be_bytes(out[record + 8..record + 12].try_into().unwrap()) as usize;
        for i in 0..be16(&out, offset + 2) {
            let r = offset + 6 + 12 * i;
            if matches!(be16(&out, r + 6), 1 | 16) {
                out[r + 8] = 0;
                out[r + 9] = 0;
            }
        }
        out
    }

    /// Set OS/2 usWeightClass, as Adobe's bold kit files carry 700.
    fn with_weight_class(sfnt: &[u8], weight: u16) -> Vec<u8> {
        let mut out = sfnt.to_vec();
        let tables = usize::from(u16::from_be_bytes([out[4], out[5]]));
        let record = (0..tables)
            .map(|i| 12 + 16 * i)
            .find(|&r| &out[r..r + 4] == b"OS/2")
            .expect("the fixture has an OS/2 table");
        let offset = u32::from_be_bytes(out[record + 8..record + 12].try_into().unwrap()) as usize;
        out[offset + 4..offset + 6].copy_from_slice(&weight.to_be_bytes());
        out
    }

    /// Adobe Fonts kit files name no family; their definitions do. fontdb
    /// files such faces under an empty name, so a bold kit font and a
    /// regular fallback both answered to "" and the regular one won the
    /// lookup: the text was drawn in its fallback. Each face is now found
    /// under its declared family, and the text's own font draws it.
    #[test]
    fn faces_whose_files_name_no_family_shape_under_their_declared_family() {
        const LATIN: &[u8] = include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.ttf");
        let mut bold = font("alpha", "Alpha", "alpha", vec!["Beta".into()]);
        bold.faces[0].weight = 700;
        let fonts = vec![bold, font("beta", "Beta", "beta", Vec::new())];
        let bytes = AssetBytes::from([
            (ContentHash("alpha".into()), with_weight_class(&blank_family_names(INTER), 700)),
            (ContentHash("beta".into()), blank_family_names(LATIN)),
        ]);
        let prepared = prepare_texts(&scene("Office", "alpha", fonts), &bytes).expect("the faces shape");
        let glyphs = &prepared.objects[0].glyphs;
        assert!(!glyphs.is_empty() && glyphs.iter().all(|g| g.glyph_id != 0));
        let faces: Vec<&str> = glyphs.iter().map(|g| g.face_id.as_str()).collect();
        assert!(faces.iter().all(|f| *f == "alpha-regular"), "drawn in {faces:?}, not the text's own font");
    }

    #[test]
    fn a_woff2_asset_shapes_exactly_like_its_sfnt_original() {
        const TTF: &[u8] = include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.ttf");
        const WOFF2: &[u8] = include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.woff2");
        let shaped = |bytes: &[u8]| {
            let document = scene("Office 2026", "inter", vec![font("inter", "Inter", "inter", Vec::new())]);
            let assets = AssetBytes::from([(ContentHash("inter".into()), bytes.to_vec())]);
            prepare_texts(&document, &assets).expect("the font shapes")
        };
        let (from_ttf, from_woff2) = (shaped(TTF), shaped(WOFF2));
        let glyphs = |prepared: &PreparedTexts| {
            prepared.objects[0].glyphs.iter().map(|g| (g.glyph_id, g.x.to_bits())).collect::<Vec<_>>()
        };
        assert!(!from_ttf.objects[0].glyphs.is_empty());
        assert_eq!(glyphs(&from_ttf), glyphs(&from_woff2));
    }
}

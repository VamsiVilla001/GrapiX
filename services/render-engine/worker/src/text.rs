//! Text preparation through `cosmic-text` (build plan 3.6).
//!
//! Only packaged, content-addressed font bytes enter the font database. The
//! system font database is never loaded, so a missing face cannot turn into a
//! platform-dependent substitution. Shaping, bidi resolution, fallback and
//! OpenType layout all happen once when a scene is published.

use std::collections::HashMap;
use std::sync::Arc;

use cosmic_text::{fontdb, Align, Attrs, Buffer, Family, FontSystem, Metrics, Shaping};
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
}

/// Text-side state built once for a published scene.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreparedTexts {
    pub objects: Vec<PreparedTextObject>,
}

/// Rasterise prepared text objects onto a linear-light surface in scene draw
/// order.  Every glyph was shaped and positioned at publication time; this
/// function only needs to place the resulting advance rectangles into the
/// correct pixels.
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
    for text_object in &prepared.objects {
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
                crate::colour_pipeline::LinearRgba::from_source(*color)
            }
            Some(gx_contracts::color::ColorValue::LinearGradient { .. })
            | Some(gx_contracts::color::ColorValue::RadialGradient { .. }) => {
                return Err(Refusal::UnsupportedPathGradient {
                    object: text_object.object_id.clone(),
                    paint: "text fill".into(),
                });
            }
            Some(gx_contracts::color::ColorValue::None) | None => {
                crate::colour_pipeline::LinearRgba::transparent()
            }
        };

        let opacity = resolved.opacity as f32;
        if opacity <= 0.0 {
            continue;
        }

        let offset_x = resolved.x as f32;
        let offset_y = resolved.y as f32;
        let glyph_fill = crate::colour_pipeline::LinearRgba {
            r: fill.r * opacity,
            g: fill.g * opacity,
            b: fill.b * opacity,
            a: fill.a * opacity,
        };
        if glyph_fill.a <= 0.0 {
            continue;
        }

        // Approximate glyph height from the text object's line height.
        let line_height = if text_object.glyphs.is_empty() {
            0.0
        } else {
            text_object.height / text_object.glyphs.len() as f32
        };
        let h = (line_height.max(1.0)) as u32;

        for glyph in &text_object.glyphs {
            let x0 = (offset_x + glyph.x).max(0.0) as u32;
            let y0 = (offset_y + glyph.y).max(0.0) as u32;
            let w = (glyph.width.max(1.0)) as u32;
            for dy in 0..h {
                let py = y0 + dy;
                if py >= surface.height() {
                    break;
                }
                for dx in 0..w {
                    let px = x0 + dx;
                    if px >= surface.width() {
                        break;
                    }
                    surface.composite(px, py, glyph_fill);
                }
            }
        }
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
    let line_height = finite_positive(text.line_height.unwrap_or(1.2) * text.size, font_size);
    let mut buffer = Buffer::new(&mut font_system, Metrics::new(font_size, line_height));
    let (width, height) = match text.layout {
        TextLayout::Point => (None, None),
        TextLayout::Paragraph => (
            Some(finite_non_negative(text.base.width)),
            Some(finite_non_negative(text.base.height)),
        ),
    };
    buffer.set_size(&mut font_system, width, height);

    let source = apply_case(&text.text, text.text_case);
    let shaped_source = apply_direction(&source, text.direction);
    let attrs = Attrs::new().family(Family::Name(&primary_family));
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
        }
    }

    Ok(PreparedTextObject {
        object_id: text.base.id.clone(),
        text: source,
        glyphs,
        width: measured_width,
        height: measured_height,
    })
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
        let sfnt = gx_asset_plane::fonts::container::sfnt_bytes(bytes)?;
        let ids = database.load_font_source(fontdb::Source::Binary(Arc::new(sfnt.into_owned())));
        if ids.is_empty() {
            return Err(Refusal::InvalidFontData {
                detail: format!("font {} contains no readable face", face.face_id),
            });
        }
        for id in ids {
            let loaded_family = database
                .face(id)
                .and_then(|info| info.families.first())
                .map(|family| family.0.clone())
                .ok_or_else(|| Refusal::InvalidFontData {
                    detail: format!("font {} carries no family name", face.face_id),
                })?;
            if is_primary && primary_family.is_none() {
                *primary_family = Some(loaded_family);
            }
            face_names.insert(id, face.face_id.clone());
        }
    }
    Ok(())
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
                }),
                _ => None,
            })
            .collect();
        SceneDocument {
            id: "text-scene".into(),
            name: "Text scene".into(),
            version: 1,
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

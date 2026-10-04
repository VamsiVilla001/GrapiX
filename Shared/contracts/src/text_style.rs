//! Named text-style presets (build plan 11.28).
//!
//! A style is an applyable bundle, while the design system remains the one
//! owner of brand values. Token references are therefore resolved only when a
//! style is applied; a saved style never snapshots a token value.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::ColorValue;
use crate::design_system::{DesignSystem, TokenRef};
use crate::scene::{SceneDocument, SceneObject, TextCase};
use crate::Refusal;

/// A numeric text-style value, either literal or resolved from the active
/// project design system when the style is applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(untagged)]
pub enum StyleNumber {
    Token(TokenRef),
    Literal(f64),
}

/// A text-style colour, either literal or resolved from the active project
/// design system when the style is applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(untagged)]
pub enum StyleColor {
    Token(TokenRef),
    Literal(ColorValue),
}

/// A named, reusable subset of a text object's appearance.
///
/// Optional entries are deliberately absent rather than defaults: applying a
/// style must not overwrite a property its author did not declare.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub style_id: String,
    pub name: String,
    pub font_id: String,
    pub size: StyleNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_height: Option<StyleNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub letter_spacing: Option<StyleNumber>,
    pub text_case: TextCase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill: Option<StyleColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke: Option<StyleColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke_width: Option<StyleNumber>,
}
/// Validate the reusable style library carried by a loaded scene.
///
/// Token references intentionally remain unresolved until an author applies a
/// style with the active project design system. Stable ids and font links do
/// not need that external context and must be unambiguous before publication.
pub fn validate_text_styles(scene: &SceneDocument) -> Result<(), Refusal> {
    let mut ids = std::collections::BTreeSet::new();
    for style in &scene.text_styles {
        if !ids.insert(style.style_id.as_str()) {
            return Err(Refusal::TextStyleDuplicate {
                style_id: style.style_id.clone(),
            });
        }
        if scene.font(&style.font_id).is_none() {
            return Err(Refusal::TextStyleFontUnknown {
                style_id: style.style_id.clone(),
                font_id: style.font_id.clone(),
            });
        }
    }
    Ok(())
}
/// Save a named text style after proving its id and font are usable.
///
/// Styles are immutable by id at this command boundary: an existing id is
/// ambiguous to callers that mean to save a new reusable style, so it refuses
/// rather than silently replacing the prior definition.
pub fn save_text_style(scene: &mut SceneDocument, style: TextStyle) -> Result<(), Refusal> {
    if scene
        .text_styles
        .iter()
        .any(|existing| existing.style_id == style.style_id)
    {
        return Err(Refusal::TextStyleDuplicate {
            style_id: style.style_id,
        });
    }
    if scene.font(&style.font_id).is_none() {
        return Err(Refusal::TextStyleFontUnknown {
            style_id: style.style_id,
            font_id: style.font_id,
        });
    }
    scene.text_styles.push(style);
    Ok(())
}


/// Apply one named style to one text object.
///
/// All lookups and token resolution happen before the object is borrowed for
/// mutation. A refusal therefore leaves the scene byte-for-byte unchanged.
pub fn apply_text_style(
    scene: &mut SceneDocument,
    object_id: &str,
    style_id: &str,
    tokens: Option<&DesignSystem>,
) -> Result<(), Refusal> {
    let style = scene
        .text_styles
        .iter()
        .find(|style| style.style_id == style_id)
        .cloned()
        .ok_or_else(|| Refusal::TextStyleUnknown {
            style_id: style_id.to_owned(),
        })?;

    if scene.font(&style.font_id).is_none() {
        return Err(Refusal::TextStyleFontUnknown {
            style_id: style.style_id,
            font_id: style.font_id,
        });
    }

    let size = resolve_number(&style.size, tokens, style_id)?;
    let line_height = style
        .line_height
        .as_ref()
        .map(|value| resolve_number(value, tokens, style_id))
        .transpose()?;
    let letter_spacing = style
        .letter_spacing
        .as_ref()
        .map(|value| resolve_number(value, tokens, style_id))
        .transpose()?;
    let fill = style
        .fill
        .as_ref()
        .map(|value| resolve_color(value, tokens, style_id))
        .transpose()?;
    let stroke = style
        .stroke
        .as_ref()
        .map(|value| resolve_color(value, tokens, style_id))
        .transpose()?;
    let stroke_width = style
        .stroke_width
        .as_ref()
        .map(|value| resolve_number(value, tokens, style_id))
        .transpose()?;

    let object = scene
        .objects
        .iter_mut()
        .find(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })?;
    let SceneObject::Text(text) = object else {
        return Err(Refusal::AnimationPropertyUnsupported {
            object: object_id.to_owned(),
            property: "textStyle".to_owned(),
        });
    };

    text.font_id = style.font_id;
    text.size = size;
    text.text_case = style.text_case;
    if let Some(line_height) = line_height {
        text.line_height = Some(line_height);
    }
    if let Some(letter_spacing) = letter_spacing {
        text.letter_spacing = letter_spacing;
    }
    if let Some(fill) = fill {
        text.base.fill = Some(fill);
    }
    if let Some(stroke) = stroke {
        text.base.stroke = Some(stroke);
    }
    if let Some(stroke_width) = stroke_width {
        text.base.stroke_width = stroke_width;
    }
    Ok(())
}

fn resolve_number(
    value: &StyleNumber,
    tokens: Option<&DesignSystem>,
    style_id: &str,
) -> Result<f64, Refusal> {
    let StyleNumber::Token(reference) = value else {
        let StyleNumber::Literal(value) = value else {
            unreachable!("StyleNumber has exactly two variants");
        };
        return Ok(*value);
    };
    let Some(system) = tokens else {
        return Err(unresolved(style_id, reference));
    };

    let resolved = match reference.group() {
        "duration" => system
            .motion
            .duration
            .iter()
            .find(|token| token.name == reference.name())
            .map(|token| token.value),
        "stagger" => system
            .motion
            .stagger
            .iter()
            .find(|token| token.name == reference.name())
            .map(|token| token.value),
        // Visual spacing has numeric values rather than a separate named
        // wrapper. Its canonical token path is therefore `{spacing.<value>}`.
        "spacing" => reference
            .name()
            .parse::<f64>()
            .ok()
            .and_then(|name| system.visual.spacing.iter().copied().find(|value| *value == name)),
        "minTextSize" if reference.name() == "default" => Some(system.visual.min_text_size),
        _ => None,
    };
    resolved.ok_or_else(|| unresolved(style_id, reference))
}

fn resolve_color(
    value: &StyleColor,
    tokens: Option<&DesignSystem>,
    style_id: &str,
) -> Result<ColorValue, Refusal> {
    let StyleColor::Token(reference) = value else {
        let StyleColor::Literal(value) = value else {
            unreachable!("StyleColor has exactly two variants");
        };
        return Ok(value.clone());
    };
    let Some(system) = tokens else {
        return Err(unresolved(style_id, reference));
    };

    // Visual palette names are the design system's public colour namespace;
    // styles carry that name rather than a duplicate RGBA literal.
    system
        .visual
        .palette
        .iter()
        .find(|token| reference.group() == "palette" && token.name == reference.name())
        .map(|token| ColorValue::Solid { color: token.value })
        .ok_or_else(|| unresolved(style_id, reference))
}

fn unresolved(style_id: &str, token: &TokenRef) -> Refusal {
    Refusal::TextStyleTokenUnresolved {
        style_id: style_id.to_owned(),
        token: format!("{{{}}}", token.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::Rgba;
    use crate::design_system::{MotionTokens, Named, VisualTokens};
    use crate::font::{EmbeddingPolicy, FontDefinition, FontLoadStatus};
    use crate::scene::{ObjectBase, SceneCanvas, SceneTimeline, TextObject};
    use crate::{RationalRate, Revision};

    fn scene() -> SceneDocument {
        SceneDocument {
            id: "scene".into(),
            name: "Style test".into(),
            version: crate::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline::default(),
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: vec![FontDefinition {
                font_id: "inter".into(),
                family: "Inter".into(),
                display_name: "Inter".into(),
                faces: Vec::new(),
                fallback_families: Vec::new(),
                embedding_policy: EmbeddingPolicy::Package,
                license: None,
                enabled: true,
                source_label: None,
                status: FontLoadStatus::Ready,
                error_message: None,
            }],
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: vec![SceneObject::Text(TextObject {
                base: ObjectBase::new("title", "Title"),
                text: "Score".into(),
                font_id: "inter".into(),
                size: 24.0,
                layout: Default::default(),
                auto_fit: Default::default(),
                writing_mode: Default::default(),
                vertical_align: Default::default(),
                direction: Default::default(),
                text_case: TextCase::Original,
                decoration: Default::default(),
                overflow: Default::default(),
                align: Default::default(),
                line_height: Some(1.1),
                letter_spacing: 8.0,
                word_spacing: 0.0,
                paragraph_spacing: 0.0,
                text_indent: 0.0,
            })],
        }
    }

    fn system(brand: Rgba) -> DesignSystem {
        DesignSystem {
            name: "Brand".into(),
            version: 1,
            visual: VisualTokens {
                palette: vec![Named {
                    name: "brand".into(),
                    value: brand,
                }],
                spacing: vec![8.0],
                min_text_size: 20.0,
            },
            motion: MotionTokens {
                duration: Vec::new(),
                easing: Vec::new(),
                stagger: Vec::new(),
            },
        }
    }

    fn style() -> TextStyle {
        TextStyle {
            style_id: "headline".into(),
            name: "Headline".into(),
            font_id: "inter".into(),
            size: StyleNumber::Literal(48.0),
            line_height: None,
            letter_spacing: None,
            text_case: TextCase::Upper,
            fill: Some(StyleColor::Token(TokenRef("palette.brand".into()))),
            stroke: None,
            stroke_width: None,
        }
    }

    #[test]
    fn token_references_resolve_when_the_style_is_applied() {
        let mut scene = scene();
        scene.text_styles.push(style());
        let mut tokens = system(Rgba::srgb(0.1, 0.2, 0.3, 1.0));

        apply_text_style(&mut scene, "title", "headline", Some(&tokens)).unwrap();
        let first = scene.objects[0].base().fill.clone();

        tokens.visual.palette[0].value = Rgba::srgb(0.7, 0.2, 0.1, 1.0);
        apply_text_style(&mut scene, "title", "headline", Some(&tokens)).unwrap();
        let second = scene.objects[0].base().fill.clone();

        assert_ne!(first, second, "reapplying resolves the current token value");
        assert_eq!(second, Some(ColorValue::Solid { color: tokens.visual.palette[0].value }));
    }

    #[test]
    fn applying_a_style_changes_only_its_declared_properties() {
        let mut scene = scene();
        scene.objects[0].base_mut().x = 320.0;
        scene.text_styles.push(style());

        apply_text_style(&mut scene, "title", "headline", Some(&system(Rgba::srgb(1.0, 1.0, 1.0, 1.0))))
            .unwrap();

        let SceneObject::Text(text) = &scene.objects[0] else {
            panic!("fixture is text");
        };
        assert_eq!(text.base.x, 320.0);
        assert_eq!(text.line_height, Some(1.1));
        assert_eq!(text.letter_spacing, 8.0);
        assert_eq!(text.size, 48.0);
        assert_eq!(text.text_case, TextCase::Upper);
    }

    #[test]
    fn unknown_font_refuses_without_writing() {
        let mut scene = scene();
        let mut missing = style();
        missing.font_id = "missing".into();
        scene.text_styles.push(missing);
        let before = scene.clone();

        assert!(matches!(
            apply_text_style(&mut scene, "title", "headline", None),
            Err(Refusal::TextStyleFontUnknown { style_id, font_id })
                if style_id == "headline" && font_id == "missing"
        ));
        assert_eq!(scene, before);
    }

    #[test]
    fn unknown_style_refuses_without_writing() {
        let mut scene = scene();
        let before = scene.clone();

        assert!(matches!(
            apply_text_style(&mut scene, "title", "missing", None),
            Err(Refusal::TextStyleUnknown { style_id }) if style_id == "missing"
        ));
        assert_eq!(scene, before);
    }

    #[test]
    fn unresolved_token_refuses_without_writing() {
        let mut scene = scene();
        scene.text_styles.push(style());
        let before = scene.clone();

        assert!(matches!(
            apply_text_style(&mut scene, "title", "headline", None),
            Err(Refusal::TextStyleTokenUnresolved { style_id, token })
                if style_id == "headline" && token == "{palette.brand}"
        ));
        assert_eq!(scene, before);
    }
    #[test]
    fn loaded_style_ids_are_unique_before_publication() {
        let mut scene = scene();
        let declared = style();
        scene.text_styles = vec![declared.clone(), declared];
        assert!(matches!(
            validate_text_styles(&scene),
            Err(Refusal::TextStyleDuplicate { style_id }) if style_id == "headline"
        ));
    }

}

//! Font definition validation (1.x `validateFontDefinition`).
//!
//! 1.x returned a list of prose strings; 2.0 returns the first named
//! `Refusal` — the structured-refusal contract (0.6) is the point of the
//! port, and a validator that answers in prose is one an agent cannot act
//! on. Validation order matches 1.x so the *first* failure reported for a
//! given definition is the same one 1.x reported first.

use gx_contracts::font::{check_font_face_url, EmbeddingPolicy, FontDefinition, FontSource};
use gx_contracts::Refusal;

/// One validation pass over a font definition. `asset_exists` answers
/// whether an asset id resolves to a known font asset — the caller owns the
/// asset store; this function owns the rules.
pub fn validate_font_definition(
    font: &FontDefinition,
    asset_exists: impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    if !valid_id(&font.font_id) {
        return Err(Refusal::InvalidFontData {
            detail: format!(
                "fontId {:?} must be 1-128 letters, numbers, underscore or hyphen",
                font.font_id
            ),
        });
    }
    if font.family.trim().is_empty() || font.family.chars().count() > 128 {
        return Err(Refusal::InvalidFontData {
            detail: "font family must contain 1 to 128 characters".into(),
        });
    }
    if font.faces.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: "at least one font face is required".into(),
        });
    }
    // A package-policy font with no licence is refused: unstated licence is
    // restricted (docs/p2-licensing-positions.md §5). This is the check that
    // makes the position enforceable rather than aspirational.
    if font.embedding_policy == EmbeddingPolicy::Package && font.license.is_none() {
        return Err(Refusal::FontEmbeddingRefused {
            font_id: font.font_id.clone(),
        });
    }

    let mut seen = std::collections::HashSet::new();
    for face in &font.faces {
        if !valid_id(&face.face_id) {
            return Err(Refusal::InvalidFontData {
                detail: format!("face id {:?} is not a safe identifier", face.face_id),
            });
        }
        if !seen.insert(&face.face_id) {
            return Err(Refusal::InvalidFontData {
                detail: format!("duplicate font face {}", face.face_id),
            });
        }
        if face.family != font.family {
            return Err(Refusal::InvalidFontData {
                detail: format!(
                    "face {} declares family {:?} but the font is {:?}",
                    face.face_id, face.family, font.family
                ),
            });
        }
        if !(1..=1000).contains(&face.weight) {
            return Err(Refusal::InvalidFontData {
                detail: format!(
                    "face {} has weight {}, must be 1-1000",
                    face.face_id, face.weight
                ),
            });
        }
        match &face.source {
            FontSource::File { asset_id, .. } => {
                if !asset_exists(asset_id) {
                    return Err(Refusal::FontMissing {
                        font_id: format!("{} (asset {asset_id})", font.font_id),
                    });
                }
            }
            other => check_font_face_url(other)?,
        }
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::font::*;

    fn base_font() -> FontDefinition {
        FontDefinition {
            font_id: "font_0123456789abcdef".into(),
            family: "Inter".into(),
            display_name: "Inter".into(),
            faces: vec![FontFaceDefinition {
                face_id: "face_0123456789abcdef".into(),
                family: "Inter".into(),
                weight: 400,
                style: FontStyle::Normal,
                stretch: None,
                unicode_range: None,
                source: FontSource::File {
                    asset_id: "asset_1".into(),
                    format: FontFormat::Woff2,
                    original_url: None,
                    stylesheet_url: None,
                },
                status: None,
                error_message: None,
            }],
            fallback_families: vec![],
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    #[test]
    fn a_valid_font_passes() {
        assert!(validate_font_definition(&base_font(), |_| true).is_ok());
    }

    #[test]
    fn a_packaged_font_without_a_licence_is_refused() {
        let mut font = base_font();
        font.license = None;
        assert!(matches!(
            validate_font_definition(&font, |_| true),
            Err(Refusal::FontEmbeddingRefused { .. })
        ));
    }

    #[test]
    fn a_missing_asset_is_a_font_missing_refusal() {
        assert!(matches!(
            validate_font_definition(&base_font(), |_| false),
            Err(Refusal::FontMissing { .. })
        ));
    }

    #[test]
    fn face_problems_are_named() {
        let mut dup = base_font();
        dup.faces.push(dup.faces[0].clone());
        dup.faces[0].face_id = "face_a".into();
        dup.faces[1].face_id = "face_a".into();
        assert!(matches!(
            validate_font_definition(&dup, |_| true),
            Err(Refusal::InvalidFontData { .. })
        ));

        let mut mismatched = base_font();
        mismatched.faces[0].family = "Other".into();
        assert!(matches!(
            validate_font_definition(&mismatched, |_| true),
            Err(Refusal::InvalidFontData { .. })
        ));
    }
}

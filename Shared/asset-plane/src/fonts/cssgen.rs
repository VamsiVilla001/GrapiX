//! Editor/browser stylesheet generation (1.x `buildFontCss`,
//! `buildFontFamilyStack`, `cssFontFamily` in shared-types).
//!
//! File fonts become `@font-face` rules; CSS/Adobe sources stay explicit
//! `@import`s so their licensing and network dependency cannot be mistaken
//! for packaged bytes — 1.x's comment on the function, carried forward
//! because it is the reason the two are emitted differently.

use gx_contracts::font::{is_trusted_font_css_url, FontDefinition, FontFormat, FontSource};

/// Build the stylesheet for a scene's fonts. `resolve_asset_url` maps a
/// packaged asset id to a fetchable URL — the caller owns URL routing.
pub fn build_font_css(
    fonts: &[FontDefinition],
    resolve_asset_url: impl Fn(&str) -> String,
) -> String {
    let mut imports: Vec<String> = Vec::new();
    let mut rules: Vec<String> = Vec::new();

    for font in fonts.iter().filter(|f| f.enabled) {
        for face in &font.faces {
            match &face.source {
                FontSource::CssUrl { url, .. } | FontSource::AdobeFonts { url, .. } => {
                    if is_trusted_font_css_url(url) && !imports.contains(url) {
                        imports.push(format!("@import url(\"{}\");", escape_css_string(url)));
                    }
                }
                FontSource::File {
                    asset_id, format, ..
                } => {
                    rules.push(font_face_rule(
                        &font.family,
                        &resolve_asset_url(asset_id),
                        Some(*format),
                        face,
                    ));
                }
                FontSource::DirectUrl { url, format } => {
                    rules.push(font_face_rule(&font.family, url, *format, face));
                }
            }
        }
    }

    imports.sort();
    let mut parts = imports;
    parts.extend(rules);
    parts.join("\n\n")
}

fn font_face_rule(
    family: &str,
    url: &str,
    format: Option<FontFormat>,
    face: &gx_contracts::font::FontFaceDefinition,
) -> String {
    let format_hint = match format {
        Some(FontFormat::Ttf) => Some("truetype"),
        Some(FontFormat::Otf) => Some("opentype"),
        Some(FontFormat::Woff) => Some("woff"),
        Some(FontFormat::Woff2) => Some("woff2"),
        None => None,
    };
    let mut lines = vec![
        "@font-face {".to_string(),
        format!("  font-family: \"{}\";", escape_css_string(family)),
        match format_hint {
            Some(hint) => format!(
                "  src: url(\"{}\") format(\"{hint}\");",
                escape_css_string(url)
            ),
            None => format!("  src: url(\"{}\");", escape_css_string(url)),
        },
        format!("  font-weight: {};", face.weight),
        format!(
            "  font-style: {};",
            match face.style {
                gx_contracts::font::FontStyle::Normal => "normal",
                gx_contracts::font::FontStyle::Italic => "italic",
                gx_contracts::font::FontStyle::Oblique => "oblique",
            }
        ),
    ];
    if let Some(stretch) = &face.stretch {
        lines.push(format!("  font-stretch: {stretch};"));
    }
    if let Some(range) = &face.unicode_range {
        lines.push(format!("  unicode-range: {range};"));
    }
    lines.push("  font-display: swap;".to_string());
    lines.push("}".to_string());
    lines.join("\n")
}

/// CSS generic families are emitted bare; everything else is quoted.
const GENERIC_FAMILIES: [&str; 11] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "emoji",
    "math",
];

pub fn css_font_family(value: &str) -> String {
    let family = value.trim();
    if GENERIC_FAMILIES
        .iter()
        .any(|g| family.eq_ignore_ascii_case(g))
    {
        family.to_string()
    } else {
        format!("\"{}\"", escape_css_string(family))
    }
}

/// The resolved family stack for a text object: declared family, then
/// object-level fallbacks, then the font's fallbacks — deduped
/// case-insensitively (1.x behaviour).
pub fn build_font_family_stack(
    font: Option<&FontDefinition>,
    legacy_family: &str,
    object_fallbacks: &[String],
) -> String {
    let mut raw: Vec<String> = Vec::new();
    if let Some(font) = font {
        raw.push(font.family.clone());
        raw.extend(object_fallbacks.iter().cloned());
        raw.extend(font.fallback_families.iter().cloned());
    } else {
        raw.push(legacy_family.to_string());
        raw.extend(object_fallbacks.iter().cloned());
    }
    let mut seen = std::collections::HashSet::new();
    raw.iter()
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().trim_matches(['\'', '"']).to_string())
        .filter(|v| !v.is_empty() && seen.insert(v.to_lowercase()))
        .map(|v| css_font_family(&v))
        .collect::<Vec<_>>()
        .join(", ")
}

fn escape_css_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n', '\x0c'], "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::font::*;

    fn file_font() -> FontDefinition {
        FontDefinition {
            font_id: "font_a".into(),
            family: "Inter".into(),
            display_name: "Inter".into(),
            faces: vec![FontFaceDefinition {
                face_id: "face_a".into(),
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
            fallback_families: vec!["Arial".into(), "sans-serif".into()],
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    #[test]
    fn file_fonts_become_font_face_rules() {
        let css = build_font_css(&[file_font()], |id| format!("/api/assets/{id}/content"));
        assert!(css.contains("@font-face"));
        assert!(css.contains("font-family: \"Inter\";"));
        assert!(css.contains("src: url(\"/api/assets/asset_1/content\") format(\"woff2\");"));
        assert!(css.contains("font-display: swap;"));
        assert!(!css.contains("@import"));
    }

    #[test]
    fn linked_fonts_stay_imports_and_untrusted_ones_are_dropped() {
        let mut font = file_font();
        font.faces[0].source = FontSource::CssUrl {
            url: "https://fonts.googleapis.com/css2?family=Inter".into(),
            integrity: None,
        };
        let css = build_font_css(&[font], |_| unreachable!());
        assert!(css.starts_with("@import url(\"https://fonts.googleapis.com/css2?family=Inter\");"));

        let mut evil = file_font();
        evil.faces[0].source = FontSource::CssUrl {
            url: "https://evil.example.com/x.css".into(),
            integrity: None,
        };
        // Untrusted import contributes nothing at all.
        assert!(build_font_css(&[evil], |_| unreachable!()).is_empty());
    }

    #[test]
    fn disabled_fonts_emit_nothing() {
        let mut font = file_font();
        font.enabled = false;
        assert!(build_font_css(&[font], |_| unreachable!()).is_empty());
    }

    #[test]
    fn family_stack_dedupes_case_insensitively_and_quotes() {
        let stack = build_font_family_stack(
            Some(&file_font()),
            "sans-serif",
            &["Helvetica Neue".to_string(), "ARIAL".to_string()],
        );
        // Inter, then object fallback, then the font's own fallbacks; "ARIAL"
        // dedupes against nothing (lowercased key) and keeps its own casing,
        // as 1.x did — dedupe is case-insensitive, display case is preserved.
        assert_eq!(stack, "\"Inter\", \"Helvetica Neue\", \"ARIAL\", sans-serif");
    }
}

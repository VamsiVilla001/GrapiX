//! Editor/browser stylesheet generation (1.x `buildFontCss`,
//! `buildFontFamilyStack`, `cssFontFamily` in shared-types).
//!
//! Every font a template uses is a project file: file faces — including the
//! faces a font link downloaded (`link`), which keep their `original_url` only
//! as provenance — become `@font-face` rules whose `src` is the project-local
//! asset URL. A face that still points at the network (a CSS, Adobe or direct
//! URL source from a scene authored before links were downloaded) emits
//! nothing and is reported by font id: an `@import` of a remote stylesheet
//! would make the template's typeface depend on a CDN at render time, and a
//! silently missing rule would render a substitute.

use gx_contracts::font::{FontDefinition, FontFormat, FontSource};

/// A generated stylesheet and the fonts it could not include.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FontStylesheet {
    pub css: String,
    /// Enabled fonts with a face whose bytes are not in the project, in scene
    /// order. Each is a take blocker until its link is ingested again.
    pub unresolved_font_ids: Vec<String>,
}

/// Build the stylesheet for a scene's fonts. `resolve_asset_url` maps a
/// project asset id to a fetchable URL — the caller owns URL routing.
pub fn build_font_css(
    fonts: &[FontDefinition],
    resolve_asset_url: impl Fn(&str) -> String,
) -> FontStylesheet {
    let mut rules: Vec<String> = Vec::new();
    let mut unresolved_font_ids: Vec<String> = Vec::new();

    for font in fonts.iter().filter(|f| f.enabled) {
        for face in &font.faces {
            match &face.source {
                FontSource::File {
                    asset_id, format, ..
                } => {
                    rules.push(font_face_rule(
                        &font.family,
                        &resolve_asset_url(asset_id),
                        *format,
                        face,
                    ));
                }
                FontSource::CssUrl { .. }
                | FontSource::AdobeFonts { .. }
                | FontSource::DirectUrl { .. } => {
                    if !unresolved_font_ids.contains(&font.font_id) {
                        unresolved_font_ids.push(font.font_id.clone());
                    }
                }
            }
        }
    }

    FontStylesheet {
        css: rules.join("\n\n"),
        unresolved_font_ids,
    }
}

fn font_face_rule(
    family: &str,
    url: &str,
    format: FontFormat,
    face: &gx_contracts::font::FontFaceDefinition,
) -> String {
    let format_hint = match format {
        FontFormat::Ttf => "truetype",
        FontFormat::Otf => "opentype",
        FontFormat::Woff => "woff",
        FontFormat::Woff2 => "woff2",
    };
    let mut lines = vec![
        "@font-face {".to_string(),
        format!("  font-family: \"{}\";", escape_css_string(family)),
        format!(
            "  src: url(\"{}\") format(\"{format_hint}\");",
            escape_css_string(url)
        ),
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
    // `block`, not `swap`: a template must not paint a substitute face while
    // its own bytes load — that frame would be the silent substitution
    // invariant 18 forbids.
    lines.push("  font-display: block;".to_string());
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
        let sheet = build_font_css(&[file_font()], |id| format!("/api/assets/{id}/content"));
        let css = &sheet.css;
        assert!(css.contains("@font-face"));
        assert!(css.contains("font-family: \"Inter\";"));
        assert!(css.contains("src: url(\"/api/assets/asset_1/content\") format(\"woff2\");"));
        assert!(css.contains("font-display: block;"));
        assert!(!css.contains("@import"));
        assert!(sheet.unresolved_font_ids.is_empty());
    }

    #[test]
    fn downloaded_link_faces_load_project_bytes_never_the_cdn() {
        let mut font = file_font();
        font.faces[0].unicode_range = Some("U+0000-00FF".into());
        font.faces[0].source = FontSource::File {
            asset_id: "asset_font_0123".into(),
            format: FontFormat::Woff2,
            original_url: Some("https://fonts.gstatic.com/s/inter/v13/regular.woff2".into()),
            stylesheet_url: Some("https://fonts.googleapis.com/css2?family=Inter".into()),
        };
        let sheet = build_font_css(&[font], |id| format!("asset://{id}"));
        assert!(sheet.css.contains("src: url(\"asset://asset_font_0123\") format(\"woff2\");"));
        assert!(sheet.css.contains("unicode-range: U+0000-00FF;"));
        assert!(!sheet.css.contains("gstatic"));
        assert!(!sheet.css.contains("googleapis"));
    }

    #[test]
    fn remote_sources_emit_nothing_and_are_named_unresolved() {
        let mut google = file_font();
        google.font_id = "font_google".into();
        google.faces[0].source = FontSource::CssUrl {
            url: "https://fonts.googleapis.com/css2?family=Inter".into(),
            integrity: None,
        };
        let mut adobe = file_font();
        adobe.font_id = "font_adobe".into();
        adobe.faces[0].source = FontSource::AdobeFonts {
            project_id: "abc123".into(),
            url: "https://use.typekit.net/abc123.css".into(),
        };
        let sheet = build_font_css(&[google, adobe, file_font()], |id| format!("/a/{id}"));
        assert!(!sheet.css.contains("@import"));
        assert!(!sheet.css.contains("typekit"));
        assert_eq!(sheet.unresolved_font_ids, ["font_google", "font_adobe"]);
    }

    #[test]
    fn disabled_fonts_emit_nothing() {
        let mut font = file_font();
        font.enabled = false;
        assert_eq!(
            build_font_css(&[font], |_| unreachable!()),
            FontStylesheet::default()
        );
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
        assert_eq!(
            stack,
            "\"Inter\", \"Helvetica Neue\", \"ARIAL\", sans-serif"
        );
    }
}

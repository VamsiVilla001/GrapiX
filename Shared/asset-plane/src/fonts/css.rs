//! Inert CSS parsing for font stylesheets (1.x `fonts/cssFontParser.ts`).
//!
//! Parses only the two rules a font importer needs — `@import` and
//! `@font-face` — and only the declarations that matter. The output is data,
//! never re-injected as CSS: an importer that executed the stylesheet it was
//! parsing would be a remote-code surface wearing a font's clothes.

use gx_contracts::font::{FontFormat, FontStyle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFontSource {
    pub url: String,
    pub format: Option<FontFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFontFace {
    pub family: String,
    pub weight: u16,
    pub style: FontStyle,
    pub stretch: Option<String>,
    pub unicode_range: Option<String>,
    pub sources: Vec<ParsedFontSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedFontStylesheet {
    pub imports: Vec<String>,
    pub faces: Vec<ParsedFontFace>,
}

/// Parse a stylesheet. `base_url` resolves relative `url(...)` references the
/// same way 1.x resolved them against the stylesheet's own URL.
pub fn parse_font_stylesheet(css: &str, base_url: &str) -> ParsedFontStylesheet {
    let clean = strip_comments(css);
    let mut out = ParsedFontStylesheet::default();

    for import in find_imports(&clean) {
        if let Some(url) = resolve_url(&import, base_url) {
            if !out.imports.contains(&url) {
                out.imports.push(url);
            }
        }
    }
    for body in find_font_face_bodies(&clean) {
        if let Some(face) = parse_face(&body, base_url) {
            out.faces.push(face);
        }
    }
    out
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = match rest[start + 2..].find("*/") {
            Some(end) => &rest[start + 2 + end + 2..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn find_imports(css: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, _) in css.match_indices("@import") {
        let rest = &css[i + "@import".len()..];
        let rest = rest.trim_start();
        // @import url(...) or @import "..." — up to the terminating ';'.
        let stmt_end = rest.find(';').map(|e| &rest[..e]).unwrap_or(rest);
        let token = stmt_end
            .trim()
            .trim_start_matches("url(")
            .trim_end_matches(')')
            .trim()
            .trim_matches(['"', '\''])
            .split_whitespace() // drop media queries after the URL
            .next()
            .unwrap_or("");
        if !token.is_empty() {
            out.push(token.to_string());
        }
    }
    out
}

fn find_font_face_bodies(css: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = css.to_lowercase();
    let mut search_from = 0;
    while let Some(i) = lower[search_from..].find("@font-face") {
        let after = search_from + i + "@font-face".len();
        let Some(open) = css[after..].find('{') else {
            break;
        };
        let body_start = after + open + 1;
        let Some(close) = css[body_start..].find('}') else {
            break;
        };
        out.push(css[body_start..body_start + close].to_string());
        search_from = body_start + close + 1;
    }
    out
}

fn parse_face(body: &str, base_url: &str) -> Option<ParsedFontFace> {
    let declarations = parse_declarations(body);
    let family = unquote(declarations.get("font-family")?).trim().to_string();
    if family.is_empty() {
        return None;
    }
    let sources = parse_sources(declarations.get("src")?, base_url);
    if sources.is_empty() {
        return None;
    }
    Some(ParsedFontFace {
        family,
        weight: parse_weight(declarations.get("font-weight")),
        style: parse_style(declarations.get("font-style")),
        stretch: declarations
            .get("font-stretch")
            .map(|s| s.trim().to_string()),
        unicode_range: declarations
            .get("unicode-range")
            .map(|s| s.trim().to_string()),
        sources,
    })
}

fn parse_declarations(body: &str) -> std::collections::HashMap<String, String> {
    body.split(';')
        .filter_map(|decl| {
            let (name, value) = decl.split_once(':')?;
            Some((name.trim().to_lowercase(), value.trim().to_string()))
        })
        .collect()
}

/// Parse the `src:` list: comma-separated `url(...) format(...)` candidates.
fn parse_sources(src: &str, base_url: &str) -> Vec<ParsedFontSource> {
    src.split(',')
        .filter_map(|candidate| {
            let candidate = candidate.trim();
            let url_start = candidate.find("url(")? + 4;
            let url_end = candidate[url_start..].find(')')? + url_start;
            let url = unquote(&candidate[url_start..url_end]).trim().to_string();
            let url = resolve_url(&url, base_url)?;
            let format = candidate[url_end..]
                .find("format(")
                .map(|f| {
                    let inner = &candidate[url_end + f + 7..];
                    let end = inner.find(')').unwrap_or(inner.len());
                    unquote(&inner[..end]).trim().to_lowercase()
                })
                .and_then(|f| match f.as_str() {
                    "woff2" => Some(FontFormat::Woff2),
                    "woff" => Some(FontFormat::Woff),
                    "opentype" | "otf" => Some(FontFormat::Otf),
                    "truetype" | "ttf" => Some(FontFormat::Ttf),
                    _ => None,
                });
            Some(ParsedFontSource { url, format })
        })
        .collect()
}

fn parse_weight(value: Option<&String>) -> u16 {
    value
        .and_then(|v| v.trim().parse::<u16>().ok())
        .map(|w| w.clamp(1, 1000))
        .unwrap_or(400)
}

fn parse_style(value: Option<&String>) -> FontStyle {
    match value.map(|v| v.trim().to_lowercase()).as_deref() {
        Some("italic") => FontStyle::Italic,
        Some("oblique") => FontStyle::Oblique,
        _ => FontStyle::Normal,
    }
}

fn unquote(value: &str) -> &str {
    value.trim().trim_matches(['"', '\''])
}

/// Resolve a possibly-relative reference against the stylesheet URL. A
/// reference that cannot be resolved is dropped — a partial face list with a
/// warning beats a guessed URL.
fn resolve_url(reference: &str, base_url: &str) -> Option<String> {
    if let Ok(url) = url::Url::parse(reference) {
        return Some(url.to_string());
    }
    url::Url::parse(base_url)
        .and_then(|base| base.join(reference))
        .ok()
        .map(|u| u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE: &str = r#"
        /* a comment with a fake @font-face { src: url(evil) } */
        @font-face {
          font-family: 'Inter';
          font-style: normal;
          font-weight: 400;
          font-display: swap;
          src: url(https://fonts.gstatic.com/s/inter/v13/regular.woff2) format('woff2');
        }
        @font-face {
          font-family: 'Inter';
          font-style: italic;
          font-weight: 700;
          src: url(https://fonts.gstatic.com/s/inter/v13/bold-italic.woff2) format('woff2'),
               url(https://fonts.gstatic.com/s/inter/v13/bold-italic.woff) format('woff');
        }
    "#;

    #[test]
    fn google_stylesheet_parses_faces_and_sources() {
        let parsed =
            parse_font_stylesheet(GOOGLE, "https://fonts.googleapis.com/css2?family=Inter");
        assert_eq!(parsed.faces.len(), 2);
        assert_eq!(parsed.faces[0].family, "Inter");
        assert_eq!(parsed.faces[0].weight, 400);
        assert_eq!(parsed.faces[0].style, FontStyle::Normal);
        assert_eq!(parsed.faces[0].sources[0].format, Some(FontFormat::Woff2));
        // The second face carries both candidates; the resolver prefers woff2.
        assert_eq!(parsed.faces[1].sources.len(), 2);
        assert_eq!(parsed.faces[1].weight, 700);
        assert_eq!(parsed.faces[1].style, FontStyle::Italic);
        // The comment's fake @font-face produced nothing.
        assert!(!parsed
            .faces
            .iter()
            .any(|f| f.sources.iter().any(|s| s.url.contains("evil"))));
    }

    #[test]
    fn imports_are_collected_once_and_resolved() {
        let css = r#"
            @import url("https://fonts.googleapis.com/css2?family=A");
            @import 'css/relative.css';
            @import url("https://fonts.googleapis.com/css2?family=A");
        "#;
        let parsed = parse_font_stylesheet(css, "https://example.com/fonts/main.css");
        assert_eq!(
            parsed.imports,
            vec![
                "https://fonts.googleapis.com/css2?family=A".to_string(),
                "https://example.com/fonts/css/relative.css".to_string()
            ]
        );
    }

    #[test]
    fn a_face_without_family_or_sources_is_skipped() {
        let css = r#"
            @font-face { src: url(x.woff2); }
            @font-face { font-family: "NoSrc"; }
        "#;
        let parsed = parse_font_stylesheet(css, "https://example.com/");
        assert!(parsed.faces.is_empty());
    }

    #[test]
    fn relative_face_urls_resolve_against_the_stylesheet() {
        let css = r#"@font-face { font-family: X; src: url(../fonts/x.woff2) format("woff2"); }"#;
        let parsed = parse_font_stylesheet(css, "https://example.com/css/main.css");
        assert_eq!(
            parsed.faces[0].sources[0].url,
            "https://example.com/fonts/x.woff2"
        );
    }
}

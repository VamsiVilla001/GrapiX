//! Definition construction and identity (1.x `fontManager.ts`).
//!
//! Identity is content-derived, as in 1.x: a file font's id is a prefix of
//! its content hash, a linked font's is a hash of (source kind, URL, family,
//! weight). Two imports of the same bytes or the same reference yield the
//! same id — dedupe falls out of the identity scheme rather than a registry
//! pass.

use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
    FontStyle,
};
use gx_contracts::Refusal;
use sha2::{Digest, Sha256};

/// Options for a packaged (file) font face.
#[derive(Debug, Clone)]
pub struct FileFontOptions {
    pub family: String,
    pub display_name: Option<String>,
    pub weight: u16,
    pub style: FontStyle,
    pub fallback_families: Vec<String>,
    /// The declared licence. `Package` policy without one is refused at
    /// preflight (p2-licensing-positions §5); recording it here is how the
    /// package stays self-describing.
    pub license: Option<String>,
}

impl Default for FileFontOptions {
    fn default() -> Self {
        Self {
            family: String::new(),
            display_name: None,
            weight: 400,
            style: FontStyle::Normal,
            fallback_families: Vec::new(),
            license: None,
        }
    }
}

/// Build a definition for a font whose bytes are a packaged asset.
/// `content_hash` is the asset's SHA-256 hex — the identity source.
pub fn create_file_font_definition(
    asset_id: &str,
    content_hash: &str,
    format: FontFormat,
    options: &FileFontOptions,
) -> Result<FontDefinition, Refusal> {
    let family = normalize_family(&options.family)?;
    let identity: String = content_hash.chars().take(16).collect();
    Ok(FontDefinition {
        font_id: format!("font_{identity}"),
        family: family.clone(),
        display_name: options
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&family)
            .to_string(),
        faces: vec![FontFaceDefinition {
            face_id: format!("face_{identity}"),
            family: family.clone(),
            weight: normalize_weight(options.weight)?,
            style: options.style,
            stretch: None,
            unicode_range: None,
            source: FontSource::File {
                asset_id: asset_id.to_string(),
                format,
                original_url: None,
                stylesheet_url: None,
            },
            status: None,
            error_message: None,
        }],
        fallback_families: normalize_fallbacks(&options.fallback_families),
        embedding_policy: EmbeddingPolicy::Package,
        license: options.license.clone(),
        enabled: true,
        source_label: None,
        status: FontLoadStatus::Ready,
        error_message: None,
    })
}

/// A linked (non-packaged) source request.
#[derive(Debug, Clone)]
pub struct LinkedFontRequest {
    pub family: String,
    pub display_name: Option<String>,
    pub weight: u16,
    pub style: FontStyle,
    pub source: LinkedSource,
    pub license: Option<String>,
}

#[derive(Debug, Clone)]
pub enum LinkedSource {
    /// A CSS stylesheet on a trusted host.
    CssUrl {
        url: String,
        integrity: Option<String>,
    },
    /// An Adobe Fonts project id (3–32 alphanumerics, as in 1.x).
    AdobeFonts { project_id: String },
}

/// Build a definition for a linked font. The source is validated at
/// construction — an Adobe URL is canonicalised to `use.typekit.net`, a CSS
/// URL must pass the trusted-host check — so a bad source cannot exist in a
/// stored scene.
pub fn create_linked_font_definition(
    request: &LinkedFontRequest,
) -> Result<FontDefinition, Refusal> {
    let family = normalize_family(&request.family)?;
    let source = linked_source(&request.source)?;
    let (kind, url) = match &source {
        FontSource::CssUrl { url, .. } => ("css-url", url.clone()),
        FontSource::AdobeFonts { url, .. } => ("adobe-fonts", url.clone()),
        _ => unreachable!("linked_source only builds css-url and adobe-fonts"),
    };
    let identity = short_hash(&format!(
        "{kind}:{url}:{family}:{}",
        normalize_weight(request.weight)?
    ));
    Ok(FontDefinition {
        font_id: format!("font_{identity}"),
        family: family.clone(),
        display_name: request
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&family)
            .to_string(),
        faces: vec![FontFaceDefinition {
            face_id: format!("face_{identity}"),
            family,
            weight: normalize_weight(request.weight)?,
            style: request.style,
            stretch: None,
            unicode_range: None,
            source,
            status: None,
            error_message: None,
        }],
        fallback_families: normalize_fallbacks(&[]),
        // Linked fonts resolve at the render node; bytes never travel in the
        // package (p2-licensing-positions §5).
        embedding_policy: EmbeddingPolicy::Reference,
        license: request.license.clone(),
        enabled: true,
        source_label: None,
        status: FontLoadStatus::Unverified,
        error_message: None,
    })
}

fn linked_source(source: &LinkedSource) -> Result<FontSource, Refusal> {
    match source {
        LinkedSource::AdobeFonts { project_id } => {
            let id = project_id.trim();
            let valid = !id.is_empty()
                && id.len() <= 32
                && id.len() >= 3
                && id.chars().all(|c| c.is_ascii_alphanumeric());
            if !valid {
                return Err(Refusal::InvalidFontUrl {
                    url: format!("adobe fonts project id: {id}"),
                });
            }
            Ok(FontSource::AdobeFonts {
                project_id: id.to_string(),
                url: format!("https://use.typekit.net/{id}.css"),
            })
        }
        LinkedSource::CssUrl { url, integrity } => {
            let url = url.trim().to_string();
            if !gx_contracts::font::is_trusted_font_css_url(&url) {
                // Name the actual offence where we can.
                return Err(match url::Url::parse(&url) {
                    Ok(u) if u.scheme() != "https" => Refusal::FontUrlNotHttps { url },
                    Ok(u) if !u.username().is_empty() || u.password().is_some() => {
                        Refusal::FontUrlHasCredentials { url }
                    }
                    _ => Refusal::InvalidFontUrl { url },
                });
            }
            Ok(FontSource::CssUrl {
                url,
                integrity: integrity
                    .as_deref()
                    .map(str::trim)
                    .map(str::to_string)
                    .filter(|s| !s.is_empty()),
            })
        }
    }
}

fn normalize_family(value: &str) -> Result<String, Refusal> {
    let family: String = value
        .replace(['\r', '\n', '\x0c'], "")
        .trim()
        .chars()
        .take(128)
        .collect();
    if family.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: "font family must contain 1 to 128 characters".into(),
        });
    }
    Ok(family)
}

fn normalize_weight(weight: u16) -> Result<u16, Refusal> {
    if !(1..=1000).contains(&weight) {
        return Err(Refusal::InvalidFontData {
            detail: format!("font weight must be 1 to 1000, got {weight}"),
        });
    }
    Ok(weight)
}

/// 1.x default: Arial, sans-serif. Deduped, capped at 8.
fn normalize_fallbacks(values: &[String]) -> Vec<String> {
    let cleaned: Vec<String> = if values.is_empty() {
        vec!["Arial".into(), "sans-serif".into()]
    } else {
        values
            .iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect()
    };
    let mut seen = std::collections::HashSet::new();
    cleaned
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .take(8)
        .collect()
}

fn short_hash(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_font_identity_is_content_derived_and_stable() {
        let opts = FileFontOptions {
            family: "Inter".into(),
            ..Default::default()
        };
        let a = create_file_font_definition(
            "asset_1",
            "0123456789abcdef0123456789abcdef",
            FontFormat::Woff2,
            &opts,
        )
        .unwrap();
        let b = create_file_font_definition(
            "asset_2",
            "0123456789abcdef0123456789abcdef",
            FontFormat::Woff2,
            &opts,
        )
        .unwrap();
        // Same bytes → same font id, whatever the asset id is.
        assert_eq!(a.font_id, b.font_id);
        assert_eq!(a.font_id, "font_0123456789abcdef");
        assert_eq!(a.embedding_policy, EmbeddingPolicy::Package);
        assert_eq!(a.status, FontLoadStatus::Ready);
    }

    #[test]
    fn adobe_source_is_canonicalised_to_typekit() {
        let req = LinkedFontRequest {
            family: "Proxima Nova".into(),
            display_name: None,
            weight: 400,
            style: FontStyle::Normal,
            source: LinkedSource::AdobeFonts {
                project_id: "abc123".into(),
            },
            license: None,
        };
        let font = create_linked_font_definition(&req).unwrap();
        assert_eq!(
            font.faces[0].source,
            FontSource::AdobeFonts {
                project_id: "abc123".into(),
                url: "https://use.typekit.net/abc123.css".into()
            }
        );
        assert_eq!(font.embedding_policy, EmbeddingPolicy::Reference);
        assert_eq!(font.status, FontLoadStatus::Unverified);
    }

    #[test]
    fn bad_sources_are_refused_by_name() {
        let css_req = |url: &str| LinkedFontRequest {
            family: "X".into(),
            display_name: None,
            weight: 400,
            style: FontStyle::Normal,
            source: LinkedSource::CssUrl {
                url: url.into(),
                integrity: None,
            },
            license: None,
        };
        assert!(matches!(
            create_linked_font_definition(&css_req("http://fonts.googleapis.com/css")),
            Err(Refusal::FontUrlNotHttps { .. })
        ));
        assert!(matches!(
            create_linked_font_definition(&css_req("https://fonts.example.com/css")),
            Err(Refusal::InvalidFontUrl { .. })
        ));
        let bad_adobe = LinkedFontRequest {
            family: "X".into(),
            display_name: None,
            weight: 400,
            style: FontStyle::Normal,
            source: LinkedSource::AdobeFonts {
                project_id: "has spaces!".into(),
            },
            license: None,
        };
        assert!(matches!(
            create_linked_font_definition(&bad_adobe),
            Err(Refusal::InvalidFontUrl { .. })
        ));
    }

    #[test]
    fn family_and_weight_limits_are_enforced() {
        let opts = FileFontOptions {
            family: "   ".into(),
            ..Default::default()
        };
        assert!(matches!(
            create_file_font_definition("a", "0123456789abcdef", FontFormat::Ttf, &opts),
            Err(Refusal::InvalidFontData { .. })
        ));
        let opts = FileFontOptions {
            family: "X".into(),
            weight: 0,
            ..Default::default()
        };
        assert!(matches!(
            create_file_font_definition("a", "0123456789abcdef", FontFormat::Ttf, &opts),
            Err(Refusal::InvalidFontData { .. })
        ));
    }
}

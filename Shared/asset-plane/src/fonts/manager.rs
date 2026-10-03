//! Definition construction and identity (1.x `fontManager.ts`).
//!
//! Identity is content-derived, as in 1.x: a file font's id is a prefix of
//! its content hash. Two imports of the same bytes yield the same id — dedupe
//! falls out of the identity scheme rather than a registry pass. A font link
//! is no longer stored as a reference: `link` downloads its faces into the
//! project, and this module only canonicalises the link it starts from.

use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
    FontStyle,
};
use gx_contracts::Refusal;
use sha2::{Digest, Sha256};

/// Options for a file font face (bytes held as a project asset).
#[derive(Debug, Clone)]
pub struct FileFontOptions {
    pub family: String,
    pub display_name: Option<String>,
    pub weight: u16,
    pub style: FontStyle,
    pub fallback_families: Vec<String>,
    /// May the bytes travel inside a package? Chosen by whoever ingests the
    /// file; a font file says nothing reliable about redistribution rights.
    pub embedding_policy: EmbeddingPolicy,
    /// The declared licence. `Package` policy without one is refused here and
    /// again at preflight (p2-licensing-positions §5); recording it is how the
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
            // Unstated licence ⇒ restricted (p2-licensing-positions §5): the
            // safe default is the one that never lets bytes leave the machine.
            embedding_policy: EmbeddingPolicy::Restricted,
            license: None,
        }
    }
}

/// Build a definition for a font whose bytes are a project asset.
/// `content_hash` is the asset's SHA-256 hex — the identity source. Whether
/// the bytes may be packaged is `options.embedding_policy`, never assumed.
pub fn create_file_font_definition(
    asset_id: &str,
    content_hash: &str,
    format: FontFormat,
    options: &FileFontOptions,
) -> Result<FontDefinition, Refusal> {
    let family = normalize_family(&options.family)?;
    let identity: String = content_hash.chars().take(16).collect();
    let font_id = format!("font_{identity}");
    let license = options
        .license
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    match options.embedding_policy {
        EmbeddingPolicy::Package if license.is_none() => {
            return Err(Refusal::FontEmbeddingRefused { font_id });
        }
        EmbeddingPolicy::Reference => {
            return Err(Refusal::InvalidFontData {
                detail: format!(
                    "{font_id}: a font file cannot use the reference policy — its bytes are local, \
                     so no render node could resolve it; choose package or restricted"
                ),
            });
        }
        _ => {}
    }
    Ok(FontDefinition {
        font_id,
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
        embedding_policy: options.embedding_policy,
        license,
        enabled: true,
        source_label: None,
        status: FontLoadStatus::Ready,
        error_message: None,
    })
}

/// A font link as an author supplies it, before canonicalisation.
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

/// Canonicalise and check a link. An Adobe id becomes its
/// `use.typekit.net` kit URL; a CSS URL must pass the trusted-host check.
/// The offence is named where it can be: a bad link never reaches a fetch.
pub fn canonical_link_source(source: &LinkedSource) -> Result<FontSource, Refusal> {
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

pub(crate) fn normalize_family(value: &str) -> Result<String, Refusal> {
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

pub(crate) fn normalize_weight(weight: u16) -> Result<u16, Refusal> {
    if !(1..=1000).contains(&weight) {
        return Err(Refusal::InvalidFontData {
            detail: format!("font weight must be 1 to 1000, got {weight}"),
        });
    }
    Ok(weight)
}

/// 1.x default: Arial, sans-serif. Deduped, capped at 8.
pub(crate) fn normalize_fallbacks(values: &[String]) -> Vec<String> {
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

pub(crate) fn short_hash(input: &str) -> String {
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
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
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
        assert_eq!(a.license.as_deref(), Some("OFL-1.1"));
        assert_eq!(a.status, FontLoadStatus::Ready);
    }

    #[test]
    fn embedding_policy_is_explicit_and_never_assumed() {
        let hash = "0123456789abcdef0123456789abcdef";
        let base = FileFontOptions {
            family: "Inter".into(),
            ..Default::default()
        };
        // Nothing stated: restricted, not packaged.
        let font = create_file_font_definition("a", hash, FontFormat::Ttf, &base).unwrap();
        assert_eq!(font.embedding_policy, EmbeddingPolicy::Restricted);
        assert_eq!(font.license, None);
        // Package without a licence (blank counts as none) is refused by font.
        let package = FileFontOptions {
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("   ".into()),
            ..base.clone()
        };
        assert_eq!(
            create_file_font_definition("a", hash, FontFormat::Ttf, &package),
            Err(Refusal::FontEmbeddingRefused {
                font_id: "font_0123456789abcdef".into()
            })
        );
        // A local file has nothing a render node could resolve by reference.
        let reference = FileFontOptions {
            embedding_policy: EmbeddingPolicy::Reference,
            license: Some("OFL-1.1".into()),
            ..base
        };
        assert!(matches!(
            create_file_font_definition("a", hash, FontFormat::Ttf, &reference),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("reference policy")
        ));
    }

    #[test]
    fn adobe_link_is_canonicalised_to_its_typekit_kit() {
        let source = canonical_link_source(&LinkedSource::AdobeFonts {
            project_id: " abc123 ".into(),
        })
        .unwrap();
        assert_eq!(
            source,
            FontSource::AdobeFonts {
                project_id: "abc123".into(),
                url: "https://use.typekit.net/abc123.css".into()
            }
        );
    }

    #[test]
    fn bad_links_are_refused_by_name() {
        let css = |url: &str| LinkedSource::CssUrl {
            url: url.into(),
            integrity: None,
        };
        assert!(matches!(
            canonical_link_source(&css("http://fonts.googleapis.com/css")),
            Err(Refusal::FontUrlNotHttps { .. })
        ));
        assert!(matches!(
            canonical_link_source(&css("https://fonts.example.com/css")),
            Err(Refusal::InvalidFontUrl { .. })
        ));
        assert!(matches!(
            canonical_link_source(&LinkedSource::AdobeFonts {
                project_id: "has spaces!".into(),
            }),
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

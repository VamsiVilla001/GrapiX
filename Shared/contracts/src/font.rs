//! Font contracts, ported from the 1.x font system (ADR-0002 A.4: carried
//! forward unchanged; 2.0 must not redesign it).
//!
//! The model answers three questions without any platform code:
//!
//! - **Where do the bytes live?** `FontSource` — a packaged asset, a CSS
//!   stylesheet, an Adobe Fonts project, or a direct URL. Only `File` sources
//!   carry bytes inside a package.
//! - **May the bytes travel?** `EmbeddingPolicy` — the licensing decision
//!   from `docs/p2-licensing-positions.md` §5 made per font: `Package`,
//!   `Reference` (resolved at the render node), `Restricted` (workstation
//!   only, never leaves it — the Adobe Fonts class).
//! - **Is it usable?** `FontLoadStatus` — and `MISSING` at preflight is a
//!   refusal, never a substitution (A.4's one rule: nothing that reaches air
//!   may depend on a system-installed font, and both platforms will happily
//!   substitute something plausible if allowed to).
//!
//! Trusted CSS hosts and URL hygiene live here rather than in a service so
//! that the validator, the Editor and the MCP surface apply one rule
//! (invariant 27): `is_trusted_font_css_url` is the single allowlist, and
//! `check_font_face_url` is the single HTTPS/credentials/host check.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Font container formats the pipeline accepts. WOFF/WOFF2 are delivery
/// wrappers; the shaper sees the same tables either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum FontFormat {
    Otf,
    Ttf,
    Woff,
    Woff2,
}

/// Whether a font's bytes may travel inside a `.gpxpkg` — the licensing
/// decision made per font (docs/p2-licensing-positions.md §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum EmbeddingPolicy {
    /// Bytes may be packaged (licence permits redistribution: OFL, Apache…).
    Package,
    /// Package carries the reference; the render node resolves and caches.
    Reference,
    /// Workstation-only; bytes never leave the operator's machine.
    Restricted,
}

/// Load state of a font or face. `Missing` at preflight is a refusal
/// (`Refusal::FontMissing`), never a fallback to a system font.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FontLoadStatus {
    Loading,
    Ready,
    Missing,
    Invalid,
    Unsupported,
    /// Linked source declared but not yet resolved; cannot preflight.
    Unverified,
    Error,
}

/// Where a face's bytes come from.
///
/// `rename_all_fields` (not `rename_all`) because the variant *fields* are
/// what hit the wire: `rename_all` alone would leave `asset_id` snake_case
/// while every other contract is camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FontSource {
    /// Packaged asset bytes, content-addressed.
    File {
        asset_id: String,
        format: FontFormat,
        /// Original public URL when this face was resolved and cached from CSS.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        original_url: Option<String>,
        /// Stylesheet that declared this cached face.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stylesheet_url: Option<String>,
    },
    /// A CSS stylesheet declaring `@font-face` rules (Google Fonts class).
    CssUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        integrity: Option<String>,
    },
    /// An Adobe Fonts project. Reference-only by licence; never packaged.
    AdobeFonts { project_id: String, url: String },
    /// A direct HTTPS font file URL.
    DirectUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        format: Option<FontFormat>,
    },
}

impl FontSource {
    /// The URL a non-file source points at.
    pub fn url(&self) -> Option<&str> {
        match self {
            FontSource::File { .. } => None,
            FontSource::CssUrl { url, .. } => Some(url),
            FontSource::AdobeFonts { url, .. } => Some(url),
            FontSource::DirectUrl { url, .. } => Some(url),
        }
    }
}

/// One face of a family: weight/style/stretch with a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FontFaceDefinition {
    pub face_id: String,
    pub family: String,
    /// CSS weight scale, 1–1000.
    pub weight: u16,
    pub style: FontStyle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stretch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unicode_range: Option<String>,
    pub source: FontSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<FontLoadStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

/// A family as the scene knows it: its faces, fallbacks and licensing
/// posture. Embedded verbatim in the scene document, so a package is
/// self-describing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FontDefinition {
    pub font_id: String,
    pub family: String,
    pub display_name: String,
    pub faces: Vec<FontFaceDefinition>,
    pub fallback_families: Vec<String>,
    pub embedding_policy: EmbeddingPolicy,
    /// The declared licence. A `Package` font without one is a preflight
    /// refusal (p2-licensing-positions §5: unstated licence ⇒ restricted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub license: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_label: Option<String>,
    pub status: FontLoadStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_message: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// The hosts a stylesheet URL may point at (1.x allowlist, carried forward).
/// Bunny Fonts is the GDPR-safe Google Fonts mirror; both serve OFL/Apache
/// fonts. Adobe Fonts is `use.typekit.net`, the only host Adobe serves from.
pub const TRUSTED_FONT_CSS_HOSTS: [&str; 3] = [
    "use.typekit.net",
    "fonts.googleapis.com",
    "fonts.bunny.net",
];

/// The single allowlist check (invariant 27). HTTPS, a trusted host, no
/// credentials. Case-insensitive on the host, like DNS.
pub fn is_trusted_font_css_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| TRUSTED_FONT_CSS_HOSTS.iter().any(|t| h.eq_ignore_ascii_case(t)))
}

/// The URL hygiene every non-file face must pass: HTTPS, no credentials,
/// and Adobe Fonts faces only ever point at `use.typekit.net`. Returns the
/// offending condition by name, since the caller's job is to refuse by name.
pub fn check_font_face_url(source: &FontSource) -> Result<(), crate::Refusal> {
    let (url, is_adobe) = match source {
        FontSource::File { .. } => return Ok(()),
        FontSource::CssUrl { url, .. } => (url, false),
        FontSource::AdobeFonts { url, .. } => (url, true),
        FontSource::DirectUrl { url, .. } => (url, false),
    };
    let parsed = url::Url::parse(url)
        .map_err(|_| crate::Refusal::InvalidFontUrl { url: url.clone() })?;
    if parsed.scheme() != "https" {
        return Err(crate::Refusal::FontUrlNotHttps { url: url.clone() });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(crate::Refusal::FontUrlHasCredentials { url: url.clone() });
    }
    if is_adobe && !parsed.host_str().is_some_and(|h| h.eq_ignore_ascii_case("use.typekit.net")) {
        return Err(crate::Refusal::InvalidFontUrl { url: url.clone() });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_hosts_are_exactly_the_1x_allowlist() {
        assert!(is_trusted_font_css_url("https://use.typekit.net/abc123.css"));
        assert!(is_trusted_font_css_url(
            "https://fonts.googleapis.com/css2?family=Inter"
        ));
        assert!(is_trusted_font_css_url("https://fonts.bunny.net/css?family=Inter"));
        assert!(is_trusted_font_css_url("https://FONTS.GOOGLEAPIS.COM/css?family=Inter"));
    }

    #[test]
    fn untrusted_sources_are_refused_by_name() {
        // HTTP, credentials, unknown hosts, garbage: all rejected.
        assert!(!is_trusted_font_css_url("http://fonts.googleapis.com/css?family=Inter"));
        assert!(!is_trusted_font_css_url(
            "https://user:pw@fonts.googleapis.com/css?family=Inter"
        ));
        assert!(!is_trusted_font_css_url("https://fonts.example.com/css?family=Inter"));
        assert!(!is_trusted_font_css_url("not a url"));
    }

    #[test]
    fn face_url_hygiene_names_each_offence() {
        let css = |url: &str| FontSource::CssUrl {
            url: url.into(),
            integrity: None,
        };
        assert!(check_font_face_url(&css("https://fonts.googleapis.com/css")).is_ok());
        assert!(matches!(
            check_font_face_url(&css("http://fonts.googleapis.com/css")),
            Err(crate::Refusal::FontUrlNotHttps { .. })
        ));
        assert!(matches!(
            check_font_face_url(&css("https://user@fonts.googleapis.com/css")),
            Err(crate::Refusal::FontUrlHasCredentials { .. })
        ));
        // Adobe faces only ever point at Adobe's host.
        let adobe = FontSource::AdobeFonts {
            project_id: "abc123".into(),
            url: "https://evil.example.com/abc123.css".into(),
        };
        assert!(matches!(
            check_font_face_url(&adobe),
            Err(crate::Refusal::InvalidFontUrl { .. })
        ));
    }

    #[test]
    fn a_font_definition_round_trips_with_omitted_optionals() {
        let font = FontDefinition {
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
                source: FontSource::CssUrl {
                    url: "https://fonts.googleapis.com/css2?family=Inter".into(),
                    integrity: None,
                },
                status: None,
                error_message: None,
            }],
            fallback_families: vec!["Arial".into(), "sans-serif".into()],
            embedding_policy: EmbeddingPolicy::Reference,
            license: None,
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Unverified,
            error_message: None,
        };
        let v = serde_json::to_value(&font).unwrap();
        // Omitted, not null: the wire shape the TS type declares optional.
        assert!(v.get("license").is_none());
        assert!(v.get("sourceLabel").is_none());
        assert!(v["faces"][0].get("stretch").is_none());
        assert_eq!(v["embeddingPolicy"], "reference");
        let back: FontDefinition = serde_json::from_value(v).unwrap();
        assert_eq!(back, font);
    }
}

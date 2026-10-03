//! Font link ingest: a Google Fonts, Bunny Fonts or Adobe Fonts link is
//! downloaded into the project (11.13; user decision of 2026-10-03).
//!
//! The stylesheet is fetched from its trusted host, parsed inertly by
//! `css::parse_font_stylesheet`, and every face's file is downloaded from the
//! provider's own CDN — Google's from `fonts.gstatic.com`, Bunny's from
//! `fonts.bunny.net`, Adobe's from `use.typekit.net` — over HTTPS, without
//! credentials, within a byte ceiling, with every redirect hop re-checked.
//! Each file is verified (magic, WOFF/WOFF2 decode, inspection) before any
//! byte is cached, and the result is a `PreparedFontBatch` of `File` faces
//! that keep their `original_url` and `stylesheet_url`. The scene never holds
//! a remote reference for the stylesheet generator to `@import`, so templates
//! and the Editor load project-local bytes only.
//!
//! **All or nothing per link.** A failed fetch, a refused host, a file that
//! does not verify, or a face with no licence refuses the whole link by name;
//! no partial family reaches the scene, and nothing silently stays a
//! reference.
//!
//! **Licence.** Packaged bytes need a recorded licence: the one the font's
//! naming table states (nameID 13/14). Google and Bunny faces without one are
//! refused (`FontEmbeddingRefused`). Adobe faces without one record the
//! project owner's written acceptance, `ADOBE_FONTS_PACKAGING_LICENCE` — the
//! recorded position, not a guess about Adobe's terms.
//!
//! The network sits behind `FontFetcher` so policy is tested offline;
//! `UreqFontFetcher` is the real transport.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
};
use gx_contracts::scene::AssetLibraryItem;
use gx_contracts::{ContentHash, Refusal};
use sha2::{Digest, Sha256, Sha384, Sha512};

use super::container::{verify_font_file, VerifiedFontFile};
use super::css::{parse_font_stylesheet, ParsedFontFace, ParsedFontSource};
use super::ingest::{
    font_asset_item, store_font_asset, BatchBuilder, FontIngestRefusal, PreparedFontBatch,
    SceneFontLibrary,
};
use super::manager::{
    canonical_link_source, normalize_fallbacks, normalize_family, normalize_weight, short_hash,
    LinkedSource,
};
use crate::store::{content_hash, AssetStore};

/// Ceiling for one stylesheet response.
pub const MAX_STYLESHEET_BYTES: usize = 1024 * 1024;
/// Ceiling for one font file response.
pub const MAX_FONT_FILE_BYTES: usize = 16 * 1024 * 1024;
/// Ceiling for every font file one link downloads, together.
pub const MAX_LINK_BYTES: usize = 128 * 1024 * 1024;
/// How deep a stylesheet `@import` chain may go below the link itself.
pub const MAX_STYLESHEET_IMPORT_DEPTH: u8 = 4;
/// Redirect hops followed per request; each hop passes the host check again.
pub const MAX_REDIRECTS: usize = 5;
/// The licence recorded for an Adobe Fonts face whose naming table states
/// none: the project owner's written acceptance of packaging Adobe fonts.
pub const ADOBE_FONTS_PACKAGING_LICENCE: &str =
    "Adobe Fonts — packaging accepted by project owner 2026-10-03";

/// One HTTP exchange, without redirect following: policy follows redirects
/// so it can check every hop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchedResponse {
    Body(Vec<u8>),
    Redirect { location: String },
}

/// The transport a link ingest uses. Implementations perform exactly one GET,
/// never follow redirects, and refuse a body over `limit_bytes`.
pub trait FontFetcher {
    fn get(&self, url: &str, limit_bytes: usize) -> Result<FetchedResponse, Refusal>;
}

/// Desktop-browser user agent: Google Fonts serves WOFF2 only to clients it
/// recognises as supporting it, and WOFF2 is the preferred download.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// The real transport: HTTPS only, no automatic redirects, bounded bodies.
pub struct UreqFontFetcher {
    agent: ureq::Agent,
}

impl UreqFontFetcher {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent(BROWSER_USER_AGENT)
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl Default for UreqFontFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl FontFetcher for UreqFontFetcher {
    fn get(&self, url: &str, limit_bytes: usize) -> Result<FetchedResponse, Refusal> {
        let failed = |detail: String| Refusal::FontFetchFailed {
            url: url.to_string(),
            detail,
        };
        let mut response = self
            .agent
            .get(url)
            .call()
            .map_err(|error| failed(error.to_string()))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| failed(format!("HTTP {} without a Location", status.as_u16())))?;
            return Ok(FetchedResponse::Redirect {
                location: location.to_string(),
            });
        }
        if !status.is_success() {
            return Err(failed(format!("HTTP {}", status.as_u16())));
        }
        response
            .body_mut()
            .with_config()
            .limit(limit_bytes as u64)
            .read_to_vec()
            .map(FetchedResponse::Body)
            .map_err(|error| match error {
                ureq::Error::BodyExceedsLimit(_) => Refusal::FontFetchTooLarge {
                    url: url.to_string(),
                    limit_bytes,
                },
                other => failed(other.to_string()),
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Google,
    Bunny,
    Adobe,
}

impl Provider {
    fn of(stylesheet: &str) -> Option<Self> {
        let host = url::Url::parse(stylesheet).ok()?.host_str()?.to_ascii_lowercase();
        match host.as_str() {
            "fonts.googleapis.com" => Some(Self::Google),
            "fonts.bunny.net" => Some(Self::Bunny),
            "use.typekit.net" => Some(Self::Adobe),
            _ => None,
        }
    }

    fn stylesheet_hosts(self) -> &'static [&'static str] {
        match self {
            Self::Google => &["fonts.googleapis.com"],
            Self::Bunny => &["fonts.bunny.net"],
            Self::Adobe => &["use.typekit.net"],
        }
    }

    fn font_hosts(self) -> &'static [&'static str] {
        match self {
            Self::Google => &["fonts.gstatic.com"],
            Self::Bunny => &["fonts.bunny.net"],
            Self::Adobe => &["use.typekit.net"],
        }
    }

    /// Imports that are not stylesheets of fonts: Adobe's `p.typekit.net`
    /// page-view tracker. Skipped, never fetched.
    fn ignores_import(self, url: &str) -> bool {
        self == Self::Adobe
            && url::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
                .is_some_and(|host| host == "p.typekit.net")
    }

    fn fallback_licence(self) -> Option<&'static str> {
        match self {
            Self::Adobe => Some(ADOBE_FONTS_PACKAGING_LICENCE),
            Self::Google | Self::Bunny => None,
        }
    }
}

/// Download a font link into the project and define its families.
///
/// Returns only what the scene lacks; a link ingested before returns its
/// families as `AlreadyInScene` with the same ids.
pub fn prepare_font_link(
    store: &mut AssetStore,
    fetcher: &dyn FontFetcher,
    scene: SceneFontLibrary<'_>,
    link: &LinkedSource,
) -> Result<PreparedFontBatch, FontIngestRefusal> {
    let requested = match link {
        LinkedSource::CssUrl { url, .. } => url.trim().to_string(),
        LinkedSource::AdobeFonts { project_id } => project_id.trim().to_string(),
    };
    let refuse = |source: &str| {
        let source = source.to_string();
        move |refusal: Refusal| FontIngestRefusal {
            source: source.clone(),
            refusal,
        }
    };
    let (stylesheet, integrity) = match canonical_link_source(link).map_err(refuse(&requested))? {
        FontSource::CssUrl { url, integrity } => (url, integrity),
        FontSource::AdobeFonts { url, .. } => (url, None),
        other => unreachable!("canonical_link_source never yields {other:?}"),
    };
    let provider = Provider::of(&stylesheet).ok_or_else(|| FontIngestRefusal {
        source: stylesheet.clone(),
        refusal: Refusal::FontFetchHostNotTrusted {
            url: stylesheet.clone(),
        },
    })?;
    let refuse_link = refuse(&stylesheet);

    // 1. Every stylesheet in the import tree.
    let mut faces = Vec::new();
    collect_stylesheet(
        fetcher,
        provider,
        &stylesheet,
        integrity.as_deref(),
        0,
        &mut Vec::new(),
        &mut HashSet::new(),
        &mut faces,
    )
    .map_err(&refuse_link)?;
    if faces.is_empty() {
        return Err(refuse_link(Refusal::FontFetchFailed {
            url: stylesheet.clone(),
            detail: "the stylesheet declares no @font-face rules".into(),
        }));
    }

    // 2. Every face file, once per URL, verified before anything is cached.
    let mut downloads: HashMap<String, Download> = HashMap::new();
    let mut total = 0usize;
    for collected in &faces {
        let source = preferred_source(&collected.face);
        if downloads.contains_key(&source.url) {
            continue;
        }
        let bytes = fetch(
            fetcher,
            &source.url,
            provider.font_hosts(),
            MAX_FONT_FILE_BYTES,
        )
        .map_err(&refuse_link)?;
        total += bytes.len();
        if total > MAX_LINK_BYTES {
            return Err(refuse_link(Refusal::FontFetchTooLarge {
                url: stylesheet.clone(),
                limit_bytes: MAX_LINK_BYTES,
            }));
        }
        let verified = verify_font_file(&bytes).map_err(|refusal| {
            refuse_link(match refusal {
                Refusal::InvalidFontData { detail } => Refusal::InvalidFontData {
                    detail: format!("{}: {detail}", source.url),
                },
                other => other,
            })
        })?;
        downloads.insert(
            source.url.clone(),
            Download {
                hash: content_hash(&bytes),
                bytes,
                verified,
            },
        );
    }

    // 3. Faces grouped by family, in stylesheet order.
    let mut families: Vec<FamilyDraft> = Vec::new();
    for collected in &faces {
        let face = &collected.face;
        let source = preferred_source(face);
        let download = &downloads[&source.url];
        let family = normalize_family(&face.family).map_err(&refuse_link)?;
        let weight = normalize_weight(face.weight).map_err(&refuse_link)?;
        let identity = short_hash(&format!(
            "{}:{weight}:{:?}:{}:{}",
            download.hash.0,
            face.style,
            face.stretch.as_deref().unwrap_or(""),
            face.unicode_range.as_deref().unwrap_or("")
        ));
        let asset = font_asset_item(
            &download.hash,
            download.verified.format,
            &format!("{family} {weight} {}", style_name(face)),
            download.bytes.len(),
        );
        let definition = FontFaceDefinition {
            face_id: format!("face_{identity}"),
            family: family.clone(),
            weight,
            style: face.style,
            stretch: face.stretch.clone(),
            unicode_range: face.unicode_range.clone(),
            source: FontSource::File {
                asset_id: asset.asset_id.clone(),
                format: download.verified.format,
                original_url: Some(source.url.clone()),
                stylesheet_url: Some(collected.stylesheet_url.clone()),
            },
            status: None,
            error_message: None,
        };
        let licence = download
            .verified
            .inspected
            .license
            .clone()
            .or_else(|| provider.fallback_licence().map(str::to_string));

        let index = match families.iter().position(|draft| draft.family == family) {
            Some(index) => index,
            None => {
                families.push(FamilyDraft {
                    family,
                    faces: Vec::new(),
                    assets: Vec::new(),
                    licences: Vec::new(),
                    unlicensed: false,
                });
                families.len() - 1
            }
        };
        let draft = &mut families[index];
        if draft.faces.iter().any(|f| f.face_id == definition.face_id) {
            continue;
        }
        draft.faces.push(definition);
        if !draft.assets.iter().any(|a| a.asset_id == asset.asset_id) {
            draft.assets.push(asset);
        }
        match licence {
            Some(licence) if !draft.licences.contains(&licence) => draft.licences.push(licence),
            Some(_) => {}
            None => draft.unlicensed = true,
        }
    }

    // 4. One definition per family, through the shared batch rules.
    let mut builder = BatchBuilder::new(scene);
    for draft in families {
        let mut face_ids: Vec<&str> = draft.faces.iter().map(|f| f.face_id.as_str()).collect();
        face_ids.sort_unstable();
        let font_id = format!(
            "font_{}",
            short_hash(&format!("link:{}:{}", draft.family, face_ids.join(",")))
        );
        if draft.unlicensed {
            return Err(refuse_link(Refusal::FontEmbeddingRefused { font_id }));
        }
        let font = FontDefinition {
            font_id,
            family: draft.family.clone(),
            display_name: draft.family,
            faces: draft.faces,
            fallback_families: normalize_fallbacks(&[]),
            embedding_policy: EmbeddingPolicy::Package,
            license: Some(draft.licences.join("; ")),
            enabled: true,
            source_label: Some(stylesheet.clone()),
            status: FontLoadStatus::Ready,
            error_message: None,
        };
        builder.add(&stylesheet, font, draft.assets)?;
    }

    // 5. Only a fully verified link reaches the cache.
    let mut stored: HashSet<&ContentHash> = HashSet::new();
    for download in downloads.values() {
        if !stored.insert(&download.hash) {
            continue;
        }
        let asset = font_asset_item(
            &download.hash,
            download.verified.format,
            &download.verified.inspected.display_name,
            download.bytes.len(),
        );
        store_font_asset(store, &asset, &download.bytes, &stylesheet)?;
    }
    Ok(builder.finish())
}

struct CollectedFace {
    face: ParsedFontFace,
    stylesheet_url: String,
}

struct Download {
    hash: ContentHash,
    bytes: Vec<u8>,
    verified: VerifiedFontFile,
}

struct FamilyDraft {
    family: String,
    faces: Vec<FontFaceDefinition>,
    assets: Vec<AssetLibraryItem>,
    licences: Vec<String>,
    unlicensed: bool,
}

#[allow(clippy::too_many_arguments)]
fn collect_stylesheet(
    fetcher: &dyn FontFetcher,
    provider: Provider,
    url: &str,
    integrity: Option<&str>,
    depth: u8,
    stack: &mut Vec<String>,
    seen: &mut HashSet<String>,
    out: &mut Vec<CollectedFace>,
) -> Result<(), Refusal> {
    stack.push(url.to_string());
    seen.insert(url.to_string());
    let bytes = fetch(fetcher, url, provider.stylesheet_hosts(), MAX_STYLESHEET_BYTES)?;
    if let Some(integrity) = integrity {
        verify_integrity(url, &bytes, integrity)?;
    }
    let css = String::from_utf8(bytes).map_err(|_| Refusal::FontFetchFailed {
        url: url.to_string(),
        detail: "the stylesheet is not UTF-8".into(),
    })?;
    let parsed = parse_font_stylesheet(&css, url);
    out.extend(parsed.faces.into_iter().map(|face| CollectedFace {
        face,
        stylesheet_url: url.to_string(),
    }));
    for import in parsed.imports {
        if provider.ignores_import(&import) {
            continue;
        }
        if stack.contains(&import) {
            return Err(Refusal::FontStylesheetImportCycle { url: import });
        }
        if seen.contains(&import) {
            continue;
        }
        if depth >= MAX_STYLESHEET_IMPORT_DEPTH {
            return Err(Refusal::FontStylesheetImportDepthExceeded {
                url: import,
                max_depth: MAX_STYLESHEET_IMPORT_DEPTH,
            });
        }
        collect_stylesheet(fetcher, provider, &import, None, depth + 1, stack, seen, out)?;
    }
    stack.pop();
    Ok(())
}

/// GET with the policy applied to the URL and to every redirect hop.
fn fetch(
    fetcher: &dyn FontFetcher,
    url: &str,
    hosts: &[&str],
    limit_bytes: usize,
) -> Result<Vec<u8>, Refusal> {
    let mut current = check_url(url, hosts)?;
    for _ in 0..=MAX_REDIRECTS {
        match fetcher.get(current.as_str(), limit_bytes)? {
            FetchedResponse::Body(bytes) if bytes.len() > limit_bytes => {
                return Err(Refusal::FontFetchTooLarge {
                    url: current.to_string(),
                    limit_bytes,
                });
            }
            FetchedResponse::Body(bytes) => return Ok(bytes),
            FetchedResponse::Redirect { location } => {
                let next = current
                    .join(&location)
                    .map_err(|_| Refusal::InvalidFontUrl { url: location })?;
                current = check_url(next.as_str(), hosts)?;
            }
        }
    }
    Err(Refusal::FontFetchFailed {
        url: url.to_string(),
        detail: format!("more than {MAX_REDIRECTS} redirects"),
    })
}

/// HTTPS, no credentials, default port, and a host on this request's list.
fn check_url(raw: &str, hosts: &[&str]) -> Result<url::Url, Refusal> {
    let url = url::Url::parse(raw).map_err(|_| Refusal::InvalidFontUrl {
        url: raw.to_string(),
    })?;
    if url.scheme() != "https" {
        return Err(Refusal::FontUrlNotHttps {
            url: raw.to_string(),
        });
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refusal::FontUrlHasCredentials {
            url: raw.to_string(),
        });
    }
    let host = url.host_str().map(str::to_ascii_lowercase);
    let trusted = host.is_some_and(|host| hosts.contains(&host.as_str()));
    if !trusted || url.port().is_some() {
        return Err(Refusal::FontFetchHostNotTrusted {
            url: raw.to_string(),
        });
    }
    Ok(url)
}

/// WOFF2 first, then WOFF, then sfnt, then an unlabelled candidate — the
/// stylesheet's own order breaks ties. The bytes' magic is still the truth.
fn preferred_source(face: &ParsedFontFace) -> &ParsedFontSource {
    face.sources
        .iter()
        .min_by_key(|source| match source.format {
            Some(FontFormat::Woff2) => 0,
            Some(FontFormat::Woff) => 1,
            Some(FontFormat::Otf | FontFormat::Ttf) => 2,
            None => 3,
        })
        .expect("css::parse_face drops faces without sources")
}

fn style_name(face: &ParsedFontFace) -> &'static str {
    match face.style {
        gx_contracts::font::FontStyle::Normal => "normal",
        gx_contracts::font::FontStyle::Italic => "italic",
        gx_contracts::font::FontStyle::Oblique => "oblique",
    }
}

/// Subresource Integrity (`sha256-…`, `sha384-…`, `sha512-…`, space
/// separated): the stylesheet must match one supported entry.
fn verify_integrity(url: &str, bytes: &[u8], integrity: &str) -> Result<(), Refusal> {
    let mut supported = false;
    for token in integrity.split_whitespace() {
        let token = token.split('?').next().unwrap_or(token);
        let Some((algorithm, expected)) = token.split_once('-') else {
            continue;
        };
        let actual = match algorithm {
            "sha256" => base64(&Sha256::digest(bytes)),
            "sha384" => base64(&Sha384::digest(bytes)),
            "sha512" => base64(&Sha512::digest(bytes)),
            _ => continue,
        };
        supported = true;
        if actual == expected {
            return Ok(());
        }
    }
    Err(Refusal::FontFetchFailed {
        url: url.to_string(),
        detail: if supported {
            "the stylesheet does not match its integrity metadata".into()
        } else {
            "the integrity metadata names no supported algorithm (sha256, sha384, sha512)".into()
        },
    })
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use gx_contracts::font::FontStyle;

    use super::*;
    use crate::fonts::ingest::FontDisposition;

    const TTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
    const WOFF2: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff2");
    const UNLICENSED: &[u8] =
        include_bytes!("../../tests/fixtures/fonts/inter-latin-unlicensed.ttf");

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn store() -> (AssetStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "gx-asset-plane-font-link-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        (AssetStore::at_root(root.clone()), root)
    }

    /// Serves canned responses and records every URL it was asked for.
    #[derive(Default)]
    struct FakeFetcher {
        responses: HashMap<String, Result<FetchedResponse, Refusal>>,
        requested: RefCell<Vec<String>>,
    }

    impl FakeFetcher {
        fn body(mut self, url: &str, body: &[u8]) -> Self {
            self.responses
                .insert(url.into(), Ok(FetchedResponse::Body(body.to_vec())));
            self
        }
        fn redirect(mut self, url: &str, location: &str) -> Self {
            self.responses.insert(
                url.into(),
                Ok(FetchedResponse::Redirect {
                    location: location.into(),
                }),
            );
            self
        }
        fn refuse(mut self, url: &str, refusal: Refusal) -> Self {
            self.responses.insert(url.into(), Err(refusal));
            self
        }
        fn requested(&self) -> Vec<String> {
            self.requested.borrow().clone()
        }
    }

    impl FontFetcher for FakeFetcher {
        fn get(&self, url: &str, _limit: usize) -> Result<FetchedResponse, Refusal> {
            self.requested.borrow_mut().push(url.to_string());
            self.responses
                .get(url)
                .cloned()
                .unwrap_or_else(|| panic!("unexpected fetch of {url}"))
        }
    }

    const GOOGLE: &str = "https://fonts.googleapis.com/css2?family=Inter:wght@400;700";
    const GOOGLE_400: &str = "https://fonts.gstatic.com/s/inter/v13/regular.woff2";
    const GOOGLE_400_TTF: &str = "https://fonts.gstatic.com/s/inter/v13/regular.ttf";
    const GOOGLE_700: &str = "https://fonts.gstatic.com/s/inter/v13/bold.ttf";

    fn google_css() -> String {
        format!(
            "@font-face {{ font-family: 'Inter'; font-style: normal; font-weight: 400; \
               src: url({GOOGLE_400_TTF}) format('truetype'), url({GOOGLE_400}) format('woff2'); \
               unicode-range: U+0000-00FF; }}\n\
             @font-face {{ font-family: 'Inter'; font-style: normal; font-weight: 700; \
               src: url({GOOGLE_700}) format('truetype'); }}"
        )
    }

    fn css_link(url: &str) -> LinkedSource {
        LinkedSource::CssUrl {
            url: url.into(),
            integrity: None,
        }
    }

    const EMPTY: SceneFontLibrary<'static> = SceneFontLibrary {
        fonts: &[],
        assets: &[],
    };

    #[test]
    fn a_google_link_downloads_verified_faces_into_the_project() {
        let (mut store, root) = store();
        let fetcher = FakeFetcher::default()
            .body(GOOGLE, google_css().as_bytes())
            .body(GOOGLE_400, WOFF2)
            .body(GOOGLE_700, TTF);
        let batch = prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap();

        // WOFF2 was preferred over the TTF candidate listed first.
        assert_eq!(fetcher.requested(), [GOOGLE, GOOGLE_400, GOOGLE_700]);
        assert_eq!(batch.fonts.len(), 1);
        let font = &batch.fonts[0];
        assert_eq!(font.family, "Inter");
        assert_eq!(font.embedding_policy, EmbeddingPolicy::Package);
        assert!(font
            .license
            .as_deref()
            .is_some_and(|l| l.contains("SIL Open Font License")));
        assert_eq!(font.source_label.as_deref(), Some(GOOGLE));
        assert_eq!(font.faces.len(), 2);
        assert_eq!(font.faces[0].weight, 400);
        assert_eq!(font.faces[0].unicode_range.as_deref(), Some("U+0000-00FF"));
        assert_eq!(font.faces[1].weight, 700);
        assert_eq!(font.faces[1].style, FontStyle::Normal);
        let FontSource::File {
            asset_id,
            format,
            original_url,
            stylesheet_url,
        } = &font.faces[0].source
        else {
            panic!("a downloaded face is a project file")
        };
        assert_eq!(*format, FontFormat::Woff2);
        assert_eq!(original_url.as_deref(), Some(GOOGLE_400));
        assert_eq!(stylesheet_url.as_deref(), Some(GOOGLE));
        assert_eq!(batch.assets.len(), 2);
        assert_eq!(&batch.assets[0].asset_id, asset_id);
        for bytes in [WOFF2, TTF] {
            assert!(store.contains(&content_hash(bytes)).unwrap());
        }

        // Re-ingesting the same link keeps the font's identity and adds nothing.
        let scene = SceneFontLibrary {
            fonts: &batch.fonts,
            assets: &batch.assets,
        };
        let again = prepare_font_link(&mut store, &fetcher, scene, &css_link(GOOGLE)).unwrap();
        assert!(again.fonts.is_empty() && again.assets.is_empty());
        assert_eq!(again.sources[0].font_id, font.font_id);
        assert_eq!(again.sources[0].disposition, FontDisposition::AlreadyInScene);
        std::fs::remove_dir_all(root).ok();
    }

    const ADOBE_FACE: &str = "https://use.typekit.net/af/0a1b2c/000000000000000000013365/27/l?primer=7cdcb44be4a7db8877ffa5c0007b8dd865b3bbc383831fe2ea177f62257a9191&fvd=n4&v=3";

    fn adobe_css() -> String {
        format!(
            "@import url(\"https://p.typekit.net/p.css?s=1&k=abc123&ht=tk&f=1&a=1\");\n\
             @font-face {{ font-family: \"inter-kit\"; \
               src: url(\"{ADOBE_FACE}\") format(\"woff2\"); \
               font-display: auto; font-style: normal; font-weight: 400; }}"
        )
    }

    #[test]
    fn an_adobe_kit_downloads_into_the_project_with_the_recorded_licence() {
        let (mut store, root) = store();
        let kit = "https://use.typekit.net/abc123.css";
        let fetcher = FakeFetcher::default()
            .body(kit, adobe_css().as_bytes())
            .body(ADOBE_FACE, UNLICENSED);
        let batch = prepare_font_link(
            &mut store,
            &fetcher,
            EMPTY,
            &LinkedSource::AdobeFonts {
                project_id: "abc123".into(),
            },
        )
        .unwrap();

        // The p.typekit.net tracker is never contacted.
        assert_eq!(fetcher.requested(), [kit, ADOBE_FACE]);
        let font = &batch.fonts[0];
        assert_eq!(font.family, "inter-kit");
        assert_eq!(font.embedding_policy, EmbeddingPolicy::Package);
        assert_eq!(font.license.as_deref(), Some(ADOBE_FONTS_PACKAGING_LICENCE));
        assert!(matches!(
            &font.faces[0].source,
            FontSource::File { original_url: Some(url), stylesheet_url: Some(sheet), .. }
                if url == ADOBE_FACE && sheet == kit
        ));
        assert!(store.contains(&content_hash(UNLICENSED)).unwrap());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_refused_adobe_download_rejects_the_whole_link() {
        let (mut store, root) = store();
        let kit = "https://use.typekit.net/abc123.css";
        let forbidden = Refusal::FontFetchFailed {
            url: ADOBE_FACE.into(),
            detail: "HTTP 403".into(),
        };
        let fetcher = FakeFetcher::default()
            .body(kit, adobe_css().as_bytes())
            .refuse(ADOBE_FACE, forbidden.clone());
        let refusal = prepare_font_link(
            &mut store,
            &fetcher,
            EMPTY,
            &LinkedSource::AdobeFonts {
                project_id: "abc123".into(),
            },
        )
        .unwrap_err();
        assert_eq!(refusal.source, kit);
        assert_eq!(refusal.refusal, forbidden);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_bad_face_rejects_the_link_and_caches_nothing() {
        let (mut store, root) = store();
        let fetcher = FakeFetcher::default()
            .body(GOOGLE, google_css().as_bytes())
            .body(GOOGLE_400, WOFF2)
            .body(GOOGLE_700, b"<html>not a font</html>");
        let refusal =
            prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap_err();
        assert!(matches!(
            &refusal.refusal,
            Refusal::InvalidFontData { detail } if detail.starts_with(GOOGLE_700)
        ));
        assert!(!store.contains(&content_hash(WOFF2)).unwrap());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_google_face_without_a_licence_is_refused_not_assumed() {
        let (mut store, root) = store();
        let css = format!(
            "@font-face {{ font-family: Inter; font-weight: 400; src: url({GOOGLE_700}); }}"
        );
        let fetcher = FakeFetcher::default()
            .body(GOOGLE, css.as_bytes())
            .body(GOOGLE_700, UNLICENSED);
        let refusal =
            prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap_err();
        assert!(matches!(refusal.refusal, Refusal::FontEmbeddingRefused { .. }));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn font_files_come_only_from_the_providers_cdn_on_every_hop() {
        let (mut store, root) = store();
        let offsite =
            "@font-face { font-family: Inter; src: url(https://cdn.example.com/inter.woff2); }";
        let fetcher = FakeFetcher::default().body(GOOGLE, offsite.as_bytes());
        let refusal =
            prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap_err();
        assert_eq!(
            refusal.refusal,
            Refusal::FontFetchHostNotTrusted {
                url: "https://cdn.example.com/inter.woff2".into()
            }
        );

        // A trusted URL that redirects off the CDN is refused at the hop.
        let fetcher = FakeFetcher::default()
            .body(GOOGLE, google_css().as_bytes())
            .redirect(GOOGLE_400, "https://evil.example.com/x.woff2");
        let refusal =
            prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap_err();
        assert_eq!(
            refusal.refusal,
            Refusal::FontFetchHostNotTrusted {
                url: "https://evil.example.com/x.woff2".into()
            }
        );

        // Credentials and plain HTTP are named offences, not host misses.
        assert!(matches!(
            check_url("https://user:pw@fonts.gstatic.com/a.woff2", &["fonts.gstatic.com"]),
            Err(Refusal::FontUrlHasCredentials { .. })
        ));
        assert!(matches!(
            check_url("http://fonts.gstatic.com/a.woff2", &["fonts.gstatic.com"]),
            Err(Refusal::FontUrlNotHttps { .. })
        ));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stylesheet_imports_stay_on_the_provider_and_cannot_cycle() {
        let (mut store, root) = store();
        let a = "https://fonts.bunny.net/css?family=inter:400";
        let b = "https://fonts.bunny.net/css/b.css";
        let fetcher = FakeFetcher::default()
            .body(a, format!("@import url(\"{b}\");").as_bytes())
            .body(b, format!("@import url(\"{a}\");").as_bytes());
        let refusal = prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(a)).unwrap_err();
        assert_eq!(
            refusal.refusal,
            Refusal::FontStylesheetImportCycle { url: a.into() }
        );

        let fetcher = FakeFetcher::default().body(
            a,
            b"@import url(\"https://fonts.googleapis.com/css2?family=Inter\");",
        );
        let refusal = prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(a)).unwrap_err();
        assert!(matches!(refusal.refusal, Refusal::FontFetchHostNotTrusted { .. }));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn oversized_responses_and_integrity_mismatches_are_refused() {
        let (mut store, root) = store();
        let huge = vec![b' '; MAX_STYLESHEET_BYTES + 1];
        let fetcher = FakeFetcher::default().body(GOOGLE, &huge);
        let refusal =
            prepare_font_link(&mut store, &fetcher, EMPTY, &css_link(GOOGLE)).unwrap_err();
        assert!(matches!(refusal.refusal, Refusal::FontFetchTooLarge { .. }));

        let css = google_css();
        let fetcher = FakeFetcher::default()
            .body(GOOGLE, css.as_bytes())
            .body(GOOGLE_400, WOFF2)
            .body(GOOGLE_700, TTF);
        let wrong = LinkedSource::CssUrl {
            url: GOOGLE.into(),
            integrity: Some(format!("sha256-{}", base64(&Sha256::digest(b"other")))),
        };
        let refusal = prepare_font_link(&mut store, &fetcher, EMPTY, &wrong).unwrap_err();
        assert!(matches!(refusal.refusal, Refusal::FontFetchFailed { .. }));
        let right = LinkedSource::CssUrl {
            url: GOOGLE.into(),
            integrity: Some(format!("sha384-{}", base64(&Sha384::digest(css.as_bytes())))),
        };
        assert!(prepare_font_link(&mut store, &fetcher, EMPTY, &right).is_ok());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }
}

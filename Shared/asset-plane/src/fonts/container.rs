//! Font container handling: the step between "bytes someone handed us" and
//! the sfnt tables `metadata::inspect_font` reads.
//!
//! OTF and TTF are sfnt already and pass through borrowed. WOFF (zlib) and
//! WOFF2 (Brotli, with the glyf/loca/hmtx transforms) are delivery wrappers;
//! `allsorts` decodes them and rebuilds a whole sfnt, so every accepted
//! container is verified by the same `ttf-parser` inspection and a consumer
//! that only reads sfnt (the engine's shaper database) can be handed the
//! decoded tables. The container is decided by magic bytes, never by a file
//! extension or a stylesheet's `format()` hint.

use std::borrow::Cow;

use allsorts::binary::read::ReadScope;
use allsorts::font_data::FontData;
use allsorts::tables::{FontTableProvider, TTCF_MAGIC};
use gx_contracts::font::FontFormat;
use gx_contracts::Refusal;

use super::metadata::{inspect_font, sniff_format, InspectedFont};

/// A font file that decoded and answered inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedFontFile {
    /// The container the bytes actually are, from their magic.
    pub format: FontFormat,
    pub inspected: InspectedFont,
}

/// The sfnt tables of a font file. OTF/TTF are returned as-is; WOFF/WOFF2
/// are decoded. Anything else, including font collections, is refused by
/// name — a collection would need a face index nothing in the model carries.
pub fn sfnt_bytes(bytes: &[u8]) -> Result<Cow<'_, [u8]>, Refusal> {
    match sniff_format(bytes) {
        Some(FontFormat::Otf | FontFormat::Ttf) => Ok(Cow::Borrowed(bytes)),
        Some(format @ (FontFormat::Woff | FontFormat::Woff2)) => {
            unwrap_transport(bytes, format).map(Cow::Owned)
        }
        None => Err(Refusal::InvalidFontData {
            detail: if bytes.get(..4) == Some(b"ttcf") {
                "font collections (TTC/OTC) are not accepted; supply one face per file".into()
            } else {
                "not an OTF, TTF, WOFF or WOFF2 file (unrecognised magic bytes)".into()
            },
        }),
    }
}

/// Decode the container and inspect the result. This is the one verification
/// every ingest path runs before bytes may be cached as a font.
pub fn verify_font_file(bytes: &[u8]) -> Result<VerifiedFontFile, Refusal> {
    let format = sniff_format(bytes);
    let sfnt = sfnt_bytes(bytes)?;
    let inspected = inspect_font(&sfnt)?;
    Ok(VerifiedFontFile {
        format: format.expect("sfnt_bytes refuses bytes without a recognised container"),
        inspected,
    })
}

fn unwrap_transport(bytes: &[u8], format: FontFormat) -> Result<Vec<u8>, Refusal> {
    let label = match format {
        FontFormat::Woff2 => "WOFF2",
        _ => "WOFF",
    };
    let refuse = |what: &str, error: &dyn std::fmt::Display| Refusal::InvalidFontData {
        detail: format!("{label} container {what}: {error}"),
    };
    let data = ReadScope::new(bytes)
        .read::<FontData<'_>>()
        .map_err(|e| refuse("could not be read", &e))?;
    if let FontData::Woff2(woff2) = &data {
        if woff2.flavor() == TTCF_MAGIC {
            return Err(Refusal::InvalidFontData {
                detail: "WOFF2 font collections are not accepted; supply one face per file"
                    .into(),
            });
        }
    }
    let provider = data
        .table_provider(0)
        .map_err(|e| refuse("tables could not be decoded", &e))?;
    let tags = provider.table_tags().ok_or_else(|| Refusal::InvalidFontData {
        detail: format!("{label} container lists no tables"),
    })?;
    allsorts::subset::whole_font(&provider, &tags)
        .map_err(|e| refuse("could not be rebuilt as sfnt", &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::font::FontStyle;

    // Inter (SIL OFL 1.1), Latin subset, one source rendered into each
    // container with fontTools; see tests/fixtures/fonts.
    const TTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
    const OTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.otf");
    const WOFF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff");
    const WOFF2: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff2");

    #[test]
    fn every_container_decodes_and_reports_the_same_face() {
        for (bytes, format) in [
            (TTF, FontFormat::Ttf),
            (OTF, FontFormat::Otf),
            (WOFF, FontFormat::Woff),
            (WOFF2, FontFormat::Woff2),
        ] {
            let verified = verify_font_file(bytes).expect("fixture verifies");
            assert_eq!(verified.format, format);
            assert_eq!(verified.inspected.family, "Inter");
            assert_eq!(verified.inspected.display_name, "Inter Regular");
            assert_eq!(verified.inspected.weight, 400);
            assert_eq!(verified.inspected.style, FontStyle::Normal);
            assert!(verified
                .inspected
                .license
                .as_deref()
                .is_some_and(|l| l.contains("SIL Open Font License")));
        }
    }

    #[test]
    fn transport_wrappers_decode_to_parseable_sfnt() {
        for bytes in [WOFF, WOFF2] {
            let sfnt = sfnt_bytes(bytes).unwrap();
            assert!(matches!(sfnt, Cow::Owned(_)));
            assert!(ttf_parser::Face::parse(&sfnt, 0).is_ok());
        }
        assert!(matches!(sfnt_bytes(TTF).unwrap(), Cow::Borrowed(_)));
    }

    #[test]
    fn invalid_containers_are_refused_by_name() {
        // Right magic, truncated body: the container itself fails to read.
        for bytes in [&WOFF[..40], &WOFF2[..40], &TTF[..40]] {
            assert!(matches!(
                verify_font_file(bytes),
                Err(Refusal::InvalidFontData { .. })
            ));
        }
        assert!(matches!(
            sfnt_bytes(b"ttcf\0\x01\0\0"),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("collections")
        ));
        assert!(matches!(
            verify_font_file(b"PK\x03\x04 not a font"),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("magic")
        ));
    }
}

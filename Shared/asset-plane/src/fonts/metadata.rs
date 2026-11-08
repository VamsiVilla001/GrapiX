//! Font file inspection (1.x `fonts/fontMetadata.ts`, which used fontkit;
//! here on ttf-parser — both read the same name/OS/2 tables).
//!
//! Inspection answers exactly what the manager needs to build a face
//! definition: family, display name, weight, style, and the licence the font
//! declares about itself. A file that cannot answer the first four is refused
//! by name, never guessed at — a guessed family is a silent substitution
//! waiting to happen. An absent licence stays absent: it is never inferred.

use gx_contracts::font::FontStyle;
use gx_contracts::Refusal;

/// What a font file says about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedFont {
    pub family: String,
    pub display_name: String,
    /// CSS weight scale, 1–1000, from OS/2.usWeightClass.
    pub weight: u16,
    pub style: FontStyle,
    /// The licence the font records in its naming table: nameID 13 (licence
    /// description) and nameID 14 (licence URL), joined when both exist.
    /// `None` when the font states neither.
    pub license: Option<String>,
}

/// Read the naming and OS/2 tables of an OTF/TTF file. WOFF/WOFF2 must be
/// unwrapped first — ttf-parser reads raw sfnt; `container::verify_font_file`
/// is the entry point that decodes any accepted container and calls this.
pub fn inspect_font(bytes: &[u8]) -> Result<InspectedFont, Refusal> {
    inspect(bytes, None)
}

/// Inspect a face a stylesheet's `@font-face` rule declares. That rule names
/// the family, and the declaration is what a page and a template select by.
/// Adobe Fonts kit files carry an empty family name (and `-` for the full and
/// PostScript names), so the declared family stands in when the file names
/// none; a file's own name is still preferred when it has one. The tables are
/// parsed exactly as for any font: unreadable bytes refuse as before.
pub fn inspect_declared_font(
    bytes: &[u8],
    declared_family: &str,
) -> Result<InspectedFont, Refusal> {
    inspect(bytes, Some(declared_family))
}

fn inspect(bytes: &[u8], declared_family: Option<&str>) -> Result<InspectedFont, Refusal> {
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|e| Refusal::InvalidFontData {
        detail: format!("unparseable font: {e:?}"),
    })?;

    let named = face
        .names()
        .into_iter()
        .find(|n| n.name_id == ttf_parser::name_id::FAMILY)
        .and_then(|n| n.to_string())
        .map(|s| clean_name(&s))
        .filter(|s| !s.is_empty());
    let declared = declared_family.map(clean_name).filter(|s| !s.is_empty());
    let (family, from_declaration) = match (named, declared) {
        (Some(family), _) => (family, false),
        (None, Some(family)) => (family, true),
        (None, None) => {
            return Err(Refusal::InvalidFontData {
                detail: "font has no readable family name".into(),
            })
        }
    };

    // A file that does not name its family names nothing else usefully
    // either (Adobe's kit files say `-`), so the declaration names it whole.
    let display_name = if from_declaration {
        family.clone()
    } else {
        face.names()
            .into_iter()
            .find(|n| n.name_id == ttf_parser::name_id::FULL_NAME)
            .and_then(|n| n.to_string())
            .map(|s| clean_name(&s))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| family.clone())
    };

    let subfamily = face
        .names()
        .into_iter()
        .find(|n| n.name_id == ttf_parser::name_id::SUBFAMILY)
        .and_then(|n| n.to_string())
        .unwrap_or_default()
        .to_lowercase();

    let style = if face.italic_angle() != 0.0 || subfamily.contains("italic") {
        FontStyle::Italic
    } else if subfamily.contains("oblique") {
        FontStyle::Oblique
    } else {
        FontStyle::Normal
    };

    let name_text = |id: u16| {
        face.names()
            .into_iter()
            .find(|n| n.name_id == id && n.to_string().is_some())
            .and_then(|n| n.to_string())
            .map(|s| clean_licence(&s))
            .filter(|s| !s.is_empty())
    };
    let license = match (
        name_text(ttf_parser::name_id::LICENSE),
        name_text(ttf_parser::name_id::LICENSE_URL),
    ) {
        (Some(text), Some(url)) if !text.contains(&url) => Some(format!("{text} ({url})")),
        (Some(text), _) => Some(text),
        (None, url) => url,
    };

    Ok(InspectedFont {
        family,
        display_name,
        weight: normalize_weight(face.weight().to_number()),
        style,
        license,
    })
}

/// The container format of raw font bytes, from magic (1.x checked the same
/// four magics, in this order).
pub fn sniff_format(bytes: &[u8]) -> Option<gx_contracts::font::FontFormat> {
    use gx_contracts::font::FontFormat::*;
    match bytes.get(..4)? {
        b"wOF2" => Some(Woff2),
        b"wOFF" => Some(Woff),
        b"OTTO" => Some(Otf),
        [0x00, 0x01, 0x00, 0x00] => Some(Ttf),
        b"true" => Some(Ttf),
        _ => None,
    }
}

/// 1.x clamped to the CSS range rather than failing on a broken OS/2 table.
fn normalize_weight(value: u16) -> u16 {
    value.clamp(1, 1000)
}

fn clean_name(value: &str) -> String {
    value
        .replace(['\r', '\n', '\x0c'], " ")
        .trim()
        .chars()
        .take(128)
        .collect()
}

/// Licence text is recorded verbatim apart from line breaks; it is bounded
/// so a pathological naming table cannot bloat every scene that embeds it.
fn clean_licence(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(2048)
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use gx_contracts::font::FontFormat;

    #[test]
    fn sniff_recognises_all_four_containers() {
        assert_eq!(sniff_format(b"wOF2...."), Some(FontFormat::Woff2));
        assert_eq!(sniff_format(b"wOFF...."), Some(FontFormat::Woff));
        assert_eq!(sniff_format(b"OTTO...."), Some(FontFormat::Otf));
        assert_eq!(
            sniff_format(&[0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]),
            Some(FontFormat::Ttf)
        );
        assert_eq!(sniff_format(b"true...."), Some(FontFormat::Ttf));
        assert_eq!(sniff_format(b"random"), None);
        assert_eq!(sniff_format(&[0u8; 3]), None);
    }

    #[test]
    fn garbage_bytes_are_refused_by_name() {
        let result = inspect_font(b"this is not a font");
        assert!(matches!(result, Err(Refusal::InvalidFontData { .. })));
        assert!(matches!(
            inspect_declared_font(b"this is not a font", "kit-family"),
            Err(Refusal::InvalidFontData { .. })
        ));
    }

    /// An sfnt whose family names (IDs 1 and 16) are present but empty, as
    /// Adobe Fonts serves kit files.
    pub(crate) fn blank_family_names(sfnt: &[u8]) -> Vec<u8> {
        let mut out = sfnt.to_vec();
        let be16 = |b: &[u8], at: usize| usize::from(u16::from_be_bytes([b[at], b[at + 1]]));
        let tables = be16(&out, 4);
        let record = (0..tables)
            .map(|i| 12 + 16 * i)
            .find(|&r| &out[r..r + 4] == b"name")
            .expect("the fixture has a name table");
        let offset = u32::from_be_bytes(out[record + 8..record + 12].try_into().unwrap()) as usize;
        for i in 0..be16(&out, offset + 2) {
            let r = offset + 6 + 12 * i;
            if matches!(be16(&out, r + 6), 1 | 16) {
                out[r + 8] = 0;
                out[r + 9] = 0;
            }
        }
        out
    }

    #[test]
    fn a_declared_family_names_a_face_whose_file_names_none() {
        let named = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
        let blank = blank_family_names(named);
        assert!(matches!(
            inspect_font(&blank),
            Err(Refusal::InvalidFontData { detail }) if detail == "font has no readable family name"
        ));
        let inspected = inspect_declared_font(&blank, " new-science-mono ").unwrap();
        assert_eq!(inspected.family, "new-science-mono");
        assert_eq!(inspected.display_name, "new-science-mono");
        // The file's own name wins when it has one.
        assert_eq!(
            inspect_declared_font(named, "kit-family").unwrap().family,
            "Inter"
        );
        assert!(matches!(
            inspect_declared_font(&blank, "  "),
            Err(Refusal::InvalidFontData { .. })
        ));
    }
}

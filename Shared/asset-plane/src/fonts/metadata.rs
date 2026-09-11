//! Font file inspection (1.x `fonts/fontMetadata.ts`, which used fontkit;
//! here on ttf-parser — both read the same name/OS/2 tables).
//!
//! Inspection answers exactly what the manager needs to build a face
//! definition: family, display name, weight, style. A file that cannot answer
//! is refused by name, never guessed at — a guessed family is a silent
//! substitution waiting to happen.

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
}

/// Read the naming and OS/2 tables of an OTF/TTF file. WOFF/WOFF2 must be
/// unwrapped by the caller first — ttf-parser reads raw sfnt, and the
/// resolver knows the container from the URL or magic bytes.
pub fn inspect_font(bytes: &[u8]) -> Result<InspectedFont, Refusal> {
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|e| Refusal::InvalidFontData {
        detail: format!("unparseable font: {e:?}"),
    })?;

    let family = face
        .names()
        .into_iter()
        .find(|n| n.name_id == ttf_parser::name_id::FAMILY)
        .and_then(|n| n.to_string())
        .map(|s| clean_name(&s))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Refusal::InvalidFontData {
            detail: "font has no readable family name".into(),
        })?;

    let display_name = face
        .names()
        .into_iter()
        .find(|n| n.name_id == ttf_parser::name_id::FULL_NAME)
        .and_then(|n| n.to_string())
        .map(|s| clean_name(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| family.clone());

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

    Ok(InspectedFont {
        family,
        display_name,
        weight: normalize_weight(face.weight().to_number()),
        style,
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

#[cfg(test)]
mod tests {
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
    }
}

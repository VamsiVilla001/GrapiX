//! Font container conversion: the encoder half of `container`.
//!
//! `container` decodes WOFF and WOFF2 into sfnt so every accepted font is
//! inspected the same way. This module goes the other way, so a font that is
//! installed on the workstation as TTF/OTF (or arrives in any container) can be
//! stored as WOFF2 or WOFF: a smaller asset, and the form a page loads.
//!
//! **Nothing is trusted until it decodes again.** Every conversion is decoded
//! with the same `allsorts` reader the rest of the font subsystem uses and
//! compared table by table with the sfnt it came from; a conversion that does
//! not give the same tables back is refused by name, never stored.
//!
//! **WOFF2 is written without the glyf/loca transform.** The WOFF2 format allows
//! `glyf` and `loca` to be stored untransformed (transformation version 3), and
//! every conforming decoder reads that. The tables are still Brotli compressed
//! (in font mode) as one stream, which is where most of the saving comes from;
//! the transform would shave a further share off TrueType outlines at the cost
//! of an encoder that has to be proven glyph by glyph. That is not claimed here.

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use gx_contracts::font::FontFormat;
use gx_contracts::Refusal;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::container::sfnt_bytes;
use super::metadata::sniff_format;

/// The container a converted font is stored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FontConversionTarget {
    /// Brotli, the smallest and the form a page prefers.
    Woff2,
    /// zlib, for a consumer that does not read WOFF2.
    Woff,
    /// The sfnt as it is (TTF or OTF); nothing is re-encoded.
    Keep,
}

impl FontConversionTarget {
    /// The file extension a font stored this way takes, or `None` for `Keep`.
    pub fn extension(self) -> Option<&'static str> {
        match self {
            Self::Woff2 => Some("woff2"),
            Self::Woff => Some("woff"),
            Self::Keep => None,
        }
    }
}

/// A converted font and what the conversion did to its size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedFont {
    pub bytes: Vec<u8>,
    pub format: FontFormat,
    /// Size of the sfnt the font was converted from.
    pub sfnt_size: usize,
}

/// Convert font bytes in any accepted container to `target`.
///
/// The input may be TTF, OTF, WOFF or WOFF2 (the container is decided by magic);
/// `Keep` returns the sfnt as it is. The result is decoded again and compared
/// with the sfnt before it is returned.
pub fn convert_font(bytes: &[u8], target: FontConversionTarget) -> Result<ConvertedFont, Refusal> {
    let sfnt = sfnt_bytes(bytes)?;
    convert_sfnt(&sfnt, target)
}

/// As [`convert_font`], for bytes that are already an sfnt (a face taken out of a
/// font collection, say).
pub fn convert_sfnt(sfnt: &[u8], target: FontConversionTarget) -> Result<ConvertedFont, Refusal> {
    let (bytes, format) = match target {
        FontConversionTarget::Keep => (
            sfnt.to_vec(),
            sniff_format(sfnt).ok_or_else(|| refuse("not an sfnt font"))?,
        ),
        FontConversionTarget::Woff => (encode_woff(sfnt)?, FontFormat::Woff),
        FontConversionTarget::Woff2 => (encode_woff2(sfnt)?, FontFormat::Woff2),
    };
    if target != FontConversionTarget::Keep {
        check_round_trip(sfnt, &bytes, format)?;
    }
    Ok(ConvertedFont {
        bytes,
        format,
        sfnt_size: sfnt.len(),
    })
}

fn refuse(detail: impl Into<String>) -> Refusal {
    Refusal::InvalidFontData {
        detail: detail.into(),
    }
}

/// One table of an sfnt: its tag, the checksum its directory records, its bytes.
struct Table<'a> {
    tag: [u8; 4],
    checksum: u32,
    data: &'a [u8],
}

const MAX_TABLES: usize = 512;

/// The Brotli quality WOFF2 is written at.
const BROTLI_QUALITY: i32 = 9;

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// The sfnt's version tag and tables, in the order of the file's directory.
fn parse_sfnt(sfnt: &[u8]) -> Result<(u32, Vec<Table<'_>>), Refusal> {
    let flavor = be32(sfnt, 0).ok_or_else(|| refuse("not an sfnt font: too short"))?;
    let count = usize::from(be16(sfnt, 4).ok_or_else(|| refuse("not an sfnt font: too short"))?);
    if count == 0 || count > MAX_TABLES {
        return Err(refuse(format!("sfnt lists {count} tables")));
    }
    let mut tables = Vec::with_capacity(count);
    for index in 0..count {
        let record = 12 + 16 * index;
        let (Some(tag), Some(checksum), Some(offset), Some(length)) = (
            sfnt.get(record..record + 4),
            be32(sfnt, record + 4),
            be32(sfnt, record + 8),
            be32(sfnt, record + 12),
        ) else {
            return Err(refuse("sfnt table directory is cut short"));
        };
        let (offset, length) = (offset as usize, length as usize);
        let data = offset
            .checked_add(length)
            .and_then(|end| sfnt.get(offset..end))
            .ok_or_else(|| {
                refuse(format!(
                    "sfnt table {} lies outside the font",
                    String::from_utf8_lossy(tag)
                ))
            })?;
        tables.push(Table {
            tag: tag.try_into().expect("four bytes"),
            checksum,
            data,
        });
    }
    Ok((flavor, tables))
}

fn padded(length: usize) -> usize {
    (length + 3) & !3
}

/// What the sfnt would measure when rebuilt: header, directory and padded tables.
fn total_sfnt_size(tables: &[Table<'_>]) -> usize {
    12 + 16 * tables.len() + tables.iter().map(|t| padded(t.data.len())).sum::<usize>()
}

/// WOFF 1.0: a 44-byte header, a 20-byte record per table (sorted by tag), then
/// each table zlib-compressed when that is smaller, padded to four bytes.
pub fn encode_woff(sfnt: &[u8]) -> Result<Vec<u8>, Refusal> {
    let (flavor, mut tables) = parse_sfnt(sfnt)?;
    tables.sort_by_key(|table| table.tag);
    let sfnt_size = total_sfnt_size(&tables);

    let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(tables.len());
    for table in &tables {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        encoder
            .write_all(table.data)
            .map_err(|error| refuse(format!("WOFF compression failed: {error}")))?;
        let compressed = encoder
            .finish()
            .map_err(|error| refuse(format!("WOFF compression failed: {error}")))?;
        // A table that does not shrink is stored as it is (compLength == origLength).
        blocks.push(if compressed.len() < table.data.len() {
            compressed
        } else {
            table.data.to_vec()
        });
    }

    let directory_end = 44 + 20 * tables.len();
    let mut offset = directory_end;
    let mut out =
        Vec::with_capacity(directory_end + blocks.iter().map(|b| padded(b.len())).sum::<usize>());
    let total: usize = directory_end
        + blocks
            .iter()
            .map(|block| padded(block.len()))
            .sum::<usize>();
    out.extend_from_slice(b"wOFF");
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&to_u32(total, "WOFF length")?.to_be_bytes());
    out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&to_u32(sfnt_size, "WOFF sfnt size")?.to_be_bytes());
    // Version 0.0, and no metadata block and no private block.
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&[0; 20]);
    for (table, block) in tables.iter().zip(&blocks) {
        out.extend_from_slice(&table.tag);
        out.extend_from_slice(&to_u32(offset, "WOFF table offset")?.to_be_bytes());
        out.extend_from_slice(&to_u32(block.len(), "WOFF table length")?.to_be_bytes());
        out.extend_from_slice(&to_u32(table.data.len(), "WOFF table length")?.to_be_bytes());
        out.extend_from_slice(&table.checksum.to_be_bytes());
        offset += padded(block.len());
    }
    for block in &blocks {
        out.extend_from_slice(block);
        out.resize(out.len() + padded(block.len()) - block.len(), 0);
    }
    debug_assert_eq!(out.len(), total);
    Ok(out)
}

/// The 63 tags a WOFF2 directory names with one byte, in the order the format
/// numbers them. Any other tag is written out in full (flag value 63).
const KNOWN_TAGS: [&[u8; 4]; 63] = [
    b"cmap", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"OS/2", b"post", b"cvt ", b"fpgm",
    b"glyf", b"loca", b"prep", b"CFF ", b"VORG", b"EBDT", b"EBLC", b"gasp", b"hdmx", b"kern",
    b"LTSH", b"PCLT", b"VDMX", b"vhea", b"vmtx", b"BASE", b"GDEF", b"GPOS", b"GSUB", b"EBSC",
    b"JSTF", b"MATH", b"CBDT", b"CBLC", b"COLR", b"CPAL", b"SVG ", b"sbix", b"acnt", b"avar",
    b"bdat", b"bloc", b"bsln", b"cvar", b"fdsc", b"feat", b"fmtx", b"fvar", b"gvar", b"hsty",
    b"just", b"lcar", b"mort", b"morx", b"opbd", b"prop", b"trak", b"Zapf", b"Silf", b"Glat",
    b"Gloc", b"Feat", b"Sill",
];

/// WOFF2's UIntBase128: seven bits a byte, most significant first, the high bit
/// set on every byte but the last.
fn push_base128(out: &mut Vec<u8>, value: u32) {
    let mut groups = [0u8; 5];
    let mut count = 0;
    let mut rest = value;
    loop {
        groups[count] = (rest & 0x7f) as u8;
        count += 1;
        rest >>= 7;
        if rest == 0 {
            break;
        }
    }
    for index in (0..count).rev() {
        out.push(groups[index] | if index == 0 { 0 } else { 0x80 });
    }
}

fn to_u32(value: usize, what: &str) -> Result<u32, Refusal> {
    u32::try_from(value).map_err(|_| refuse(format!("{what} does not fit a WOFF header")))
}

/// WOFF2: a 48-byte header, a directory of one-byte tag flags and base-128
/// lengths, then every table, in directory order, as one Brotli stream.
pub fn encode_woff2(sfnt: &[u8]) -> Result<Vec<u8>, Refusal> {
    let (flavor, mut tables) = parse_sfnt(sfnt)?;
    tables.sort_by_key(|table| table.tag);
    // The directory keeps `loca` straight after `glyf`, as the format asks.
    if let (Some(glyf), Some(loca)) = (
        tables.iter().position(|t| &t.tag == b"glyf"),
        tables.iter().position(|t| &t.tag == b"loca"),
    ) {
        let table = tables.remove(loca);
        let glyf = if loca < glyf { glyf - 1 } else { glyf };
        tables.insert(glyf + 1, table);
    }
    let sfnt_size = total_sfnt_size(&tables);

    let mut directory = Vec::new();
    let mut stream = Vec::with_capacity(tables.iter().map(|t| t.data.len()).sum());
    for table in &tables {
        // glyf and loca are stored untransformed: transformation version 3.
        let transform: u8 = if &table.tag == b"glyf" || &table.tag == b"loca" {
            3
        } else {
            0
        };
        match KNOWN_TAGS.iter().position(|known| **known == table.tag) {
            Some(index) => directory.push(index as u8 | transform << 6),
            None => {
                directory.push(63 | transform << 6);
                directory.extend_from_slice(&table.tag);
            }
        }
        push_base128(
            &mut directory,
            to_u32(table.data.len(), "WOFF2 table length")?,
        );
        stream.extend_from_slice(table.data);
    }

    let mut compressed = Vec::new();
    let params = brotli::enc::BrotliEncoderParams {
        // Quality 9, measured on the installed Arial faces: about 3 s for eight conversions, against about 40 s at 10 or 11 for a file
        // only 2 to 5 per cent smaller. The slow settings switch to an exhaustive search that an interactive import should not wait on.
        quality: BROTLI_QUALITY,
        lgwin: 22,
        mode: brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_FONT,
        size_hint: stream.len(),
        ..Default::default()
    };
    brotli::BrotliCompress(&mut stream.as_slice(), &mut compressed, &params)
        .map_err(|error| refuse(format!("WOFF2 compression failed: {error}")))?;

    let header_and_directory = 48 + directory.len();
    let total = padded(header_and_directory + compressed.len());
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"wOF2");
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&to_u32(total, "WOFF2 length")?.to_be_bytes());
    out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&to_u32(sfnt_size, "WOFF2 sfnt size")?.to_be_bytes());
    out.extend_from_slice(&to_u32(compressed.len(), "WOFF2 compressed size")?.to_be_bytes());
    // Version 0.0, and no metadata block and no private block.
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&[0; 20]);
    out.extend_from_slice(&directory);
    out.extend_from_slice(&compressed);
    out.resize(total, 0);
    Ok(out)
}

/// Decode `encoded` with the reader the font subsystem uses and compare every
/// table with `original`. `head` is compared without its checksum adjustment,
/// which a rebuild recomputes.
fn check_round_trip(original: &[u8], encoded: &[u8], format: FontFormat) -> Result<(), Refusal> {
    let label = if format == FontFormat::Woff2 {
        "WOFF2"
    } else {
        "WOFF"
    };
    let decoded = sfnt_bytes(encoded)?;
    let (_, before) = parse_sfnt(original)?;
    let (_, after) = parse_sfnt(&decoded)?;
    for table in &before {
        let name = String::from_utf8_lossy(&table.tag).into_owned();
        let Some(round) = after.iter().find(|candidate| candidate.tag == table.tag) else {
            return Err(refuse(format!(
                "{label} conversion lost the {name} table; nothing was stored"
            )));
        };
        let same = if &table.tag == b"head" && table.data.len() >= 12 && round.data.len() >= 12 {
            table.data[..8] == round.data[..8] && table.data[12..] == round.data[12..]
        } else {
            table.data == round.data
        };
        if !same {
            return Err(refuse(format!(
                "{label} conversion changed the {name} table; nothing was stored"
            )));
        }
    }
    if after.len() != before.len() {
        return Err(refuse(format!(
            "{label} conversion changed the table count from {} to {}; nothing was stored",
            before.len(),
            after.len()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::container::{sfnt_bytes, verify_font_file};
    use gx_contracts::font::FontStyle;

    const TTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.ttf");
    const OTF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.otf");
    const WOFF: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff");
    const WOFF2: &[u8] = include_bytes!("../../tests/fixtures/fonts/inter-latin.woff2");

    fn tables_of(sfnt: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let (_, mut tables) = parse_sfnt(sfnt).unwrap();
        tables.sort_by_key(|t| t.tag);
        tables.iter().map(|t| (t.tag, t.data.to_vec())).collect()
    }

    #[test]
    fn base128_matches_the_format() {
        let mut out = Vec::new();
        for (value, bytes) in [
            (0u32, vec![0x00]),
            (63, vec![0x3f]),
            (127, vec![0x7f]),
            (128, vec![0x81, 0x00]),
            (16383, vec![0xff, 0x7f]),
            (16384, vec![0x81, 0x80, 0x00]),
            (u32::MAX, vec![0x8f, 0xff, 0xff, 0xff, 0x7f]),
        ] {
            out.clear();
            push_base128(&mut out, value);
            assert_eq!(out, bytes, "{value}");
        }
    }

    #[test]
    fn known_tags_match_the_reader_s_numbering() {
        // The reader numbers a tag by position; the encoder must agree for every
        // table of a real font, which the round trip below also proves.
        assert_eq!(KNOWN_TAGS[1], b"head");
        assert_eq!(KNOWN_TAGS[10], b"glyf");
        assert_eq!(KNOWN_TAGS[11], b"loca");
        assert_eq!(KNOWN_TAGS[13], b"CFF ");
        assert_eq!(KNOWN_TAGS[62], b"Sill");
    }

    #[test]
    fn a_ttf_converts_to_woff_and_woff2_and_back_to_the_same_tables() {
        for target in [FontConversionTarget::Woff, FontConversionTarget::Woff2] {
            let converted = convert_font(TTF, target).unwrap();
            let verified = verify_font_file(&converted.bytes).expect("converted font verifies");
            assert_eq!(verified.format, converted.format);
            assert_eq!(verified.inspected.family, "Inter");
            assert_eq!(verified.inspected.weight, 400);
            assert_eq!(verified.inspected.style, FontStyle::Normal);
            let back = sfnt_bytes(&converted.bytes).unwrap();
            let (before, after) = (tables_of(TTF), tables_of(&back));
            assert_eq!(before.len(), after.len());
            for ((tag, left), (_, right)) in before.iter().zip(&after) {
                if tag == b"head" {
                    assert_eq!(left[..8], right[..8]);
                    assert_eq!(left[12..], right[12..]);
                } else {
                    assert_eq!(left, right, "{}", String::from_utf8_lossy(tag));
                }
            }
            assert!(
                converted.bytes.len() < TTF.len(),
                "{target:?} is smaller than the TTF"
            );
        }
    }

    #[test]
    fn woff2_is_smaller_than_woff_and_both_are_deterministic() {
        let woff = convert_font(TTF, FontConversionTarget::Woff).unwrap();
        let woff2 = convert_font(TTF, FontConversionTarget::Woff2).unwrap();
        assert!(
            woff2.bytes.len() < woff.bytes.len(),
            "{} < {}",
            woff2.bytes.len(),
            woff.bytes.len()
        );
        // Content-addressed identity needs the same input to give the same bytes.
        assert_eq!(woff, convert_font(TTF, FontConversionTarget::Woff).unwrap());
        assert_eq!(
            woff2,
            convert_font(TTF, FontConversionTarget::Woff2).unwrap()
        );
    }

    #[test]
    fn a_cff_otf_converts_too() {
        for target in [FontConversionTarget::Woff, FontConversionTarget::Woff2] {
            let converted = convert_font(OTF, target).unwrap();
            let verified = verify_font_file(&converted.bytes).unwrap();
            assert_eq!(verified.inspected.family, "Inter");
            let back = sfnt_bytes(&converted.bytes).unwrap();
            assert_eq!(tables_of(OTF).len(), tables_of(&back).len());
        }
    }

    #[test]
    fn any_container_converts_to_any_other() {
        for source in [TTF, OTF, WOFF, WOFF2] {
            for target in [FontConversionTarget::Woff, FontConversionTarget::Woff2] {
                let converted = convert_font(source, target).unwrap();
                assert_eq!(
                    converted.format,
                    if target == FontConversionTarget::Woff {
                        FontFormat::Woff
                    } else {
                        FontFormat::Woff2
                    }
                );
                assert_eq!(
                    verify_font_file(&converted.bytes).unwrap().inspected.family,
                    "Inter"
                );
            }
        }
    }

    #[test]
    fn keep_hands_the_sfnt_back_untouched() {
        let kept = convert_font(TTF, FontConversionTarget::Keep).unwrap();
        assert_eq!(kept.bytes, TTF);
        assert_eq!(kept.format, FontFormat::Ttf);
        // A WOFF kept is the sfnt it wraps, in the format its flavour names.
        let unwrapped = convert_font(WOFF2, FontConversionTarget::Keep).unwrap();
        assert!(ttf_parser::Face::parse(&unwrapped.bytes, 0).is_ok());
        assert_ne!(unwrapped.format, FontFormat::Woff2);
    }

    #[test]
    fn a_conversion_that_does_not_give_the_tables_back_is_refused() {
        let mut woff2 = encode_woff2(&sfnt_bytes(TTF).unwrap()).unwrap();
        // Flip a byte in the middle of the compressed stream.
        let at = woff2.len() / 2;
        woff2[at] ^= 0xff;
        let sfnt = sfnt_bytes(TTF).unwrap();
        let refused = check_round_trip(&sfnt, &woff2, FontFormat::Woff2);
        assert!(
            matches!(refused, Err(Refusal::InvalidFontData { .. })),
            "{refused:?}"
        );
    }

    #[test]
    fn what_is_not_an_sfnt_is_refused_by_name() {
        for bytes in [&b"not a font"[..], &TTF[..9], &[0u8; 40][..]] {
            for target in [FontConversionTarget::Woff, FontConversionTarget::Woff2] {
                assert!(matches!(
                    convert_sfnt(bytes, target),
                    Err(Refusal::InvalidFontData { .. })
                ));
            }
        }
        // A directory that points past the end of the font.
        let mut broken = TTF.to_vec();
        broken[12 + 8..12 + 12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(matches!(
            encode_woff(&broken),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("outside the font")
        ));
    }
}

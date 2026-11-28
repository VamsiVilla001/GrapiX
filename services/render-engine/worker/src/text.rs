//! Text preparation through `cosmic-text` (build plan 3.6).
//!
//! Only packaged, content-addressed font bytes enter the font database. The
//! system font database is never loaded, so a missing face cannot turn into a
//! platform-dependent substitution. Shaping, bidi resolution, fallback and
//! OpenType layout all happen once when a scene is published.
//!
//! Glyphs are drawn as their real outlines (3.13): each glyph's outline is
//! taken from the packaged face at publish, kept as one outline per text
//! object in the text's own coordinates, and placed through the same
//! transform as a vector shape, so rotation, scale and anchor apply to text
//! too. Since 3.18 that outline is an ordinary prepared path
//! (`rasterise::PreparedPaths`): Vello draws it anti-aliased, on the GPU and on
//! the CPU, with the text's fill (a gradient too) and stroke. Advance-width
//! rectangles were a substitution and are gone.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use cosmic_text::{fontdb, Align, Attrs, Buffer, Family, FeatureTag, FontFeatures, FontSystem, Metrics, Shaping, SwashCache};
use gx_contracts::font::{FontDefinition, FontLoadStatus, FontSource, FontStyle};
use gx_contracts::scene::{
    AssetKind, SceneDocument, SceneObject, TextAutoFit, TextCase, TextDirection, TextLayout, VerticalAlign, WritingMode,
};
use gx_contracts::text_animator::{TextRangeBasis, TextRangeSelector};
use gx_contracts::Refusal;
use swash::zeno::{Command, Point as OutlinePoint};
use vello_cpu::kurbo::{Affine, BezPath, Point, Rect, Shape, Vec2};

use crate::mesh::AssetBytes;

/// One glyph positioned by the scene's declared fonts.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedGlyph {
    pub face_id: String,
    pub glyph_id: u16,
    /// Shaper byte offsets are local to the input line.
    pub source_line: usize,
    pub source_start: usize,
    pub source_end: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub bidi_level: u8,
    outline_span: std::ops::Range<usize>,
    decoration_span: std::ops::Range<usize>,
    word_start: Option<usize>,
    layout_line: usize,
}

impl PreparedGlyph {
    fn selection_unit(&self, basis: TextRangeBasis) -> Option<(usize, usize)> {
        match basis {
            TextRangeBasis::Characters => Some((self.source_line, self.source_start)),
            TextRangeBasis::CharactersExcludingSpaces => self.word_start.map(|_| (self.source_line, self.source_start)),
            TextRangeBasis::Words => self.word_start.map(|start| (self.source_line, start)),
            TextRangeBasis::Lines => Some((self.layout_line, 0)),
        }
    }
}

// Word selection uses contiguous non-whitespace runs of the shaped input.
// Byte offsets are relative to its input line, matching cosmic-text glyphs.
fn word_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut words = Vec::new();
    let mut word = None;
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            if let Some(start) = word.take() {
                words.push(start..index);
            }
        } else if word.is_none() {
            word = Some(index);
        }
    }
    if let Some(start) = word {
        words.push(start..text.len());
    }
    words
}

/// One text object after case, bidi, fallback and OpenType shaping.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedTextObject {
    pub object_id: String,
    pub text: String,
    pub glyphs: Vec<PreparedGlyph>,
    pub width: f32,
    pub height: f32,
    pub(crate) visible_height: f32,
    /// How far the hidden columns of vertical text (past `maxLines`) reach in width; 0 for horizontal text, whose hidden lines are
    /// `height - visible_height`.
    pub(crate) hidden_width: f32,
    /// Whether the text is set in vertical columns (11.51): the animator's tracking has no meaning there and is refused.
    pub(crate) vertical: bool,
    line_count: usize,
    /// Every glyph's outline, built once at publish, in the text's own
    /// coordinates (origin at the box's top-left, y down), filled non-zero.
    pub outline: BezPath,
    pub(crate) decoration: BezPath,
}

/// Per-cluster geometry at full selection. Partial selection interpolates
/// from the identity transform to these translation, scale and rotation values.
#[derive(Debug, Clone, Copy)]
pub struct GlyphTransform {
    pub translation: [f64; 2],
    pub scale: f64,
    pub rotation_degrees: f64,
    pub tracking: f64,
}

pub(crate) struct AnimatedCluster {
    pub outline: BezPath,
    pub decoration: BezPath,
    pub weight: f64,
}

impl PreparedTextObject {
    /// How many lines the text was laid out in (0 for no glyphs).
    pub fn line_count(&self) -> usize {
        self.line_count
    }

    /// Apply logical range weights to cached glyph outlines. Ligatures and
    /// combining marks always share one transform within their shaped cluster.
    pub fn animated_outline(
        &self,
        selector: &TextRangeSelector,
        transform: GlyphTransform,
    ) -> Result<BezPath, Refusal> {
        let mut outline = BezPath::new();
        for cluster in self.animated_clusters(selector, transform)? {
            for element in cluster.outline.elements() {
                outline.push(*element);
            }
        }
        Ok(outline)
    }

    pub(crate) fn animated_clusters(
        &self,
        selector: &TextRangeSelector,
        transform: GlyphTransform,
    ) -> Result<Vec<AnimatedCluster>, Refusal> {
        let refuse = |detail: &str| Refusal::ScenePropertyNotDrawable {
            object: self.object_id.clone(),
            property: format!("text animator: {detail}"),
            owner: "11.61".into(),
        };
        if ![
            transform.translation[0], transform.translation[1],
            transform.scale, transform.rotation_degrees, transform.tracking,
        ].into_iter().all(f64::is_finite) || transform.scale < 0.0 {
            return Err(refuse("transform needs finite values and nonnegative scale"));
        }
        if self.vertical && transform.tracking != 0.0 {
            return Err(refuse("tracking is not drawn in vertical writing"));
        }

        let cluster_key = |glyph: &PreparedGlyph| (glyph.source_line, glyph.source_start);
        let mut anchors = BTreeMap::new();
        let mut units = BTreeSet::new();
        for glyph in &self.glyphs {
            let anchor = Vec2::new(f64::from(glyph.x), f64::from(glyph.y));
            let unit = glyph.selection_unit(selector.basis.unwrap_or_default());
            units.extend(unit);
            anchors.entry(cluster_key(glyph))
                .and_modify(|(current, _, _): &mut (Vec2, _, _)| current.x = current.x.min(anchor.x))
                .or_insert((anchor, unit, glyph.layout_line));
        }
        let weights = selector.weights(units.len(), &self.object_id).map_err(refuse)?;
        let weights: BTreeMap<_, _> = units.into_iter().zip(weights).collect();
        let mut anchors: Vec<_> = anchors.into_iter().collect();
        if transform.tracking != 0.0 {
            // Apply spacing in visual order, independently on each laid-out line.
            // One shaped cluster contributes once, even when it has multiple glyphs.
            anchors.sort_by(|(_, (a, _, line_a)), (_, (b, _, line_b))| {
                line_a.cmp(line_b).then_with(|| a.x.total_cmp(&b.x))
            });
        }
        let mut previous_line = None;
        let mut tracking_offset = 0.0;
        let transforms: BTreeMap<_, _> = anchors.into_iter()
            .map(|(cluster, (anchor, unit, line))| {
                if previous_line != Some(line) {
                    previous_line = Some(line);
                    tracking_offset = 0.0;
                }
                let weight = unit.map_or(0.0, |unit| weights[&unit]);
                let translation = Vec2::new(transform.translation[0], transform.translation[1]) * weight;
                let scale = (1.0 + (transform.scale - 1.0) * weight).max(0.0);
                let rotation = transform.rotation_degrees.to_radians() * weight;
                let affine = Affine::translate(anchor + translation + Vec2::new(tracking_offset, 0.0))
                    * Affine::rotate(rotation) * Affine::scale(scale) * Affine::translate(-anchor);
                tracking_offset += transform.tracking * weight;
                (cluster, (affine, weight))
            }).collect();
        let mut clusters: Vec<AnimatedCluster> = Vec::new();
        let mut indices = HashMap::new();
        for glyph in &self.glyphs {
            let key = cluster_key(glyph);
            let (affine, weight) = transforms[&key];
            let index = *indices.entry(key).or_insert_with(|| {
                clusters.push(AnimatedCluster { outline: BezPath::new(), decoration: BezPath::new(), weight });
                clusters.len() - 1
            });
            for element in &self.outline.elements()[glyph.outline_span.clone()] {
                clusters[index].outline.push(affine * *element);
            }
            for element in &self.decoration.elements()[glyph.decoration_span.clone()] {
                clusters[index].decoration.push(affine * *element);
            }
        }
        if clusters.iter().any(|cluster| !cluster.outline.is_finite() || !cluster.decoration.is_finite()) {
            return Err(refuse("transform moves the outline outside finite coordinates"));
        }
        Ok(clusters)
    }
}

/// Text-side state built once for a published scene.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreparedTexts {
    pub objects: Vec<PreparedTextObject>,
}

/// Shape every text object without consulting system fonts.
pub fn prepare_texts(
    document: &SceneDocument,
    asset_bytes: &AssetBytes,
) -> Result<PreparedTexts, Refusal> {
    let mut objects = Vec::new();
    for object in &document.objects {
        let SceneObject::Text(text) = object else {
            continue;
        };
        objects.push(prepare_text_object(document, text, asset_bytes)?);
    }
    Ok(PreparedTexts { objects })
}

/// Shape one text object using the scene's declared fonts and asset bytes.
pub(crate) fn prepare_text_object(
    document: &SceneDocument,
    text: &gx_contracts::scene::TextObject,
    asset_bytes: &AssetBytes,
) -> Result<PreparedTextObject, Refusal> {
    let primary = document
        .font(&text.font_id)
        .ok_or_else(|| Refusal::SceneFontUnknown {
            font_id: text.font_id.clone(),
            object: text.base.id.clone(),
        })?;
    if !primary.enabled || primary.status != FontLoadStatus::Ready {
        return Err(Refusal::FontMissing {
            font_id: primary.font_id.clone(),
        });
    }

    let mut definitions = vec![primary];
    // Older imports inserted this exact browser-only default when the author
    // had requested no fallback. Use a packaged face when present.
    let legacy_browser_defaults = primary.fallback_families == ["Arial", "sans-serif"];
    for family in &primary.fallback_families {
        let fallback = document
            .fonts
            .iter()
            .find(|candidate| candidate.enabled && candidate.family == *family);
        let Some(fallback) = fallback else {
            if legacy_browser_defaults {
                continue;
            }
            return Err(Refusal::FontMissing { font_id: family.clone() });
        };
        if fallback.status != FontLoadStatus::Ready {
            return Err(Refusal::FontMissing {
                font_id: fallback.font_id.clone(),
            });
        }
        if !definitions
            .iter()
            .any(|definition| definition.font_id == fallback.font_id)
        {
            definitions.push(fallback);
        }
    }

    shape_object(document, text, &definitions, asset_bytes)
}

fn shape_object(
    document: &SceneDocument,
    text: &gx_contracts::scene::TextObject,
    definitions: &[&FontDefinition],
    asset_bytes: &AssetBytes,
) -> Result<PreparedTextObject, Refusal> {
    // 11.61: counted, so a test can show that a frame of a text animator shapes nothing.
    crate::render_work::text_shaping();
    let mut database = fontdb::Database::new();
    let mut face_names = HashMap::new();
    let mut primary_family = None;

    for definition in definitions {
        load_definition(
            document,
            definition,
            asset_bytes,
            &mut database,
            &mut face_names,
            &mut primary_family,
            definition.font_id == text.font_id,
        )?;
    }

    let primary_family = primary_family.ok_or_else(|| Refusal::FontMissing {
        font_id: text.font_id.clone(),
    })?;
    let mut font_system = FontSystem::new_with_locale_and_db("en-US".into(), database);
    let (source, small) = if text.text_case == TextCase::SmallCaps {
        small_caps(&text.text)
    } else {
        (apply_case(&text.text, text.text_case), Vec::new())
    };
    let shaped_source = apply_direction(&source, text.direction);
    // The direction mark comes before the text, so the small-capital ranges move by its length.
    let lead = if text.direction == TextDirection::Auto { 0 } else { '\u{202a}'.len_utf8() };
    let small: Vec<std::ops::Range<usize>> = small.into_iter().map(|range| range.start + lead..range.end + lead).collect();
    let indent = if text.text_indent.is_finite() && text.text_indent > 0.0 { text.text_indent as f32 } else { 0.0 };
    let (shaped_source, marks) = if indent > 0.0 && !source.trim().is_empty() {
        let space_em = space_advance_em(&mut font_system, &primary_family).filter(|em| *em > 0.0).ok_or_else(|| Refusal::ScenePropertyNotDrawable {
            object: text.base.id.clone(),
            property: "textIndent (the font's space has no width to size the indent from)".into(),
            owner: "11.51".into(),
        })?;
        let (shaped_source, small, indent_marks) = insert_indent_marks(&shaped_source, &small, lead);
        (shaped_source, SourceMarks { small, indent: indent_marks, indent_size: indent / space_em, lead })
    } else {
        (shaped_source, SourceMarks { small, indent: Vec::new(), indent_size: 0.0, lead })
    };
    let mut font_size = finite_positive(text.size, 1.0);
    let mut buffer = layout_buffer(&mut font_system, text, &primary_family, &shaped_source, &marks, font_size)?;
    if text.auto_fit == TextAutoFit::Shrink {
        if exceeds_box(text, measure_buffer(&buffer, text, &marks)) {
            font_size = shrunk_size(&mut font_system, text, &primary_family, &shaped_source, &marks, font_size)?;
            buffer = layout_buffer(&mut font_system, text, &primary_family, &shaped_source, &marks, font_size)?;
        }
    }

    let measured = measure_buffer(&buffer, text, &marks);
    let vertical = is_vertical(text);
    // Vertical align places the lines in the box height (a box that states no height has no room to place them in). Paragraph text is
    // aligned by the shaper at the box width; point text has no wrap width, so each line is placed in the box width here. Vertical
    // text has its own alignment along the column and refuses vertical align (the drawability check).
    let y_offset = match text.vertical_align {
        VerticalAlign::Top => 0.0,
        _ if vertical || !(text.base.height > 0.0) => 0.0,
        VerticalAlign::Middle => (text.base.height as f32 - measured.visible_height) / 2.0,
        VerticalAlign::Bottom => text.base.height as f32 - measured.visible_height,
    };
    let align_factor = match text.align {
        gx_contracts::scene::TextAlign::Left => 0.0,
        gx_contracts::scene::TextAlign::Center => 0.5,
        gx_contracts::scene::TextAlign::Right => 1.0,
    };
    let point_align = if text.layout == TextLayout::Point && text.base.width > 0.0 { align_factor } else { 0.0 };
    let mut glyphs = Vec::new();
    let decoration = if !vertical && (text.decoration.underline || text.decoration.strikethrough) {
        let metrics = font_metrics(&mut font_system, &primary_family).ok_or_else(|| Refusal::FontMissing {
            font_id: text.font_id.clone(),
        })?.scale(font_size);
        [
            text.decoration.underline.then_some(metrics.underline_offset),
            text.decoration.strikethrough.then_some(metrics.strikeout_offset),
        ].map(|offset| offset.map(|offset| (offset, metrics.stroke_size)))
    } else {
        [None; 2]
    };
    let mut outlines = SwashCache::new();
    let mut outline = BezPath::new();
    let mut decoration_outline = BezPath::new();
    let baseline_shift = text.baseline_shift.unwrap_or_default() as f32;
    let word_start_of = |words: &[std::ops::Range<usize>], start: usize| {
        words.get(words.partition_point(|word| word.end <= start)).filter(|word| word.contains(&start)).map(|word| word.start)
    };

    // Where every glyph goes, in the text's own coordinates: laid out in lines (horizontal) or in columns (vertical).
    let mut placed: Vec<Placed> = Vec::new();
    if vertical {
        let columns = vertical_columns(&buffer, text, &marks);
        let step = buffer.metrics().line_height;
        // The first column of `vertical-rl` is at the right edge of the box (of the visible columns, when the box states no width).
        let reference_width = if text.base.width > 0.0 { text.base.width as f32 } else { measured.visible_height };
        let inline_box = if text.base.height > 0.0 { text.base.height as f32 } else { 0.0 };
        // An upright glyph sits with its em box centred in its cell: the baseline is half the ascent less the descent below the centre.
        let central = font_metrics(&mut font_system, &primary_family)
            .filter(|metrics| metrics.units_per_em > 0)
            .map_or(0.0, |metrics| (metrics.ascent - metrics.descent) / (2.0 * f32::from(metrics.units_per_em)));
        for (column_index, column) in columns.iter().enumerate() {
            let words = word_ranges(column.source);
            let block_top = column_index as f32 * step + column.paragraph as f32 * text.paragraph_spacing as f32;
            let column_left = match text.writing_mode {
                WritingMode::VerticalRl => reference_width - (block_top + step),
                _ => block_top,
            };
            let centre = column_left + step / 2.0;
            let inline_offset = if inline_box > 0.0 { align_factor * (inline_box - column.extent) } else { 0.0 };
            for cell in &column.cells {
                // The indent marks are only room: never drawn, selected or counted.
                if cell.indent {
                    continue;
                }
                let glyph = cell.glyph;
                let glyph_x = centre - glyph.w / 2.0;
                let glyph_y = inline_offset + cell.top + cell.advance / 2.0 + central * glyph.font_size;
                placed.push(Placed {
                    glyph,
                    line_i: column.paragraph,
                    layout_line: column_index,
                    glyph_x,
                    glyph_y,
                    pen_x: glyph_x + glyph.font_size * glyph.x_offset,
                    pen_y: glyph_y - glyph.font_size * glyph.y_offset,
                    baseline: glyph_y,
                    word_start: word_start_of(&words, glyph.start),
                });
            }
        }
    } else {
        let mut words = Vec::new();
        let mut source_line = None;
        for (layout_line, run) in buffer.layout_runs().enumerate() {
            if source_line != Some(run.line_i) {
                source_line = Some(run.line_i);
                words = word_ranges(run.text);
            }
            let paragraph_offset = run.line_i as f32 * text.paragraph_spacing as f32;
            let x_offset = point_align * (text.base.width as f32 - run.line_w);
            for glyph in run.glyphs {
                // The indent marks are only room: a leading space sized to the indent, never drawn, selected or counted.
                // Glyph offsets are within the paragraph: its mark is the first character, after the direction mark on the first paragraph.
                if !marks.indent.is_empty() && glyph.start == if run.line_i == 0 { lead } else { 0 } && glyph.end == glyph.start + 1 {
                    continue;
                }
                let glyph_y = run.line_y + glyph.y - baseline_shift + y_offset + paragraph_offset;
                let glyph_x = glyph.x + x_offset;
                placed.push(Placed {
                    glyph,
                    line_i: run.line_i,
                    layout_line,
                    glyph_x,
                    glyph_y,
                    // The glyph's pen position, as cosmic-text places it.
                    pen_x: glyph_x + glyph.font_size * glyph.x_offset,
                    pen_y: glyph_y - glyph.font_size * glyph.y_offset,
                    baseline: run.line_y - baseline_shift + y_offset + paragraph_offset,
                    word_start: word_start_of(&words, glyph.start),
                });
            }
        }
    }

    for item in &placed {
        let glyph = item.glyph;
        let Some(face_id) = face_names.get(&glyph.font_id) else {
            return Err(Refusal::FontMissing {
                font_id: text.font_id.clone(),
            });
        };
        if glyph.glyph_id == 0 {
            return Err(Refusal::FontMissing {
                font_id: text.font_id.clone(),
            });
        }
        if text.max_lines.is_some_and(|limit| item.layout_line >= limit as usize) {
            continue;
        }
        let key = glyph.physical((0.0, 0.0), 1.0).cache_key;
        let Some(commands) = outlines.get_outline_commands(&mut font_system, key) else {
            return Err(Refusal::ScenePropertyNotDrawable {
                object: text.base.id.clone(),
                property: format!("glyph {} has no outline", glyph.glyph_id),
                owner: "11.51".into(),
            });
        };
        let outline_start = outline.elements().len();
        append_outline(&mut outline, commands, item.pen_x, item.pen_y);
        let decoration_start = decoration_outline.elements().len();
        if glyph.w > 0.0 {
            for (offset, thickness) in decoration.into_iter().flatten() {
                if thickness > 0.0 {
                    let top = item.baseline - offset;
                    let bar = Rect::new(
                        f64::from(item.glyph_x),
                        f64::from(top),
                        f64::from(item.glyph_x + glyph.w),
                        f64::from(top + thickness),
                    );
                    decoration_outline.extend(bar.path_elements(0.0));
                }
            }
        }
        glyphs.push(PreparedGlyph {
            face_id: face_id.clone(),
            glyph_id: glyph.glyph_id,
            source_line: item.line_i,
            source_start: glyph.start,
            source_end: glyph.end,
            x: item.glyph_x,
            y: item.glyph_y,
            width: glyph.w,
            bidi_level: glyph.level.number(),
            outline_span: outline_start..outline.elements().len(),
            decoration_span: decoration_start..decoration_outline.elements().len(),
            word_start: item.word_start,
            layout_line: item.layout_line,
        });
    }

    // The measurement is in the text's own terms (line length, then the lines stacked); the object reports width and height. In vertical
    // text the columns stack along the width and the column length is the height.
    let (width, height, visible_height, hidden_width) = if vertical {
        (measured.height, measured.width, measured.width, measured.height - measured.visible_height)
    } else {
        (measured.width, measured.height, measured.visible_height, 0.0)
    };
    Ok(PreparedTextObject {
        object_id: text.base.id.clone(),
        text: source,
        glyphs,
        width,
        height,
        visible_height,
        hidden_width,
        vertical,
        line_count: measured.lines,
        outline,
        decoration: decoration_outline,
    })
}

/// One glyph, placed: where it is in the text's own coordinates and which line (or column) it is in.
struct Placed<'a> {
    glyph: &'a cosmic_text::LayoutGlyph,
    line_i: usize,
    layout_line: usize,
    glyph_x: f32,
    glyph_y: f32,
    pen_x: f32,
    pen_y: f32,
    /// The baseline of its line, for the underline and strikethrough (horizontal text only).
    baseline: f32,
    word_start: Option<usize>,
}

fn is_vertical(text: &gx_contracts::scene::TextObject) -> bool {
    text.writing_mode != WritingMode::HorizontalTb
}

/// One glyph's cell in a vertical column: how far down the column it starts and how much room it takes.
struct VerticalCell<'a> {
    glyph: &'a cosmic_text::LayoutGlyph,
    top: f32,
    advance: f32,
    /// The paragraph's indent mark: room only.
    indent: bool,
}

/// One column of vertical text, top to bottom.
struct VerticalColumn<'a> {
    /// The paragraph (source line) the column belongs to.
    paragraph: usize,
    source: &'a str,
    cells: Vec<VerticalCell<'a>>,
    /// The column's length: the cells' advances added up.
    extent: f32,
}

/// Vertical text (11.51) is set **upright**: every character takes a square cell of its own size down the column (a space and the indent
/// take their own width), and a column breaks between any two characters where the next cell would pass the box height (point text has no
/// height to break at). The glyphs are shaped as one line per paragraph with the font's `vert` and `vrt2` features on, so punctuation takes
/// its vertical form; sideways Latin and the font's vertical metrics (`vmtx`) are not used.
fn vertical_columns<'a>(buffer: &'a Buffer, text: &gx_contracts::scene::TextObject, marks: &SourceMarks) -> Vec<VerticalColumn<'a>> {
    let limit = if text.layout == TextLayout::Paragraph && text.base.height > 0.0 { text.base.height as f32 } else { f32::INFINITY };
    let tracking = (text.letter_spacing / 1000.0) as f32;
    let mut columns = Vec::new();
    for run in buffer.layout_runs() {
        let new_column = || VerticalColumn { paragraph: run.line_i, source: run.text, cells: Vec::new(), extent: 0.0 };
        let mut column = new_column();
        let mut previous_start = None;
        for glyph in run.glyphs {
            let indent = !marks.indent.is_empty() && glyph.start == if run.line_i == 0 { marks.lead } else { 0 } && glyph.end == glyph.start + 1;
            // A glyph of the same cluster as the one before (a mark on its base) shares that cell.
            let shares_cell = previous_start == Some(glyph.start) && !column.cells.is_empty();
            previous_start = Some(glyph.start);
            let (top, advance) = if shares_cell {
                (column.cells.last().map_or(0.0, |cell| cell.top), 0.0)
            } else {
                let space = run.text.get(glyph.start..glyph.end).is_some_and(|cluster| cluster.chars().all(char::is_whitespace));
                let advance = if indent || space { glyph.w } else { (glyph.font_size * (1.0 + tracking)).max(0.0) };
                if !column.cells.is_empty() && column.extent + advance > limit + 0.001 {
                    columns.push(std::mem::replace(&mut column, new_column()));
                }
                let top = column.extent;
                column.extent += advance;
                (top, advance)
            };
            column.cells.push(VerticalCell { glyph, top, advance, indent });
        }
        columns.push(column);
    }
    columns
}

/// Rounding slack, in scene units, absorbed before a shaped text counts as bigger than its box. The record check (`fit.rs`) uses the same
/// number, so a text that auto-fit drew inside its box is one the check reports as fitting.
pub(crate) const FIT_SLACK: f64 = 0.5;

/// Whether shaped text of this measured size is bigger than its box, in the directions its layout does not grow: **paragraph** text wraps
/// at the box width, so only its height is compared (a box height of 0 states no height); **point** text never wraps, so only its width is
/// compared (a box width of 0 states no width). `autoFit: fit` grows the box to the text, so it never exceeds.
fn exceeds_box(text: &gx_contracts::scene::TextObject, measured: TextMeasurement) -> bool {
    if text.auto_fit == TextAutoFit::Fit {
        return false;
    }
    // `measured` is in line terms (length, then the lines stacked); the box is in width and height.
    let (width, height) = if is_vertical(text) { (measured.height, measured.width) } else { (measured.width, measured.height) };
    measured.height > measured.visible_height || exceeds_box_by(text, f64::from(width), f64::from(height)) != (0.0, 0.0)
}

/// How far shaped text is over its box in width and in height (0 where it is not over, or where the box states no size).
pub(crate) fn exceeds_box_by(text: &gx_contracts::scene::TextObject, width: f64, height: f64) -> (f64, f64) {
    let (box_width, box_height) = (text.base.width, text.base.height);
    if is_vertical(text) {
        // Columns stack along the width and run down the height: paragraph text breaks at the box height, so only its width (the
        // columns) is compared there; the length of a column is compared against the box height whatever the layout.
        let over_height = if box_height > 0.0 && height > box_height + FIT_SLACK { height - box_height } else { 0.0 };
        let wide = text.layout == TextLayout::Paragraph && box_width > 0.0 && width > box_width + FIT_SLACK;
        return (if wide { width - box_width } else { 0.0 }, over_height);
    }
    let over_width = if box_width > 0.0 && width > box_width + FIT_SLACK { width - box_width } else { 0.0 };
    let tall = text.layout == TextLayout::Paragraph && box_height > 0.0 && height > box_height + FIT_SLACK;
    let over_height = if tall { height - box_height } else { 0.0 };
    (over_width, over_height)
}

/// Lay out the text at `size`. The line height follows the size (a multiple of it, or the face's own metrics at that size).
fn layout_buffer(
    font_system: &mut FontSystem,
    text: &gx_contracts::scene::TextObject,
    primary_family: &str,
    shaped_source: &str,
    marks: &SourceMarks,
    size: f32,
) -> Result<Buffer, Refusal> {
    let small = &marks.small[..];
    let line_height = match text.line_height {
        Some(multiple) => finite_positive(multiple * f64::from(size), size),
        // Absent means the font's own metrics (the contract), not 1.2 × size.
        None => font_line_height(font_system, primary_family, size).ok_or_else(|| Refusal::FontMissing {
            font_id: text.font_id.clone(),
        })?,
    };
    let mut buffer = Buffer::new(font_system, Metrics::new(size, line_height));
    let (width, height) = match text.layout {
        TextLayout::Point => (None, None),
        // Vertical text breaks its own columns at the box height (`vertical_columns`), so the shaper keeps each paragraph on one line.
        TextLayout::Paragraph if is_vertical(text) => (None, None),
        // Keep the complete layout for fit measurement; paint clips afterward.
        TextLayout::Paragraph => (Some(finite_non_negative(text.base.width)), None),
    };
    buffer.set_size(font_system, width, height);
    let mut attrs = Attrs::new().family(Family::Name(primary_family));
    let mut features = FontFeatures::new();
    let mut featured = false;
    if text.kerning == Some(false) {
        features.disable(FeatureTag::KERNING);
        featured = true;
    }
    if is_vertical(text) {
        // The font's vertical forms: punctuation and brackets turned for a column.
        features.enable(FeatureTag::new(b"vert"));
        features.enable(FeatureTag::new(b"vrt2"));
        featured = true;
    }
    if featured {
        attrs = attrs.font_features(features);
    }
    if text.letter_spacing != 0.0 {
        // The contract's tracking is in thousandths of an em; cosmic-text's is
        // in em.
        attrs = attrs.letter_spacing((text.letter_spacing / 1000.0) as f32);
    }
    let align = match text.align {
        gx_contracts::scene::TextAlign::Left => Some(Align::Left),
        gx_contracts::scene::TextAlign::Center => Some(Align::Center),
        gx_contracts::scene::TextAlign::Right => Some(Align::Right),
    };
    if text.word_spacing == 0.0 && small.is_empty() && marks.indent.is_empty() {
        buffer.set_text(font_system, shaped_source, &attrs, Shaping::Advanced, align);
    } else {
        // Spans change where the text crosses a space (word spacing) or a small capital (a smaller size on the same line height).
        let space_em = text.letter_spacing / 1000.0 + text.word_spacing / f64::from(size);
        let space_attrs = attrs.clone().letter_spacing(space_em as f32);
        let small_metrics = Metrics::new(size * SMALL_CAP_SCALE, line_height);
        // An indent mark is a space with no tracking, drawn at the size whose space is as wide as the indent, on the unchanged line height.
        let indent_metrics = Metrics::new(marks.indent_size, line_height);
        let style_of = |space: bool, is_small: bool, indent: bool| {
            if indent {
                return attrs.clone().letter_spacing(0.0).metrics(indent_metrics);
            }
            let style = if space { space_attrs.clone() } else { attrs.clone() };
            if is_small { style.metrics(small_metrics) } else { style }
        };
        let is_small = |index: usize| small.iter().any(|range| range.contains(&index));
        let is_indent = |index: usize| marks.indent.iter().any(|range| range.contains(&index));
        let mut spans = Vec::new();
        let mut start = 0;
        let mut was = (false, false, false);
        for (index, character) in shaped_source.char_indices() {
            let space = matches!(character, ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}');
            let now = (space, is_small(index), is_indent(index));
            if now != was {
                if index > start {
                    spans.push((&shaped_source[start..index], style_of(was.0, was.1, was.2)));
                }
                start = index;
                was = now;
            }
        }
        spans.push((&shaped_source[start..], style_of(was.0, was.1, was.2)));
        buffer.set_rich_text(font_system, spans, &attrs, Shaping::Advanced, align);
    }
    Ok(buffer)
}

#[derive(Default)]
struct TextMeasurement {
    width: f32,
    height: f32,
    visible_height: f32,
    lines: usize,
}

/// The text's size in line terms: `width` is the longest line (a column's length in vertical text), `height` the lines stacked
/// (the columns' total width in vertical text).
fn measure_buffer(buffer: &Buffer, text: &gx_contracts::scene::TextObject, marks: &SourceMarks) -> TextMeasurement {
    let mut measured = TextMeasurement::default();
    if is_vertical(text) {
        let step = buffer.metrics().line_height;
        for (index, column) in vertical_columns(buffer, text, marks).iter().enumerate() {
            let bottom = (index + 1) as f32 * step + column.paragraph as f32 * text.paragraph_spacing as f32;
            measured.width = measured.width.max(column.extent);
            measured.height = measured.height.max(bottom);
            if text.max_lines.is_none_or(|limit| measured.lines < limit as usize) {
                measured.visible_height = measured.visible_height.max(bottom);
            }
            measured.lines += 1;
        }
        return measured;
    }
    for run in buffer.layout_runs() {
        let bottom = run.line_top + run.line_height + run.line_i as f32 * text.paragraph_spacing as f32;
        measured.width = measured.width.max(run.line_w);
        measured.height = measured.height.max(bottom);
        if text.max_lines.is_none_or(|limit| measured.lines < limit as usize) {
            measured.visible_height = measured.visible_height.max(bottom);
        }
        measured.lines += 1;
    }
    measured
}

/// The smallest size an auto-fit text is shrunk to. The contract has no floor field yet, so this is the shaper's own: below one unit
/// there is nothing to read, and a text that still overflows there is reported as overflowing by the record check.
const SHRINK_FLOOR: f32 = 1.0;

/// The largest size at or below `from` at which the text fits its box, found by bisection (the same shaping at every probe, so the
/// answer is a pure function of the text, the font and the box). A text that does not fit even at the floor is drawn at the floor.
fn shrunk_size(
    font_system: &mut FontSystem,
    text: &gx_contracts::scene::TextObject,
    primary_family: &str,
    shaped_source: &str,
    marks: &SourceMarks,
    from: f32,
) -> Result<f32, Refusal> {
    let floor = SHRINK_FLOOR.min(from);
    let fits = |font_system: &mut FontSystem, size: f32| -> Result<bool, Refusal> {
        let buffer = layout_buffer(font_system, text, primary_family, shaped_source, marks, size)?;
        Ok(!exceeds_box(text, measure_buffer(&buffer, text, marks)))
    };
    if !fits(font_system, floor)? {
        return Ok(floor);
    }
    let (mut low, mut high) = (floor, from);
    for _ in 0..24 {
        let middle = (low + high) / 2.0;
        if fits(font_system, middle)? {
            low = middle;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

/// Append a glyph outline in the text's own coordinates. Outlines are y-up
/// from the glyph's pen position; text space is y-down from the box's
/// top-left.
fn append_outline(out: &mut BezPath, commands: &[Command], pen_x: f32, pen_y: f32) {
    let at = |p: OutlinePoint| Point::new(f64::from(pen_x + p.x), f64::from(pen_y - p.y));
    let mut open = false;
    for command in commands {
        match *command {
            Command::MoveTo(p) => {
                out.move_to(at(p));
                open = true;
            }
            Command::LineTo(p) if open => out.line_to(at(p)),
            Command::QuadTo(c, p) if open => out.quad_to(at(c), at(p)),
            Command::CurveTo(c1, c2, p) if open => out.curve_to(at(c1), at(c2), at(p)),
            Command::Close if open => {
                out.close_path();
                open = false;
            }
            _ => {}
        }
    }
}

/// The primary face's own line spacing in pixels at `size`: ascent plus
/// descent plus line gap, which is what the contract means by an absent
/// line height.
fn font_line_height(font_system: &mut FontSystem, family: &str, size: f32) -> Option<f32> {
    let metrics = font_metrics(font_system, family)?;
    let units = f32::from(metrics.units_per_em);
    (units > 0.0).then(|| (metrics.ascent + metrics.descent + metrics.leading) / units * size)
}

fn font_metrics(font_system: &mut FontSystem, family: &str) -> Option<swash::Metrics> {
    let families = [fontdb::Family::Name(family)];
    let query = fontdb::Query {
        families: &families,
        ..fontdb::Query::default()
    };
    let id = font_system.db().query(&query)?;
    let font = font_system.get_font(id, fontdb::Weight::NORMAL)?;
    Some(font.as_swash().metrics(&[]))
}

#[allow(clippy::too_many_arguments)]
fn load_definition(
    document: &SceneDocument,
    definition: &FontDefinition,
    asset_bytes: &AssetBytes,
    database: &mut fontdb::Database,
    face_names: &mut HashMap<fontdb::ID, String>,
    primary_family: &mut Option<String>,
    is_primary: bool,
) -> Result<(), Refusal> {
    if definition.faces.is_empty() {
        return Err(Refusal::FontMissing {
            font_id: definition.font_id.clone(),
        });
    }
    for face in &definition.faces {
        if face
            .status
            .is_some_and(|status| status != FontLoadStatus::Ready)
        {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        }
        let FontSource::File { asset_id, .. } = &face.source else {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        };
        let asset = document
            .asset(asset_id)
            .ok_or_else(|| Refusal::SceneAssetUnknown {
                asset_id: asset_id.clone(),
                object: definition.font_id.clone(),
            })?;
        if asset.kind != AssetKind::Font {
            return Err(Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            });
        }
        let hash = asset
            .checksum
            .as_ref()
            .ok_or_else(|| Refusal::FontMissing {
                font_id: definition.font_id.clone(),
            })?;
        let bytes = asset_bytes
            .get(hash)
            .ok_or_else(|| Refusal::AssetMissing { hash: hash.clone() })?;
        // WOFF/WOFF2 are delivery wrappers; fontdb reads only sfnt. The
        // container module is the one decoder the ingest path also verified
        // with, so a font that ingested is a font that loads here.
        let sfnt: Arc<Vec<u8>> =
            Arc::new(gx_asset_plane::fonts::container::sfnt_bytes(bytes)?.into_owned());
        let mut ids: Vec<fontdb::ID> = database
            .load_font_source(fontdb::Source::Binary(sfnt.clone()))
            .into_iter()
            .collect();
        if ids.is_empty() {
            // fontdb refuses a face that names no family; the bytes must
            // still be a font before the declaration may name them.
            gx_asset_plane::fonts::metadata::inspect_declared_font(&sfnt, &face.family).map_err(
                |_| Refusal::InvalidFontData {
                    detail: format!("font {} contains no readable face", face.face_id),
                },
            )?;
            ids.push(declared_face(
                database,
                None,
                fontdb::Source::Binary(sfnt.clone()),
                face,
            )?);
        }
        for id in ids {
            let named = database
                .face(id)
                .and_then(|info| info.families.first())
                .map(|family| family.0.trim().to_owned())
                .filter(|family| !family.is_empty());
            let (id, loaded_family) = match named {
                Some(family) => (id, family),
                None => {
                    let source = fontdb::Source::Binary(sfnt.clone());
                    (
                        declared_face(database, Some(id), source, face)?,
                        face.family.trim().to_owned(),
                    )
                }
            };
            if is_primary && primary_family.is_none() {
                *primary_family = Some(loaded_family);
            }
            face_names.insert(id, face.face_id.clone());
        }
    }
    Ok(())
}

/// File a face under the family its definition declares, when its file names
/// none. Adobe Fonts kit files carry an empty family name (the kit's
/// stylesheet declares it): fontdb refuses a face with no name at all, and
/// would file every blank-named face under the same empty family, where one
/// font's text could be drawn in another's face. Weight and style come from
/// the declaration as well, as the stylesheet stated them.
fn declared_face(
    database: &mut fontdb::Database,
    loaded: Option<fontdb::ID>,
    source: fontdb::Source,
    face: &gx_contracts::font::FontFaceDefinition,
) -> Result<fontdb::ID, Refusal> {
    let family = face.family.trim();
    if family.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: format!("font {} carries no family name", face.face_id),
        });
    }
    let existing = loaded.and_then(|id| {
        let info = database.face(id).cloned();
        database.remove_face(id);
        info
    });
    let mut info = existing.unwrap_or(fontdb::FaceInfo {
        id: fontdb::ID::dummy(),
        source,
        index: 0,
        families: Vec::new(),
        post_script_name: String::new(),
        style: fontdb::Style::Normal,
        weight: fontdb::Weight::NORMAL,
        stretch: fontdb::Stretch::Normal,
        monospaced: false,
    });
    info.families = vec![(family.to_owned(), fontdb::Language::English_UnitedStates)];
    info.post_script_name = family.replace(' ', "-");
    info.weight = fontdb::Weight(face.weight);
    info.style = match face.style {
        FontStyle::Normal => fontdb::Style::Normal,
        FontStyle::Italic => fontdb::Style::Italic,
        FontStyle::Oblique => fontdb::Style::Oblique,
    };
    Ok(database.push_face_info(info))
}

/// What the shaped source carries beyond its characters: the byte ranges drawn as small capitals, and the indent marks.
struct SourceMarks {
    small: Vec<std::ops::Range<usize>>,
    /// One space per paragraph start, inserted into the shaped source and sized so its advance is the first-line indent.
    indent: Vec<std::ops::Range<usize>>,
    /// The font size at which a space is as wide as the indent.
    indent_size: f32,
    /// Bytes of direction mark before the first paragraph's text.
    lead: usize,
}

/// The advance of a space in the family, in em: the indent marks are sized from it.
fn space_advance_em(font_system: &mut FontSystem, family: &str) -> Option<f32> {
    let mut buffer = Buffer::new(font_system, Metrics::new(100.0, 100.0));
    buffer.set_size(font_system, None, None);
    buffer.set_text(font_system, " ", &Attrs::new().family(Family::Name(family)), Shaping::Advanced, None);
    buffer.layout_runs().next().and_then(|run| run.glyphs.first().map(|glyph| glyph.w / 100.0))
}

/// The text with an indent mark (a space) at the start of every paragraph: after the direction mark `first`, and after each newline. Gives the
/// marks' byte ranges in the result, and the small-capital ranges moved to match.
fn insert_indent_marks(
    text: &str,
    small: &[std::ops::Range<usize>],
    first: usize,
) -> (String, Vec<std::ops::Range<usize>>, Vec<std::ops::Range<usize>>) {
    let mut starts = vec![first];
    starts.extend(text.char_indices().filter(|(_, character)| *character == '\n').map(|(index, _)| index + 1));
    let mut shaped = String::with_capacity(text.len() + starts.len());
    let mut marks = Vec::new();
    let mut last = 0;
    for &at in &starts {
        shaped.push_str(&text[last..at]);
        marks.push(shaped.len()..shaped.len() + 1);
        shaped.push(' ');
        last = at;
    }
    shaped.push_str(&text[last..]);
    let moved_start = |x: usize| x + starts.iter().filter(|&&at| at <= x).count();
    let moved_end = |x: usize| x + starts.iter().filter(|&&at| at < x).count();
    let small = small.iter().map(|range| moved_start(range.start)..moved_end(range.end)).collect();
    (shaped, small, marks)
}

/// Small capitals are drawn at this share of the size: the capital of a lowercase letter, smaller. The rule is the shaper's own, since the
/// engine does not read a font's `smcp` table (a font without one would draw nothing).
const SMALL_CAP_SCALE: f32 = 0.8;

/// The text with every lowercase letter replaced by its capital, and the byte ranges of those letters in the result.
fn small_caps(text: &str) -> (String, Vec<std::ops::Range<usize>>) {
    let mut result = String::with_capacity(text.len());
    let mut small = Vec::new();
    for character in text.chars() {
        if character.is_lowercase() {
            let start = result.len();
            result.extend(character.to_uppercase());
            small.push(start..result.len());
        } else {
            result.push(character);
        }
    }
    (result, small)
}

fn apply_case(text: &str, text_case: TextCase) -> String {
    match text_case {
        TextCase::Original | TextCase::SmallCaps => text.to_owned(),
        TextCase::Upper => text.to_uppercase(),
        TextCase::Lower => text.to_lowercase(),
        TextCase::Title => text
            .split_inclusive(char::is_whitespace)
            .map(|word| {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect(),
    }
}

fn apply_direction(text: &str, direction: TextDirection) -> String {
    match direction {
        TextDirection::Auto => text.to_owned(),
        TextDirection::Ltr => format!("\u{202a}{text}\u{202c}"),
        TextDirection::Rtl => format!("\u{202b}{text}\u{202c}"),
    }
}

fn finite_positive(value: f64, fallback: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.min(f32::MAX as f64) as f32
    } else {
        fallback
    }
}

fn finite_non_negative(value: f64) -> f32 {
    if value.is_finite() && value > 0.0 {
        value.min(f32::MAX as f64) as f32
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::font::{EmbeddingPolicy, FontFaceDefinition, FontFormat};
    use gx_contracts::scene::{
        AssetLibraryItem, ObjectBase, SceneCanvas, SceneTimeline, TextObject,
    };
    use gx_contracts::ContentHash;
    use gx_contracts::{RationalRate, Revision};

    const INTER: &[u8] = include_bytes!("../tests/fixtures/Inter-Regular.ttf");
    const HEBREW: &[u8] = include_bytes!("../tests/fixtures/NotoSansHebrew.ttf");

    fn font(id: &str, family: &str, asset_id: &str, fallbacks: Vec<String>) -> FontDefinition {
        FontDefinition {
            font_id: id.into(),
            family: family.into(),
            display_name: family.into(),
            faces: vec![FontFaceDefinition {
                face_id: format!("{id}-regular"),
                family: family.into(),
                weight: 400,
                style: FontStyle::Normal,
                stretch: None,
                unicode_range: None,
                source: FontSource::File {
                    asset_id: asset_id.into(),
                    format: FontFormat::Ttf,
                    original_url: None,
                    stylesheet_url: None,
                },
                status: Some(FontLoadStatus::Ready),
                error_message: None,
            }],
            fallback_families: fallbacks,
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    fn text_object(value: &str, font_id: &str) -> SceneObject {
        let mut base = ObjectBase::new("title", "Title");
        base.width = 800.0;
        base.height = 120.0;
        SceneObject::Text(TextObject {
            base,
            text: value.into(),
            font_id: font_id.into(),
            size: 48.0,
            layout: TextLayout::Paragraph,
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: TextDirection::Auto,
            text_case: TextCase::Original,
            decoration: Default::default(),
            overflow: Default::default(),
            max_lines: None,
            kerning: None,
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
            baseline_shift: None,
            text_animator: None,
        })
    }

    fn scene(value: &str, font_id: &str, fonts: Vec<FontDefinition>) -> SceneDocument {
        let assets = fonts
            .iter()
            .flat_map(|font| font.faces.iter())
            .filter_map(|face| match &face.source {
                FontSource::File { asset_id, .. } => Some(AssetLibraryItem {
                    asset_id: asset_id.clone(),
                    name: asset_id.clone(),
                    kind: AssetKind::Font,
                    path: format!("assets/{asset_id}.ttf"),
                    checksum: Some(ContentHash(asset_id.clone())),
                    mime_type: Some("font/ttf".into()),
                    size_bytes: None,
                    status: None,
                    provenance: Default::default(),
                    color_space: None,
                }),
                _ => None,
            })
            .collect();
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            color_depth: gx_contracts::color::ColorDepth::BEFORE_DEPTH,
            id: "text-scene".into(),
            name: "Text scene".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 1,
                ..Default::default()
            },
            data_context: Default::default(),
            assets,
            fonts,
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            path_links: Vec::new(),
            guides: Vec::new(),
            scene_label: None,
            objects: vec![text_object(value, font_id)],
        }
    }

    /// A scene with one Inter text of `layout` in a `width` by `height` box, with `auto_fit`, at size 48.
    fn fitted(value: &str, layout: TextLayout, width: f64, height: f64, auto_fit: TextAutoFit) -> (SceneDocument, AssetBytes) {
        let mut document = scene(value, "inter", vec![font("inter", "Inter", "inter", Vec::new())]);
        let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
        text.layout = layout;
        text.base.width = width;
        text.base.height = height;
        text.auto_fit = auto_fit;
        (document, AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]))
    }

    fn shaped(document: &SceneDocument, bytes: &AssetBytes) -> PreparedTextObject {
        prepare_texts(document, bytes).expect("shapes").objects.remove(0)
    }

    #[test]
    fn text_overflow_clips_ink_at_the_authored_box_edge() {
        use gx_contracts::scene::TextOverflow;
        let clip = |overflow| {
            let (scene, bytes) = white_text("MMMM", 100.0, |text| {
                text.layout = TextLayout::Point;
                text.base.width = 132.0;
                text.base.height = 0.0;
                text.overflow = overflow;
            });
            lit_area(&scene, &bytes)
        };
        let (visible, visible_bounds) = clip(TextOverflow::Visible);
        let (clipped, clipped_bounds) = clip(TextOverflow::Clip);
        assert!(clipped > 0 && clipped < visible);
        assert!(visible_bounds[2] >= 732.0);
        assert!(clipped_bounds[2] < 732.0);
        assert_eq!(clip(TextOverflow::Hidden), (clipped, clipped_bounds));
    }

    #[test]
    fn underline_and_strikeout_add_ink_without_changing_the_layout() {
        let (base, bytes) = white_text("A A", 100.0, |_| {});
        let plain = shaped(&base, &bytes);
        let plain_pixels = lit_area(&base, &bytes).0;
        for underline in [true, false] {
            let (decorated, _) = white_text("A A", 100.0, |text| {
                text.decoration.underline = underline;
                text.decoration.strikethrough = !underline;
            });
            let decorated_layout = shaped(&decorated, &bytes);
            assert_eq!((decorated_layout.width, decorated_layout.height), (plain.width, plain.height));
            assert!(lit_area(&decorated, &bytes).0 > plain_pixels);
        }
    }

    #[test]
    fn word_spacing_adds_advance_to_spaces_without_rewriting_text() {
        let (base, bytes) = white_text("AB CD EF", 60.0, |_| {});
        let (spaced, _) = white_text("AB CD EF", 60.0, |text| text.word_spacing = 12.0);
        let base = shaped(&base, &bytes);
        let spaced = shaped(&spaced, &bytes);
        assert_eq!(spaced.text, base.text);
        assert!((spaced.width - base.width - 24.0).abs() < 0.001);
    }

    #[test]
    fn kerning_switch_changes_pair_advance_without_changing_glyphs() {
        let (automatic, bytes) = white_text("AVAV", 100.0, |_| {});
        let (off, _) = white_text("AVAV", 100.0, |text| text.kerning = Some(false));
        let automatic = shaped(&automatic, &bytes);
        let off = shaped(&off, &bytes);
        assert!(automatic.width < off.width);
        assert_eq!(
            automatic.glyphs.iter().map(|glyph| glyph.glyph_id).collect::<Vec<_>>(),
            off.glyphs.iter().map(|glyph| glyph.glyph_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn paragraph_spacing_and_line_cap_share_layout_measurement() {
        let (base, bytes) = white_text("A\nB\nC", 40.0, |_| {});
        let normal = shaped(&base, &bytes);
        let (spaced, _) = white_text("A\nB\nC", 40.0, |text| {
            text.paragraph_spacing = 12.0;
            text.max_lines = Some(2);
        });
        let capped = shaped(&spaced, &bytes);
        assert_eq!(capped.line_count(), 3);
        assert_eq!(capped.glyphs.len(), 2);
        assert_eq!(capped.glyphs[0].y, normal.glyphs[0].y);
        assert!((capped.glyphs[1].y - normal.glyphs[1].y - 12.0).abs() < 0.001);
        assert!((capped.height - normal.height - 24.0).abs() < 0.001);
        assert!(capped.visible_height < capped.height);
    }

    #[test]
    fn auto_fit_shrink_makes_point_text_fit_its_width_and_a_text_that_fits_is_left_alone() {
        let name = "VENKATASUBRAMANIAN IYER SUBRAMANIAM";
        let (fixed, bytes) = fitted(name, TextLayout::Point, 400.0, 60.0, TextAutoFit::None);
        let full = shaped(&fixed, &bytes);
        assert!(f64::from(full.width) > 400.0 + FIT_SLACK, "the fixture must overflow: {}", full.width);
        let (shrink, _) = fitted(name, TextLayout::Point, 400.0, 60.0, TextAutoFit::Shrink);
        let small = shaped(&shrink, &bytes);
        assert!(f64::from(small.width) <= 400.0 + FIT_SLACK, "shrunk text is {} wide in a 400 box", small.width);
        assert!(small.width > 300.0, "it shrinks no more than it must: {}", small.width);
        assert!(small.height < full.height);
        // A text that already fits is exactly what the fixed text is.
        let (fixed_short, _) = fitted("ARJUN RAO", TextLayout::Point, 400.0, 60.0, TextAutoFit::None);
        let (shrink_short, _) = fitted("ARJUN RAO", TextLayout::Point, 400.0, 60.0, TextAutoFit::Shrink);
        assert_eq!(shaped(&fixed_short, &bytes), shaped(&shrink_short, &bytes));
        // Deterministic: two shapings of the same scene are identical.
        assert_eq!(shaped(&shrink, &bytes), small);
    }

    #[test]
    fn auto_fit_shrink_makes_paragraph_text_fit_its_height_and_stops_at_the_floor() {
        let long = "one two three four five six seven eight nine ten eleven twelve";
        let (fixed, bytes) = fitted(long, TextLayout::Paragraph, 300.0, 120.0, TextAutoFit::None);
        assert!(f64::from(shaped(&fixed, &bytes).height) > 120.0 + FIT_SLACK, "the fixture must overflow in height");
        let (shrink, _) = fitted(long, TextLayout::Paragraph, 300.0, 120.0, TextAutoFit::Shrink);
        let small = shaped(&shrink, &bytes);
        assert!(f64::from(small.height) <= 120.0 + FIT_SLACK, "shrunk text is {} tall in a 120 box", small.height);
        // A box too small for anything is drawn at the floor, not refused, and still overflows (the record check says so).
        let (tiny, _) = fitted(long, TextLayout::Paragraph, 4.0, 4.0, TextAutoFit::Shrink);
        let floor = shaped(&tiny, &bytes);
        assert!(f64::from(floor.height) > 4.0 + FIT_SLACK);
        assert!(!floor.glyphs.is_empty());
    }

    #[test]
    fn auto_fit_fit_grows_and_never_scales_and_a_box_without_a_size_checks_nothing() {
        let name = "VENKATASUBRAMANIAN IYER SUBRAMANIAM";
        let (fixed, bytes) = fitted(name, TextLayout::Point, 400.0, 60.0, TextAutoFit::None);
        let (grows, _) = fitted(name, TextLayout::Point, 400.0, 60.0, TextAutoFit::Fit);
        assert_eq!(shaped(&fixed, &bytes), shaped(&grows, &bytes), "fit draws the text at its own size");
        let (open, _) = fitted(name, TextLayout::Point, 0.0, 0.0, TextAutoFit::Shrink);
        assert_eq!(shaped(&fixed, &bytes).width, shaped(&open, &bytes).width, "a box that states no width asks for no shrinking");
    }

    #[test]
    fn small_caps_draw_a_smaller_capital_for_each_lowercase_letter_on_the_same_line_height() {
        let (document, bytes) = fitted("Hello World", TextLayout::Point, 0.0, 0.0, TextAutoFit::None);
        let with_case = |case: TextCase, source: &str| {
            let mut document = document.clone();
            let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
            text.text_case = case;
            text.text = source.into();
            shaped(&document, &bytes)
        };
        let small = with_case(TextCase::SmallCaps, "Hello World");
        let upper = with_case(TextCase::Upper, "Hello World");
        let typed = with_case(TextCase::Original, "Hello World");
        // The same glyphs as the all-capital text, narrower (the lowercase ones are drawn smaller), and no taller: the line height is kept.
        assert_eq!(small.glyphs.len(), upper.glyphs.len());
        assert_eq!(small.text, "HELLO WORLD");
        assert!(small.width < upper.width, "{} vs {}", small.width, upper.width);
        assert!(small.width > upper.width * 0.8, "only the lowercase letters shrink: {} vs {}", small.width, upper.width);
        assert_eq!(small.height, upper.height);
        // The first letter was typed as a capital, so it is the full-size capital; the second is a small one.
        assert_eq!(small.glyphs[0].width, upper.glyphs[0].width);
        assert!(small.glyphs[1].width < upper.glyphs[1].width);
        // Text with no lowercase letter is exactly the capital text, and small capitals differ from the typed text.
        assert_eq!(with_case(TextCase::SmallCaps, "HELLO WORLD"), with_case(TextCase::Upper, "HELLO WORLD"));
        assert_ne!(small, typed);
        // Under a direction mark the small ranges move with the text: the same glyphs shrink.
        let mut marked = document.clone();
        let SceneObject::Text(text) = &mut marked.objects[0] else { unreachable!() };
        text.text_case = TextCase::SmallCaps;
        text.direction = TextDirection::Ltr;
        let marked = shaped(&marked, &bytes);
        assert_eq!(marked.width, small.width);
    }

    #[test]
    fn text_indent_starts_the_first_line_of_every_paragraph_in_and_wraps_it_there() {
        let (document, bytes) = fitted("Alpha beta gamma delta epsilon\nZeta eta theta", TextLayout::Paragraph, 260.0, 0.0, TextAutoFit::None);
        let with_indent = |indent: f64| {
            let mut document = document.clone();
            let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
            text.text_indent = indent;
            shaped(&document, &bytes)
        };
        let flat = with_indent(0.0);
        let indented = with_indent(40.0);
        // The same glyphs (the indent marks are room, never drawn), the first glyph of each paragraph 40 further in.
        let inked = |prepared: &PreparedTextObject| prepared.glyphs.iter().filter(|glyph| !glyph.outline_span.is_empty()).count();
        assert_eq!(inked(&flat), inked(&indented), "every letter is still drawn, once");
        let first_of = |prepared: &PreparedTextObject, line: usize| prepared.glyphs.iter().find(|glyph| glyph.source_line == line).unwrap().x;
        assert!((first_of(&indented, 0) - first_of(&flat, 0) - 40.0).abs() < 0.5, "{} vs {}", first_of(&indented, 0), first_of(&flat, 0));
        assert!((first_of(&indented, 1) - first_of(&flat, 1) - 40.0).abs() < 0.5);
        // Only the first line of a paragraph moves: a second laid-out line of the same paragraph starts where it did.
        let second_line = |prepared: &PreparedTextObject| prepared.glyphs.iter().find(|glyph| glyph.source_line == 0 && glyph.layout_line == 1).map(|glyph| glyph.x);
        if let (Some(a), Some(b)) = (second_line(&flat), second_line(&indented)) {
            assert!((a - b).abs() < 0.5, "a continuation line is not indented: {a} vs {b}");
        }
        // The indent narrows the room for the first line, so it wraps earlier: never fewer lines, and none wider than the box.
        assert!(indented.line_count >= flat.line_count);
        assert!(indented.width <= 260.0 + FIT_SLACK as f32, "{}", indented.width);
        // A text with no letters, and a zero indent, are unchanged.
        let empty = {
            let mut document = document.clone();
            let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
            text.text = String::new();
            text.text_indent = 40.0;
            shaped(&document, &bytes)
        };
        assert!(empty.glyphs.is_empty());
        assert_eq!(with_indent(0.0), flat);
    }

    #[test]
    fn vertical_align_places_the_lines_in_the_box_height_and_point_text_aligns_in_the_box_width() {
        let (top, bytes) = fitted("ARJUN RAO", TextLayout::Point, 400.0, 200.0, TextAutoFit::None);
        let base = shaped(&top, &bytes);
        let edit = |document: &SceneDocument, vertical: VerticalAlign, align: gx_contracts::scene::TextAlign| {
            let mut document = document.clone();
            let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
            text.vertical_align = vertical;
            text.align = align;
            shaped(&document, &bytes)
        };
        let left = gx_contracts::scene::TextAlign::Left;
        let spare = 200.0 - base.height;
        let middle = edit(&top, VerticalAlign::Middle, left);
        let bottom = edit(&top, VerticalAlign::Bottom, left);
        assert!((middle.glyphs[0].y - base.glyphs[0].y - spare / 2.0).abs() < 0.01, "middle moves down by half the spare height");
        assert!((bottom.glyphs[0].y - base.glyphs[0].y - spare).abs() < 0.01, "bottom moves down by all of it");
        assert_eq!(middle.glyphs[0].x, base.glyphs[0].x, "vertical align does not move text sideways");
        let centre = edit(&top, VerticalAlign::Top, gx_contracts::scene::TextAlign::Center);
        let right = edit(&top, VerticalAlign::Top, gx_contracts::scene::TextAlign::Right);
        assert!((centre.glyphs[0].x - base.glyphs[0].x - (400.0 - base.width) / 2.0).abs() < 0.01);
        assert!((right.glyphs[0].x - base.glyphs[0].x - (400.0 - base.width)).abs() < 0.01);
        assert_eq!(centre.glyphs[0].y, base.glyphs[0].y);
        // The outline moves with the glyphs, and a box that states no size leaves everything where it was.
        assert_ne!(middle.outline, base.outline);
        let (open, _) = fitted("ARJUN RAO", TextLayout::Point, 0.0, 0.0, TextAutoFit::None);
        assert_eq!(edit(&open, VerticalAlign::Bottom, gx_contracts::scene::TextAlign::Right), shaped(&open, &bytes));
    }

    #[test]
    fn missing_font_refuses_before_shaping() {
        let document = scene("On air", "missing", Vec::new());
        assert!(matches!(
            prepare_texts(&document, &AssetBytes::new()),
            Err(Refusal::SceneFontUnknown { font_id, .. }) if font_id == "missing"
        ));
    }

    #[test]
    fn old_import_browser_defaults_do_not_prevent_local_rendering() {
        let fonts = vec![font("inter", "Inter", "inter", vec!["Arial".into(), "sans-serif".into()])];
        let document = scene("Local text", "inter", fonts);
        let bytes = AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]);
        assert!(!prepare_texts(&document, &bytes).unwrap().objects[0].outline.elements().is_empty());
    }

    #[test]
    fn advanced_shaping_uses_opentype_bidi_and_declared_fallback_only() {
        let fonts = vec![
            font("inter", "Inter", "inter", vec!["Noto Sans Hebrew".into()]),
            font("hebrew", "Noto Sans Hebrew", "hebrew", Vec::new()),
        ];
        let document = scene("office אבג", "inter", fonts);
        let bytes = AssetBytes::from([
            (ContentHash("inter".into()), INTER.to_vec()),
            (ContentHash("hebrew".into()), HEBREW.to_vec()),
        ]);
        let prepared = prepare_texts(&document, &bytes).expect("declared fonts shape");
        let text = &prepared.objects[0];
        assert!(
            text.glyphs
                .iter()
                .any(|glyph| glyph.source_end - glyph.source_start > 1),
            "OpenType ligature was not formed"
        );
        assert!(
            text.glyphs.iter().any(|glyph| glyph.bidi_level % 2 == 1),
            "RTL run was not resolved"
        );
        assert!(
            text.glyphs
                .iter()
                .any(|glyph| glyph.face_id == "hebrew-regular"),
            "declared Hebrew fallback was not used"
        );
    }

    fn lit_area(document: &SceneDocument, assets: &AssetBytes) -> (usize, [f32; 4]) {
        let prepared = prepare_texts(document, assets).expect("the text shapes");
        let resolution = gx_contracts::scene::resolve_hierarchy(&document.objects);
        let mut surface = crate::rasterise::RasterSurface::transparent(
            document.canvas.width,
            document.canvas.height,
        );
        let paths = crate::rasterise::PreparedPaths::prepare(
            document,
            &resolution.effective,
            Some(&prepared),
        )
        .expect("the text prepares");
        crate::rasterise::PathRasteriser::rasterise_into(
            &crate::rasterise::VelloCpuRasteriser,
            &paths.paths().iter().collect::<Vec<_>>(),
            &mut surface,
        );
        let width = surface.width() as usize;
        let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut count = 0;
        for (index, pixel) in surface.pixels().iter().enumerate() {
            if pixel.a > 0.5 {
                count += 1;
                let (x, y) = ((index % width) as f32, (index / width) as f32);
                bounds = [
                    bounds[0].min(x),
                    bounds[1].min(y),
                    bounds[2].max(x),
                    bounds[3].max(y),
                ];
            }
        }
        (count, bounds)
    }

    fn white_text(
        value: &str,
        size: f64,
        edit: impl Fn(&mut TextObject),
    ) -> (SceneDocument, AssetBytes) {
        let mut document = scene(
            value,
            "inter",
            vec![font("inter", "Inter", "inter", Vec::new())],
        );
        for object in &mut document.objects {
            if let SceneObject::Text(text) = object {
                text.size = size;
                text.base.x = 600.0;
                text.base.y = 400.0;
                text.base.fill = Some(gx_contracts::color::ColorValue::Solid {
                    color: gx_contracts::color::Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                });
                edit(text);
            }
        }
        (
            document,
            AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]),
        )
    }

    /// 3.13: text draws as real glyph outlines, not advance rectangles. An
    /// Inter "I" at 200 px is a stem about 0.09 em wide and one cap height
    /// tall, a few thousand pixels; its advance rectangle would be over
    /// ten thousand.
    #[test]
    fn a_glyph_draws_its_outline_not_its_advance_rectangle() {
        let (document, assets) = white_text("I", 200.0, |_| {});
        let (count, [x0, y0, x1, y1]) = lit_area(&document, &assets);
        assert!((1500..=4500).contains(&count), "an I lit {count} pixels");
        assert!((10.0..=30.0).contains(&(x1 - x0)), "stem width {}", x1 - x0);
        assert!(
            (130.0..=160.0).contains(&(y1 - y0)),
            "cap height {}",
            y1 - y0
        );
    }

    /// 3.13: text takes the object's rotation like any shape; a quarter turn
    /// swaps the glyph's width and height.
    #[test]
    fn text_rotates_with_its_object() {
        let (document, assets) = white_text("I", 200.0, |text| text.base.rotation = 90.0);
        let (count, [x0, y0, x1, y1]) = lit_area(&document, &assets);
        assert!(
            (1500..=4500).contains(&count),
            "a rotated I lit {count} pixels"
        );
        assert!(
            (130.0..=160.0).contains(&(x1 - x0)),
            "rotated width {}",
            x1 - x0
        );
        assert!(
            (10.0..=30.0).contains(&(y1 - y0)),
            "rotated height {}",
            y1 - y0
        );
    }

    #[test]
    fn selector_units_follow_words_whitespace_and_laid_out_lines() {
        let (document, assets) = white_text("A BC\nD", 100.0, |_| {});
        let prepared = prepare_texts(&document, &assets).unwrap();
        let glyphs = &prepared.objects[0].glyphs;
        let find = |line, start| glyphs.iter().find(|glyph| {
            glyph.source_line == line && glyph.source_start == start
        }).unwrap();
        let space = find(0, 1);
        let b = find(0, 2);
        let c = find(0, 3);
        let d = find(1, 0);
        assert!(space.selection_unit(TextRangeBasis::Characters).is_some());
        assert!(space.selection_unit(TextRangeBasis::CharactersExcludingSpaces).is_none());
        assert_eq!(b.selection_unit(TextRangeBasis::Words), c.selection_unit(TextRangeBasis::Words));
        assert_ne!(b.selection_unit(TextRangeBasis::Characters), c.selection_unit(TextRangeBasis::Characters));
        assert_eq!(b.selection_unit(TextRangeBasis::Lines), c.selection_unit(TextRangeBasis::Lines));
        assert_ne!(b.selection_unit(TextRangeBasis::Lines), d.selection_unit(TextRangeBasis::Lines));

        let selector = TextRangeSelector {
            basis: Some(TextRangeBasis::Words), start: 0.34, end: 0.66, smoothness: 0.0,
            ..Default::default()
        };
        let text = &prepared.objects[0];
        let shift = Vec2::new(12.0, 0.0);
        let animated = text.animated_outline(&selector, GlyphTransform {
            translation: [shift.x, shift.y], scale: 1.0, rotation_degrees: 0.0, tracking: 0.0,
        }).unwrap();
        for glyph in glyphs {
            let affine = if glyph.selection_unit(TextRangeBasis::Words) == b.selection_unit(TextRangeBasis::Words) {
                Affine::translate(shift)
            } else {
                Affine::IDENTITY
            };
            for index in glyph.outline_span.clone() {
                assert_eq!(animated.elements()[index], affine * text.outline.elements()[index]);
            }
        }
    }

    #[test]
    fn range_weights_translate_only_the_selected_cached_glyphs() {
        let (document, assets) = white_text("A\nB", 100.0, |_| {});
        let prepared = prepare_texts(&document, &assets).unwrap();
        let text = &prepared.objects[0];
        assert_eq!(text.glyphs.len(), 2);
        assert_eq!(text.glyphs[0].source_start, text.glyphs[1].source_start);
        assert_ne!(text.glyphs[0].source_line, text.glyphs[1].source_line);
        let select_first = TextRangeSelector {
            end: 0.5,
            smoothness: 0.0,
            ..Default::default()
        };
        let shift = Vec2::new(20.0, -8.0);
        let animated = text.animated_outline(&select_first, GlyphTransform {
            translation: [shift.x, shift.y],
            scale: 1.0,
            rotation_degrees: 0.0,
            tracking: 0.0,
        }).unwrap();
        let source = text.outline.elements();
        let result = animated.elements();
        assert_eq!(source.len(), result.len());
        for element in text.glyphs[0].outline_span.clone() {
            assert_eq!(result[element], Affine::translate(shift) * source[element]);
        }
        let other = text.glyphs[1].outline_span.clone();
        assert_eq!(result[other.clone()], source[other]);
    }

    #[test]
    fn baseline_shift_moves_glyphs_and_outlines_without_changing_line_metrics() {
        use vello_cpu::kurbo::Shape as _;

        let shape = |shift| {
            let (document, assets) = white_text("A", 100.0, |text| text.baseline_shift = shift);
            prepare_texts(&document, &assets).expect("shapes").objects.remove(0)
        };
        let unshifted = shape(None);
        let raised = shape(Some(12.0));
        let lowered = shape(Some(-12.0));

        for (shaped, offset) in [(&raised, -12.0), (&lowered, 12.0)] {
            assert_eq!(shaped.width, unshifted.width);
            assert_eq!(shaped.height, unshifted.height);
            assert_eq!(shaped.glyphs[0].y, unshifted.glyphs[0].y + offset);
            let delta = shaped.outline.bounding_box().y0 - unshifted.outline.bounding_box().y0;
            assert!((delta - f64::from(offset)).abs() < 0.001);
        }
    }

    /// Letter spacing is drawn: 100 thousandths of an em at 100 px adds about
    /// 10 px per glyph.
    #[test]
    fn animator_tracking_accumulates_weighted_cluster_spacing_per_line() {
        let (document, bytes) = white_text("AB\nCD", 60.0, |_| {});
        let prepared = prepare_texts(&document, &bytes).unwrap();
        let text = &prepared.objects[0];
        let selector = TextRangeSelector {
            amount: 0.5,
            ..Default::default()
        };
        let mut transform = GlyphTransform {
            translation: [0.0, 0.0],
            scale: 1.0,
            rotation_degrees: 0.0,
            tracking: 0.0,
        };
        let original = text.animated_clusters(&selector, transform).unwrap();
        transform.tracking = -12.0;
        let tracked = text.animated_clusters(&selector, transform).unwrap();
        assert_eq!(tracked.len(), 4);
        for ((actual, base), shift) in tracked.iter().zip(&original).zip([0.0, -6.0, 0.0, -6.0]) {
            let offset = Affine::translate(Vec2::new(shift, 0.0));
            let expected: Vec<_> = base.outline.elements().iter().map(|el| offset * *el).collect();
            assert_eq!(actual.outline.elements(), expected);
        }
    }

    #[test]
    fn letter_spacing_widens_the_run_by_the_tracking() {
        let shaped = |tracking: f64| {
            let (document, assets) =
                white_text("ABCD", 100.0, |text| text.letter_spacing = tracking);
            prepare_texts(&document, &assets).expect("shapes").objects[0].width
        };
        let added = shaped(100.0) - shaped(0.0);
        assert!((30.0..=45.0).contains(&added), "tracking added {added} px");
    }

    /// An absent line height is the font's own metrics, read here straight
    /// from the font file rather than through the font system.
    #[test]
    fn an_absent_line_height_follows_the_fonts_metrics() {
        let metrics = swash::FontRef::from_index(INTER, 0)
            .expect("Inter parses")
            .metrics(&[]);
        let expected = (metrics.ascent + metrics.descent + metrics.leading)
            / f32::from(metrics.units_per_em)
            * 100.0;
        let (document, assets) = white_text("A\nB", 100.0, |_| {});
        let height = prepare_texts(&document, &assets).expect("shapes").objects[0].height;
        assert!(
            (height - 2.0 * expected).abs() <= 1.0,
            "two lines {height}, metrics line {expected}"
        );
        let (document, assets) = white_text("A\nB", 100.0, |text| text.line_height = Some(1.5));
        let height = prepare_texts(&document, &assets).expect("shapes").objects[0].height;
        assert!(
            (height - 300.0).abs() <= 1.0,
            "two lines at 1.5 gave {height}"
        );
    }

    /// An sfnt whose family names (IDs 1 and 16) are present but empty, as
    /// Adobe Fonts serves kit files.
    fn blank_family_names(sfnt: &[u8]) -> Vec<u8> {
        let mut out = sfnt.to_vec();
        let be16 = |b: &[u8], at: usize| usize::from(u16::from_be_bytes([b[at], b[at + 1]]));
        let record = (0..be16(&out, 4))
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

    /// Set OS/2 usWeightClass, as Adobe's bold kit files carry 700.
    fn with_weight_class(sfnt: &[u8], weight: u16) -> Vec<u8> {
        let mut out = sfnt.to_vec();
        let tables = usize::from(u16::from_be_bytes([out[4], out[5]]));
        let record = (0..tables)
            .map(|i| 12 + 16 * i)
            .find(|&r| &out[r..r + 4] == b"OS/2")
            .expect("the fixture has an OS/2 table");
        let offset = u32::from_be_bytes(out[record + 8..record + 12].try_into().unwrap()) as usize;
        out[offset + 4..offset + 6].copy_from_slice(&weight.to_be_bytes());
        out
    }

    /// Adobe Fonts kit files name no family; their definitions do. fontdb
    /// files such faces under an empty name, so a bold kit font and a
    /// regular fallback both answered to "" and the regular one won the
    /// lookup: the text was drawn in its fallback. Each face is now found
    /// under its declared family, and the text's own font draws it.
    #[test]
    fn faces_whose_files_name_no_family_shape_under_their_declared_family() {
        const LATIN: &[u8] =
            include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.ttf");
        let mut bold = font("alpha", "Alpha", "alpha", vec!["Beta".into()]);
        bold.faces[0].weight = 700;
        let fonts = vec![bold, font("beta", "Beta", "beta", Vec::new())];
        let bytes = AssetBytes::from([
            (
                ContentHash("alpha".into()),
                with_weight_class(&blank_family_names(INTER), 700),
            ),
            (ContentHash("beta".into()), blank_family_names(LATIN)),
        ]);
        let prepared =
            prepare_texts(&scene("Office", "alpha", fonts), &bytes).expect("the faces shape");
        let glyphs = &prepared.objects[0].glyphs;
        assert!(!glyphs.is_empty() && glyphs.iter().all(|g| g.glyph_id != 0));
        let faces: Vec<&str> = glyphs.iter().map(|g| g.face_id.as_str()).collect();
        assert!(
            faces.iter().all(|f| *f == "alpha-regular"),
            "drawn in {faces:?}, not the text's own font"
        );
    }

    #[test]
    fn a_woff2_asset_shapes_exactly_like_its_sfnt_original() {
        const TTF: &[u8] =
            include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.ttf");
        const WOFF2: &[u8] =
            include_bytes!("../../../../Shared/asset-plane/tests/fixtures/fonts/inter-latin.woff2");
        let shaped = |bytes: &[u8]| {
            let document = scene(
                "Office 2026",
                "inter",
                vec![font("inter", "Inter", "inter", Vec::new())],
            );
            let assets = AssetBytes::from([(ContentHash("inter".into()), bytes.to_vec())]);
            prepare_texts(&document, &assets).expect("the font shapes")
        };
        let (from_ttf, from_woff2) = (shaped(TTF), shaped(WOFF2));
        let glyphs = |prepared: &PreparedTexts| {
            prepared.objects[0]
                .glyphs
                .iter()
                .map(|g| (g.glyph_id, g.x.to_bits()))
                .collect::<Vec<_>>()
        };
        assert!(!from_ttf.objects[0].glyphs.is_empty());
        assert_eq!(glyphs(&from_ttf), glyphs(&from_woff2));
    }

    const TELUGU: &[u8] = include_bytes!("../tests/fixtures/NotoSansTelugu-Regular.ttf");
    const DEVANAGARI: &[u8] = include_bytes!("../tests/fixtures/NotoSansDevanagari-Regular.ttf");

    /// Inter with a declared fallback to one script face, as an author would
    /// set a Latin title up to carry another script.
    fn with_fallback(
        value: &str,
        family: &str,
        bytes: &'static [u8],
    ) -> (SceneDocument, AssetBytes) {
        let fonts = vec![
            font("inter", "Inter", "inter", vec![family.into()]),
            font("script", family, "script", Vec::new()),
        ];
        let document = scene(value, "inter", fonts);
        let assets = AssetBytes::from([
            (ContentHash("inter".into()), INTER.to_vec()),
            (ContentHash("script".into()), bytes.to_vec()),
        ]);
        (document, assets)
    }

    /// 3.18: complex scripts shape through their OpenType tables from the
    /// packaged face alone: conjuncts and vowel signs become fewer glyphs
    /// than characters, clusters span several characters, and every glyph
    /// has a real outline.
    #[test]
    fn telugu_and_hindi_shape_into_clusters_from_their_packaged_faces() {
        for (value, family, bytes) in [
            ("తెలుగు క్షేత్రం", "Noto Sans Telugu", TELUGU),
            ("हिन्दी क्षत्रिय", "Noto Sans Devanagari", DEVANAGARI),
        ] {
            let (document, assets) = with_fallback(value, family, bytes);
            let prepared = prepare_texts(&document, &assets).expect("declared fonts shape");
            let text = &prepared.objects[0];
            let characters = value.chars().filter(|c| !c.is_whitespace()).count();
            let drawn = text
                .glyphs
                .iter()
                .filter(|g| g.face_id == "script-regular")
                .count();
            assert!(drawn > 0, "{family}: the declared fallback was not used");
            assert!(
                drawn < characters,
                "{family}: {drawn} glyphs for {characters} characters; conjuncts did not form"
            );
            assert!(
                text.glyphs
                    .iter()
                    .any(|g| value[g.source_start..g.source_end].chars().count() > 1),
                "{family}: no glyph cluster spans several characters"
            );
            assert!(
                !text.outline.elements().is_empty(),
                "{family}: no glyph outline"
            );
        }
    }

    /// Invariant 66: a script the declared fonts cannot draw refuses by name;
    /// no installed system font is consulted to fill it in.
    #[test]
    fn a_script_no_declared_font_covers_refuses_instead_of_reaching_for_a_system_font() {
        let document = scene(
            "తెలుగు",
            "inter",
            vec![font("inter", "Inter", "inter", Vec::new())],
        );
        let assets = AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]);
        assert!(matches!(
            prepare_texts(&document, &assets),
            Err(Refusal::FontMissing { font_id }) if font_id == "inter"
        ));
    }

    /// The text's paths, drawn on the CPU: what `lit_area` draws.
    fn drawn(document: &SceneDocument, assets: &AssetBytes) -> crate::rasterise::RasterSurface {
        let prepared = prepare_texts(document, assets).expect("the text shapes");
        let resolution = gx_contracts::scene::resolve_hierarchy(&document.objects);
        let paths = crate::rasterise::PreparedPaths::prepare(
            document,
            &resolution.effective,
            Some(&prepared),
        )
        .expect("the text prepares");
        let mut surface = crate::rasterise::RasterSurface::transparent(
            document.canvas.width,
            document.canvas.height,
        );
        crate::rasterise::PathRasteriser::rasterise_into(
            &crate::rasterise::VelloCpuRasteriser,
            &paths.paths().iter().collect::<Vec<_>>(),
            &mut surface,
        );
        surface
    }

    /// 3.18: text is a path, so its stroke and a gradient fill are drawn.
    #[test]
    fn text_draws_its_stroke_and_its_gradient_fill() {
        use gx_contracts::color::{ColorValue, GradientStop, Rgba};
        let assets = AssetBytes::from([(ContentHash("inter".into()), INTER.to_vec())]);
        let fonts = || vec![font("inter", "Inter", "inter", Vec::new())];
        // A stroke alone, no fill: the glyph outlines are drawn as strokes.
        let mut stroked = scene("Stroke", "inter", fonts());
        if let SceneObject::Text(text) = &mut stroked.objects[0] {
            text.base.fill = None;
            text.base.stroke = Some(ColorValue::hex("#ff0000").unwrap());
            text.base.stroke_width = 2.0;
        }
        let lit = drawn(&stroked, &assets)
            .pixels()
            .iter()
            .filter(|p| p.a > 0.5)
            .count();
        assert!(lit > 200, "a stroked text drew {lit} pixels");
        // A red-to-blue gradient across the box: the first glyph is redder
        // than the last.
        let mut graded = scene("HHHHHHHHHHHHHHHH", "inter", fonts());
        if let SceneObject::Text(text) = &mut graded.objects[0] {
            text.base.fill = Some(ColorValue::LinearGradient {
                angle: 0.0,
                start_x: 0.0,
                start_y: 0.0,
                end_x: 0.5,
                end_y: 0.0,
                stops: vec![
                    GradientStop {
                        position: 0.0,
                        color: Rgba::srgb(1.0, 0.0, 0.0, 1.0),
                    },
                    GradientStop {
                        position: 1.0,
                        color: Rgba::srgb(0.0, 0.0, 1.0, 1.0),
                    },
                ],
                spread: Default::default(),
                coordinate_mode: Default::default(),
            });
        }
        let surface = drawn(&graded, &assets);
        let width = surface.width() as usize;
        let mean_red_minus_blue = |from: usize, to: usize| {
            let (mut sum, mut n) = (0.0_f32, 0.0_f32);
            for (i, p) in surface.pixels().iter().enumerate() {
                let x = i % width;
                if p.a > 0.9 && (from..to).contains(&x) {
                    sum += p.r - p.b;
                    n += 1.0;
                }
            }
            sum / n.max(1.0)
        };
        let (left, right) = (mean_red_minus_blue(0, 60), mean_red_minus_blue(300, 400));
        assert!(left > 0.5 && right < -0.5, "left {left}, right {right}");
    }

    const NASTALIQ: &[u8] = include_bytes!("../tests/fixtures/NotoNastaliqUrdu-Regular.ttf");
    const NASKH: &[u8] = include_bytes!("../tests/fixtures/NotoSansArabic-Regular.ttf");

    /// Urdu, right to left, in Nastaliq and in Naskh, from the packaged face
    /// alone: every Urdu glyph is in a right-to-left run, the first letter of
    /// the word is drawn furthest right, and a letter joined to its neighbour
    /// takes a different (contextual) glyph from the same letter standing
    /// alone.
    #[test]
    fn urdu_shapes_right_to_left_with_joined_letters_in_nastaliq_and_naskh() {
        for (family, bytes) in [
            ("Noto Nastaliq Urdu", NASTALIQ),
            ("Noto Sans Arabic", NASKH),
        ] {
            let (document, assets) = with_fallback("اردو خبریں", family, bytes);
            let prepared = prepare_texts(&document, &assets).expect("declared fonts shape");
            let text = &prepared.objects[0];
            let urdu: Vec<_> = text
                .glyphs
                .iter()
                .filter(|g| g.face_id == "script-regular")
                .collect();
            assert!(
                !urdu.is_empty(),
                "{family}: the declared fallback was not used"
            );
            assert!(
                urdu.iter().all(|g| g.bidi_level % 2 == 1),
                "{family}: an Urdu glyph is not in a right-to-left run"
            );
            let first = urdu
                .iter()
                .find(|g| g.source_start == 0)
                .expect("the first letter");
            let rightmost = urdu.iter().map(|g| g.x).fold(f32::MIN, f32::max);
            assert_eq!(
                first.x, rightmost,
                "{family}: the first letter is not furthest right"
            );
            assert!(!text.outline.elements().is_empty(), "{family}: no outline");

            // Beh joined (initial form) against beh alone (isolated form).
            let glyph_of_first = |value: &str| {
                let (document, assets) = with_fallback(value, family, bytes);
                let prepared = prepare_texts(&document, &assets).expect("shapes");
                prepared.objects[0]
                    .glyphs
                    .iter()
                    .find(|g| g.source_start == 0)
                    .expect("first glyph")
                    .glyph_id
            };
            assert_ne!(
                glyph_of_first("بب"),
                glyph_of_first("ب"),
                "{family}: a joined letter did not take its contextual form"
            );
        }
    }
    const CJK: &[u8] = include_bytes!("../tests/fixtures/NotoSansSC-Subset.otf");

    /// `value` in the CJK face at size 40, in the given writing mode, layout and box.
    fn vertical(value: &str, mode: gx_contracts::scene::WritingMode, layout: TextLayout, width: f64, height: f64) -> PreparedTextObject {
        let mut document = scene(value, "cjk", vec![font("cjk", "Noto Sans SC", "cjk", Vec::new())]);
        let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
        text.writing_mode = mode;
        text.layout = layout;
        text.base.width = width;
        text.base.height = height;
        text.size = 40.0;
        shaped(&document, &AssetBytes::from([(ContentHash("cjk".into()), CJK.to_vec())]))
    }

    /// 11.51: vertical text is one upright column, a cell of one em to a character, every glyph on the column's centre line, and the
    /// text is as wide as one line and as long as the characters stacked.
    #[test]
    fn vertical_text_is_one_upright_column_a_cell_to_a_character() {
        use gx_contracts::scene::WritingMode::{VerticalLr, VerticalRl};
        for mode in [VerticalRl, VerticalLr] {
            let column = vertical("你好世界", mode, TextLayout::Point, 0.0, 0.0);
            assert_eq!(column.line_count(), 1, "{mode:?}");
            assert_eq!(column.glyphs.len(), 4);
            let x = column.glyphs[0].x;
            assert!(column.glyphs.iter().all(|glyph| (glyph.x - x).abs() < 0.001), "{mode:?}: the glyphs are not on one centre line");
            for pair in column.glyphs.windows(2) {
                assert!((pair[1].y - pair[0].y - 40.0).abs() < 0.01, "{mode:?}: the cells are {} apart, not one em", pair[1].y - pair[0].y);
            }
            assert!((column.height - 160.0).abs() < 0.01, "{mode:?}: four characters are {} long", column.height);
            assert!(column.width > 40.0 && column.width < 80.0, "{mode:?}: one line is {} wide", column.width);
            // The column is as wide as its line: the glyphs' centre line is the middle of it (the first column of vertical-rl is at the
            // right edge of a box that states no width, the first of vertical-lr at the left).
            assert!((x + 20.0 - column.width / 2.0).abs() < 0.01, "{mode:?}: the centre line is at {}", x + 20.0);
        }
    }

    /// Paragraphs are columns: the second is to the left of the first in `vertical-rl` and to the right in `vertical-lr`, one line
    /// apart; the text is as wide as its columns.
    #[test]
    fn vertical_paragraphs_stack_right_to_left_or_left_to_right() {
        use gx_contracts::scene::WritingMode::{VerticalLr, VerticalRl};
        let rl = vertical("你好\n世界", VerticalRl, TextLayout::Point, 0.0, 0.0);
        let lr = vertical("你好\n世界", VerticalLr, TextLayout::Point, 0.0, 0.0);
        let line = rl.width / 2.0;
        let (first_rl, second_rl) = (rl.glyphs[0].x, rl.glyphs[2].x);
        let (first_lr, second_lr) = (lr.glyphs[0].x, lr.glyphs[2].x);
        assert!((first_rl - second_rl - line).abs() < 0.01, "rl: {first_rl} then {second_rl} for a line of {line}");
        assert!((second_lr - first_lr - line).abs() < 0.01, "lr: {first_lr} then {second_lr} for a line of {line}");
        assert!(first_rl > second_rl && first_lr < second_lr);
        assert_eq!(rl.line_count(), 2);
        assert!((rl.height - 80.0).abs() < 0.01);
    }

    /// Paragraph text breaks its columns at the box height: a box two cells tall breaks four characters into two columns of two.
    #[test]
    fn vertical_paragraph_text_breaks_its_columns_at_the_box_height() {
        use gx_contracts::scene::WritingMode::VerticalRl;
        let broken = vertical("你好世界", VerticalRl, TextLayout::Paragraph, 200.0, 80.0);
        assert_eq!(broken.line_count(), 2);
        assert!((broken.height - 80.0).abs() < 0.01, "a column is {} long", broken.height);
        let first_column: Vec<_> = broken.glyphs.iter().filter(|glyph| glyph.layout_line == 0).map(|glyph| glyph.source_start).collect();
        assert_eq!(first_column.len(), 2, "{first_column:?}");
        // The first column is at the right edge of the 200 wide box, the second one line to its left.
        let (right, left) = (broken.glyphs[0].x, broken.glyphs[2].x);
        assert!(right > left && (right - left - broken.width / 2.0).abs() < 0.01);
        assert!(right + 20.0 <= 200.0 + 0.01, "the first column passes the right edge: {}", right + 20.0);
    }

    /// The font's vertical forms are asked for: a full-width comma is a different glyph in a column than in a line.
    #[test]
    fn vertical_text_takes_the_fonts_vertical_forms() {
        use gx_contracts::scene::WritingMode::{HorizontalTb, VerticalRl};
        let in_line = vertical("，", HorizontalTb, TextLayout::Point, 0.0, 0.0);
        let in_column = vertical("，", VerticalRl, TextLayout::Point, 0.0, 0.0);
        assert_ne!(in_line.glyphs[0].glyph_id, in_column.glyphs[0].glyph_id, "the comma has no vertical form in a column");
    }

    /// Columns past `maxLines` are hidden along the width, and the record check sees them there.
    #[test]
    fn vertical_columns_past_max_lines_are_hidden_along_the_width() {
        use gx_contracts::scene::WritingMode::VerticalRl;
        let mut document = scene("你好\n世界", "cjk", vec![font("cjk", "Noto Sans SC", "cjk", Vec::new())]);
        let SceneObject::Text(text) = &mut document.objects[0] else { unreachable!() };
        text.writing_mode = VerticalRl;
        text.layout = TextLayout::Point;
        text.base.width = 0.0;
        text.base.height = 0.0;
        text.size = 40.0;
        text.max_lines = Some(1);
        let bytes = AssetBytes::from([(ContentHash("cjk".into()), CJK.to_vec())]);
        let limited = shaped(&document, &bytes);
        assert!(limited.hidden_width > 0.0 && (limited.hidden_width * 2.0 - limited.width).abs() < 0.01, "{} of {}", limited.hidden_width, limited.width);
        assert_eq!(limited.height - limited.visible_height, 0.0, "no height is hidden in a column");
    }

    /// An animator's tracking has no meaning down a column and is refused by name.
    #[test]
    fn vertical_text_refuses_animator_tracking_by_name() {
        use gx_contracts::scene::WritingMode::VerticalRl;
        let column = vertical("你好世界", VerticalRl, TextLayout::Point, 0.0, 0.0);
        let transform = GlyphTransform { translation: [0.0, 0.0], scale: 1.0, rotation_degrees: 0.0, tracking: 5.0 };
        let refused = column.animated_outline(&TextRangeSelector::default(), transform);
        assert!(matches!(refused, Err(Refusal::ScenePropertyNotDrawable { ref property, .. }) if property.contains("vertical writing")), "{refused:?}");
        assert!(column.animated_outline(&TextRangeSelector::default(), GlyphTransform { tracking: 0.0, ..transform }).is_ok());
    }

}

//! Figma ingest, full-fidelity path (build plan 18.2): a frame an agent read through Figma's MCP
//! and wrote into [`FigmaNode`] becomes one scene with its paint, text and fonts.
//!
//! Rules this module keeps, each tested:
//! - **Nothing is guessed and nothing is dropped silently.** What maps lands as a first-class
//!   object with its authored properties; what does not (effects, image fills, per-corner radii,
//!   clipping, vectors) is on the report by name, per node, with what stands in its place.
//! - **A font is never substituted** (ADR-0002 A.4). Each family and style is declared as a
//!   font that is `Missing` until its file is supplied, so preflight refuses rather than a
//!   system font quietly standing in.
//! - A frame that has a fill, a stroke or rounded corners keeps them: a group paints nothing,
//!   so the paint becomes a rectangle behind the frame's children, and the report says so.

use std::collections::BTreeMap;

use gx_asset_plane::content_hash;
use gx_contracts::color::{ColorValue, GradientStop, Rgba, SourceColorSpace};
use gx_contracts::figma_frame::{FigmaColor, FigmaEffect, FigmaNode, FigmaPaint, FigmaStop};
use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
    FontStyle,
};
use gx_contracts::import::{ImportEntry, ImportReport, ImportTier, Substitution};
use gx_contracts::material::{BlendMode, FitMode};
use gx_contracts::scene::{
    AssetLibraryItem, EllipseObject, GroupObject, ImageObject, ObjectBase, RectObject, SceneCanvas,
    SceneDocument, SceneObject, SceneTimeline, TextAlign, TextCase, TextDecoration, TextObject,
    VerticalAlign,
};
use gx_contracts::{RationalRate, RefusalSeverity};

use crate::figma::{substitution, MAX_NODES};
use crate::import::{retained_source, ImportFailure, ImportOutcome, SourceKind};

#[cfg(test)]
mod pictures;
#[cfg(test)]
mod tests;

const MAX_SIDE: f64 = 16_384.0;
const MAX_DEPTH: usize = 64;

/// The canonical text of the frame as handed over: what is retained and hashed, so a re-import
/// of the same frame is byte-identical.
pub fn canonical_source(frame: &FigmaNode) -> String {
    serde_json::to_string(frame).expect("a frame is plain data")
}

/// Where a frame's pictures are looked for: the folder under `Images`, and how a name (the file
/// name without its extension) finds its file in the project.
pub type FontFinder<'a> = dyn Fn(&str, &str) -> Option<(AssetLibraryItem, FontFormat)> + 'a;

pub struct PictureLookup<'a> {
    pub folder: String,
    pub find: &'a dyn Fn(&str) -> Option<AssetLibraryItem>,
    /// The font file for a family and a style, from the project's `Fonts` folder.
    pub font: &'a FontFinder<'a>,
}

struct Builder<'a> {
    objects: Vec<SceneObject>,
    entries: Vec<ImportEntry>,
    fonts: BTreeMap<String, FontDefinition>,
    pictures: Option<&'a PictureLookup<'a>>,
    assets: Vec<AssetLibraryItem>,
    z: i32,
    count: usize,
}

fn color(c: &FigmaColor, opacity: f64) -> Rgba {
    Rgba {
        r: c.r.clamp(0.0, 1.0),
        g: c.g.clamp(0.0, 1.0),
        b: c.b.clamp(0.0, 1.0),
        a: (c.a * opacity).clamp(0.0, 1.0),
        space: SourceColorSpace::Srgb,
    }
}

fn stops(list: &[FigmaStop], opacity: f64) -> Vec<GradientStop> {
    list.iter()
        .map(|s| GradientStop {
            position: s.position.clamp(0.0, 1.0),
            color: color(&s.color, opacity),
        })
        .collect()
}

fn visible(paint: &FigmaPaint) -> bool {
    match paint {
        FigmaPaint::Solid { visible, .. }
        | FigmaPaint::LinearGradient { visible, .. }
        | FigmaPaint::RadialGradient { visible, .. }
        | FigmaPaint::Image { visible, .. } => *visible,
    }
}

/// The paint a node shows: the top visible one that GrapiX can draw, and what happened to the rest.
fn paint_of(
    paints: &[FigmaPaint],
    what: &str,
    width: f64,
    height: f64,
    subs: &mut Vec<Substitution>,
) -> Option<ColorValue> {
    let shown: Vec<&FigmaPaint> = paints.iter().filter(|p| visible(p)).collect();
    if shown.len() > 1 {
        subs.push(substitution(
            &format!("figma:{} stack of {} paints", what, shown.len()),
            "the top paint only",
            "a layer carries one fill and one stroke; stacked paints are not composited here",
            RefusalSeverity::Warning,
        ));
    }
    let top = shown.last()?;
    match top {
        FigmaPaint::Solid {
            color: c, opacity, ..
        } => Some(ColorValue::Solid {
            color: color(c, *opacity),
        }),
        FigmaPaint::LinearGradient {
            angle,
            stops: list,
            opacity,
            ..
        } if list.len() >= 2 => {
            let radians = angle.to_radians();
            let (dx, dy) = (radians.cos(), radians.sin());
            // The gradient line passes through the box centre and spans the box along `angle`.
            let half = 0.5 * (width * dx.abs() + height * dy.abs());
            let (cx, cy) = (width / 2.0, height / 2.0);
            Some(ColorValue::LinearGradient {
                angle: *angle,
                start_x: cx - dx * half,
                start_y: cy - dy * half,
                end_x: cx + dx * half,
                end_y: cy + dy * half,
                stops: stops(list, *opacity),
                spread: Default::default(),
                coordinate_mode: Default::default(),
            })
        }
        FigmaPaint::RadialGradient {
            stops: list,
            opacity,
            ..
        } if list.len() >= 2 => Some(ColorValue::RadialGradient {
            center_x: width / 2.0,
            center_y: height / 2.0,
            radius_x: width / 2.0,
            radius_y: height / 2.0,
            focal_x: None,
            focal_y: None,
            stops: stops(list, *opacity),
            spread: Default::default(),
            coordinate_mode: Default::default(),
        }),
        // A picture fill is resolved, or named with the path to file it at, by the node that
        // owns it (`Builder::picture`), which knows the folder; other paints have no pictures.
        FigmaPaint::Image { image, .. } => {
            if what != "fill" {
                subs.push(substitution(
                    &format!("figma:{what} picture ({image})"),
                    "no paint",
                    "only a fill can be a picture",
                    RefusalSeverity::Warning,
                ));
            }
            None
        }
        _ => {
            subs.push(substitution(
                &format!("figma:{what} gradient with fewer than two stops"),
                "no paint",
                "a gradient needs at least two stops",
                RefusalSeverity::Warning,
            ));
            None
        }
    }
}

fn blend_of(name: &str, subs: &mut Vec<Substitution>) -> Option<BlendMode> {
    Some(match name {
        "" | "PASS_THROUGH" | "NORMAL" => return None,
        "MULTIPLY" => BlendMode::Multiply,
        "SCREEN" => BlendMode::Screen,
        "OVERLAY" => BlendMode::Overlay,
        "DARKEN" => BlendMode::Darken,
        "LIGHTEN" => BlendMode::Lighten,
        "COLOR_BURN" => BlendMode::ColorBurn,
        "COLOR_DODGE" => BlendMode::ColorDodge,
        "LINEAR_BURN" => BlendMode::LinearBurn,
        "LINEAR_DODGE" => BlendMode::LinearDodge,
        "SOFT_LIGHT" => BlendMode::SoftLight,
        "HARD_LIGHT" => BlendMode::HardLight,
        "DIFFERENCE" => BlendMode::Difference,
        "EXCLUSION" => BlendMode::Exclusion,
        "HUE" => BlendMode::Hue,
        "SATURATION" => BlendMode::Saturation,
        "COLOR" => BlendMode::Color,
        "LUMINOSITY" => BlendMode::Luminosity,
        other => {
            subs.push(substitution(
                &format!("figma:blend mode {other}"),
                "normal",
                "GrapiX has no blend mode of that name",
                RefusalSeverity::Warning,
            ));
            return None;
        }
    })
}

/// The weight and slant in a Figma style name.
fn weight_and_style(style: &str) -> (u16, FontStyle) {
    let lower = style.to_ascii_lowercase();
    let italic = lower.contains("italic");
    let stripped = lower.replace("italic", "").replace([' ', '-'], "");
    let weight = match stripped.as_str() {
        "thin" | "hairline" => 100,
        "extralight" | "ultralight" => 200,
        "light" => 300,
        "" | "regular" | "normal" | "book" => 400,
        "medium" => 500,
        "semibold" | "demibold" => 600,
        "bold" => 700,
        "extrabold" | "ultrabold" => 800,
        "black" | "heavy" => 900,
        _ => 400,
    };
    (
        weight,
        if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    )
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

impl Builder<'_> {
    /// The picture a node's top visible fill names, when the project holds it. One that is not
    /// there is named on the node with the exact path to file it at.
    fn picture(
        &mut self,
        paints: &[FigmaPaint],
        subs: &mut Vec<Substitution>,
    ) -> Option<(AssetLibraryItem, FitMode)> {
        let top = paints.iter().rfind(|p| visible(p))?;
        let FigmaPaint::Image {
            image, scale_mode, ..
        } = top
        else {
            return None;
        };
        let stem = match image.rsplit_once('.') {
            Some((stem, ext))
                if ext.eq_ignore_ascii_case("png") || ext.eq_ignore_ascii_case("webp") =>
            {
                stem
            }
            _ => image.as_str(),
        };
        let folder = self.pictures.map(|p| p.folder.as_str()).unwrap_or("");
        let found = self.pictures.and_then(|p| (p.find)(stem));
        let Some(item) = found else {
            subs.push(substitution(
                &format!("figma:picture {image}"),
                "an empty box",
                &format!(
                    "no picture named {stem} in Assets/Images/{folder}/; file it as Assets/Images/{folder}/{stem}.png (or .webp, .jpg, .svg) with assets.import, then ingest again"
                ),
                RefusalSeverity::Warning,
            ));
            return None;
        };
        let fit = match scale_mode.as_str() {
            "fit" => FitMode::Contain,
            "crop" => FitMode::Crop,
            "tile" => FitMode::Tile,
            _ => FitMode::Cover,
        };
        if !self.assets.iter().any(|a| a.asset_id == item.asset_id) {
            self.assets.push(item.clone());
        }
        Some((item, fit))
    }

    fn image_object(base: ObjectBase, item: &AssetLibraryItem, fit: FitMode) -> SceneObject {
        SceneObject::Image(ImageObject {
            base,
            asset_id: item.asset_id.clone(),
            fit,
            slice: None,
        })
    }

    fn base(&mut self, node: &FigmaNode, subs: &mut Vec<Substitution>) -> ObjectBase {
        let mut base = ObjectBase::new(
            &node.id,
            if node.name.trim().is_empty() {
                node.id.clone()
            } else {
                node.name.clone()
            },
        );
        base.x = node.x;
        base.y = node.y;
        base.width = node.width.max(0.0);
        base.height = node.height.max(0.0);
        base.visible = node.visible;
        base.opacity = node.opacity.clamp(0.0, 1.0);
        // Figma turns counter-clockwise, the scene clockwise; both pivot at the top-left.
        base.rotation = -node.rotation;
        base.blend_mode = blend_of(&node.blend_mode, subs);
        base.z_index = self.z;
        self.z += 1;
        base
    }

    fn effects(node: &FigmaNode, subs: &mut Vec<Substitution>) {
        for effect in &node.effects {
            let (kind, shown) = match effect {
                FigmaEffect::DropShadow { visible, .. } => ("drop shadow", visible),
                FigmaEffect::InnerShadow { visible, .. } => ("inner shadow", visible),
                FigmaEffect::LayerBlur { visible, .. } => ("layer blur", visible),
                FigmaEffect::BackgroundBlur { visible, .. } => ("background blur", visible),
            };
            if *shown {
                subs.push(substitution(
                    &format!("figma:{kind}"),
                    "no effect",
                    "layer styles are not mapped by this import yet (build plan 11.60)",
                    RefusalSeverity::Warning,
                ));
            }
        }
    }

    fn radius(node: &FigmaNode, subs: &mut Vec<Substitution>) -> f64 {
        match node.corner_radii {
            Some(r) if r.iter().any(|v| (v - r[0]).abs() > 1e-6) => {
                let largest = r.iter().cloned().fold(0.0, f64::max);
                subs.push(substitution(
                    "figma:per-corner radii",
                    &format!("one radius of {largest}"),
                    "a rectangle carries one corner radius",
                    RefusalSeverity::Warning,
                ));
                largest
            }
            Some(r) => r[0].max(0.0),
            None => node.corner_radius.max(0.0),
        }
    }

    fn stroke(node: &FigmaNode, base: &mut ObjectBase, subs: &mut Vec<Substitution>) {
        if node.stroke_weight <= 0.0 {
            return;
        }
        if let Some(stroke) = paint_of(&node.strokes, "stroke", node.width, node.height, subs) {
            base.stroke = Some(stroke);
            base.stroke_width = node.stroke_weight;
            if matches!(node.stroke_align.as_str(), "inside" | "outside") {
                subs.push(substitution(
                    &format!("figma:stroke {}", node.stroke_align),
                    "a stroke centred on the edge",
                    "strokes are centred on the path",
                    RefusalSeverity::Info,
                ));
            }
        }
    }

    fn entry(&mut self, node: &FigmaNode, tier: ImportTier, object: bool, subs: Vec<Substitution>) {
        self.entries.push(ImportEntry {
            source_id: node.id.clone(),
            source_name: if node.name.is_empty() {
                node.id.clone()
            } else {
                node.name.clone()
            },
            tier,
            object_id: object.then(|| node.id.clone()),
            substitutions: subs,
        });
    }

    fn text(&mut self, node: &FigmaNode) -> Option<String> {
        let spec = node.text.as_ref()?;
        let mut subs = Vec::new();
        let mut base = self.base(node, &mut subs);
        base.fill = paint_of(&node.fills, "text fill", node.width, node.height, &mut subs);
        let (weight, style) = weight_and_style(&spec.font_style);
        let style_name = if spec.font_style.is_empty() {
            "Regular"
        } else {
            &spec.font_style
        };
        let font_id = slug(&format!("{} {}", spec.font_family, style_name));
        // A font filed in the project's Fonts folder is ready; any other stays missing.
        let filed = self
            .pictures
            .and_then(|p| (p.font)(&spec.font_family, style_name));
        if let Some((item, _)) = &filed {
            if !self.assets.iter().any(|a| a.asset_id == item.asset_id) {
                self.assets.push(item.clone());
            }
        }
        let ready = filed.is_some();
        self.fonts
            .entry(font_id.clone())
            .or_insert_with(|| FontDefinition {
                font_id: font_id.clone(),
                family: spec.font_family.clone(),
                display_name: format!("{} {}", spec.font_family, style_name),
                faces: vec![FontFaceDefinition {
                    face_id: format!("{font_id}-face"),
                    family: spec.font_family.clone(),
                    weight,
                    style,
                    stretch: None,
                    unicode_range: None,
                    // Filed in the project, or not: an id that names what is missing, never a
                    // system font.
                    source: FontSource::File {
                        asset_id: filed.as_ref().map_or_else(
                            || format!("missing-{font_id}"),
                            |(i, _)| i.asset_id.clone(),
                        ),
                        format: filed.as_ref().map_or(FontFormat::Ttf, |(_, f)| *f),
                        original_url: None,
                        stylesheet_url: None,
                    },
                    status: Some(if ready {
                        FontLoadStatus::Ready
                    } else {
                        FontLoadStatus::Missing
                    }),
                    error_message: (!ready)
                        .then(|| "declared by a Figma import; supply the font file".into()),
                }],
                fallback_families: Vec::new(),
                embedding_policy: EmbeddingPolicy::Reference,
                license: None,
                enabled: true,
                source_label: Some("Figma import".into()),
                status: if ready {
                    FontLoadStatus::Ready
                } else {
                    FontLoadStatus::Missing
                },
                error_message: (!ready)
                    .then(|| "declared by a Figma import; supply the font file".into()),
            });
        if !ready {
            subs.push(substitution(
                &format!("figma:font {} {}", spec.font_family, style_name),
                "a font declared as missing",
                "no matching file in the project's Fonts folder; preflight refuses until it is supplied, and no system font stands in",
                RefusalSeverity::Warning,
            ));
        }
        let size = spec.font_size.max(1.0);
        let align = match spec.align.as_str() {
            "center" => TextAlign::Center,
            "right" => TextAlign::Right,
            "justified" => {
                subs.push(substitution(
                    "figma:justified text",
                    "left aligned text",
                    "justification is not a text alignment here",
                    RefusalSeverity::Info,
                ));
                TextAlign::Left
            }
            _ => TextAlign::Left,
        };
        let text = SceneObject::Text(TextObject {
            base,
            text: spec.characters.clone(),
            font_id,
            size,
            layout: gx_contracts::scene::TextLayout::Paragraph,
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: match spec.vertical_align.as_str() {
                "center" => VerticalAlign::Middle,
                "bottom" => VerticalAlign::Bottom,
                _ => VerticalAlign::Top,
            },
            direction: Default::default(),
            text_case: match spec.text_case.as_str() {
                "upper" => TextCase::Upper,
                "lower" => TextCase::Lower,
                "title" => TextCase::Title,
                _ => TextCase::Original,
            },
            decoration: TextDecoration {
                underline: spec.decoration == "underline",
                strikethrough: spec.decoration == "strikethrough",
            },
            overflow: Default::default(),
            align,
            line_height: spec.line_height_px.map(|px| px / size),
            // Figma pixels to thousandths of an em.
            letter_spacing: spec.letter_spacing_px / size * 1000.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        });
        self.objects.push(text);
        Self::effects(node, &mut subs);
        self.entry(node, ImportTier::Native, true, subs);
        Some(node.id.clone())
    }

    fn add(&mut self, node: &FigmaNode, depth: usize) -> Result<Option<String>, ImportFailure> {
        self.count += 1;
        if self.count > MAX_NODES {
            return Err(ImportFailure::Malformed(format!(
                "more than {MAX_NODES} nodes: import one smaller frame at a time"
            )));
        }
        if depth > MAX_DEPTH {
            return Err(ImportFailure::Malformed(format!(
                "nested deeper than {MAX_DEPTH} levels"
            )));
        }
        if !node.width.is_finite()
            || !node.height.is_finite()
            || !node.x.is_finite()
            || !node.y.is_finite()
        {
            return Err(ImportFailure::Malformed(format!(
                "node {} has a position or size that is not a number",
                node.id
            )));
        }
        if node.text.is_some() || node.kind == "text" {
            if node.text.is_some() {
                return Ok(self.text(node));
            }
            // A text node whose text was not read: keep its place and say what is missing.
            let mut subs = vec![substitution(
                "figma:text content, font and style",
                "an empty box where the text goes",
                "the frame was handed over without this node's text",
                RefusalSeverity::Warning,
            )];
            let base = self.base(node, &mut subs);
            self.objects
                .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
            self.entry(node, ImportTier::Flattened, true, subs);
            return Ok(Some(node.id.clone()));
        }
        let mut subs = Vec::new();
        match node.kind.as_str() {
            "rectangle" | "rounded-rectangle" => {
                let picture = self.picture(&node.fills, &mut subs);
                let mut base = self.base(node, &mut subs);
                if picture.is_none() {
                    base.fill = paint_of(&node.fills, "fill", node.width, node.height, &mut subs);
                }
                Self::stroke(node, &mut base, &mut subs);
                let radius = Self::radius(node, &mut subs);
                let object = match &picture {
                    Some((item, fit)) => {
                        if radius > 0.0 {
                            subs.push(substitution(
                                "figma:corner radius on a picture",
                                "square corners",
                                "a picture is drawn in its box; rounded corners need a mask",
                                RefusalSeverity::Warning,
                            ));
                        }
                        Self::image_object(base, item, *fit)
                    }
                    None => SceneObject::Rect(RectObject { base, radius }),
                };
                self.objects.push(object);
                Self::effects(node, &mut subs);
                self.entry(node, ImportTier::Native, true, subs);
                Ok(Some(node.id.clone()))
            }
            "ellipse" => {
                let picture = self.picture(&node.fills, &mut subs);
                let mut base = self.base(node, &mut subs);
                if picture.is_none() {
                    base.fill = paint_of(&node.fills, "fill", node.width, node.height, &mut subs);
                }
                Self::stroke(node, &mut base, &mut subs);
                let object = match &picture {
                    Some((item, fit)) => {
                        subs.push(substitution(
                            "figma:ellipse crop of a picture",
                            "the picture in its box",
                            "a picture is drawn in its box; an elliptical crop needs a mask",
                            RefusalSeverity::Warning,
                        ));
                        Self::image_object(base, item, *fit)
                    }
                    None => SceneObject::Ellipse(EllipseObject { base }),
                };
                self.objects.push(object);
                Self::effects(node, &mut subs);
                self.entry(node, ImportTier::Native, true, subs);
                Ok(Some(node.id.clone()))
            }
            _ if !node.children.is_empty() => {
                let mut group_subs = Vec::new();
                let base = self.base(node, &mut group_subs);
                let index = self.objects.len();
                self.objects.push(SceneObject::Group(GroupObject {
                    base,
                    child_ids: Vec::new(),
                    clip_child_id: None,
                }));
                let mut child_ids = Vec::new();
                // A group paints nothing, so a frame's own fill, stroke and corners become a
                // rectangle behind its children.
                let mut paint_subs = Vec::new();
                let picture = self.picture(&node.fills, &mut paint_subs);
                let fill = if picture.is_none() {
                    paint_of(
                        &node.fills,
                        "fill",
                        node.width,
                        node.height,
                        &mut paint_subs,
                    )
                } else {
                    None
                };
                let mut backing = ObjectBase::new(
                    format!("{}::fill", node.id),
                    format!("{} · fill", node.name),
                );
                backing.width = node.width.max(0.0);
                backing.height = node.height.max(0.0);
                backing.fill = fill;
                backing.visible = node.visible;
                backing.z_index = self.z;
                self.z += 1;
                Self::stroke(node, &mut backing, &mut paint_subs);
                let has_paint =
                    backing.fill.is_some() || backing.stroke.is_some() || picture.is_some();
                if has_paint {
                    // The group is placed at the frame's position; the backing sits at its origin
                    // in scene coordinates like every other child.
                    backing.x = node.x;
                    backing.y = node.y;
                    let radius = Self::radius(node, &mut paint_subs);
                    child_ids.push(backing.id.clone());
                    let object = match &picture {
                        Some((item, fit)) => Self::image_object(backing, item, *fit),
                        None => SceneObject::Rect(RectObject {
                            base: backing,
                            radius,
                        }),
                    };
                    self.objects.push(object);
                    group_subs.push(substitution(
                        &format!("figma:{} fill, stroke and corners", node.kind),
                        "a rectangle behind the children",
                        "a group paints nothing, so the frame's own paint is its own object",
                        RefusalSeverity::Info,
                    ));
                    group_subs.extend(paint_subs);
                } else {
                    group_subs.extend(paint_subs);
                }
                if node.clips_content {
                    group_subs.push(substitution(
                        &format!("figma:{} clip content", node.kind),
                        "no clip",
                        "clipping is a nested clip composition (build plan 11.47), not mapped yet",
                        RefusalSeverity::Warning,
                    ));
                }
                Self::effects(node, &mut group_subs);
                for child in &node.children {
                    if let Some(id) = self.add(child, depth + 1)? {
                        child_ids.push(id);
                    }
                }
                if let SceneObject::Group(group) = &mut self.objects[index] {
                    group.child_ids = child_ids;
                }
                // A group is the native kind for a Figma group: only a frame whose paint, clip or
                // effects had to be moved or dropped is a container, and it says why.
                let tier = if group_subs.is_empty() {
                    ImportTier::Native
                } else {
                    ImportTier::Container
                };
                self.entry(node, tier, true, group_subs);
                Ok(Some(node.id.clone()))
            }
            // A leaf of another kind (vector, line, star, polygon, boolean operation, an
            // instance with no children): its outline is not carried, so its paint is drawn in
            // its bounding box and the report says it is a box.
            other => {
                let picture = self.picture(&node.fills, &mut subs);
                let mut base = self.base(node, &mut subs);
                if picture.is_none() {
                    base.fill = paint_of(&node.fills, "fill", node.width, node.height, &mut subs);
                }
                Self::stroke(node, &mut base, &mut subs);
                let tier = match &picture {
                    // Its rendering, as the exported PNG or WebP: pixels, so the lowest tier,
                    // but the right ones.
                    Some((item, fit)) => {
                        subs.push(substitution(
                            &format!("figma:{other} as a picture"),
                            "the exported picture",
                            "vector geometry is not carried; the picture is its rendering, so it no longer scales or edits as a shape",
                            RefusalSeverity::Info,
                        ));
                        self.objects.push(Self::image_object(base, item, *fit));
                        ImportTier::Rasterized
                    }
                    None => {
                        subs.push(substitution(
                            &format!("figma:{other} outline"),
                            "its bounding rectangle",
                            "vector geometry is not carried by this import; export the node as a picture and file it, or as SVG and import that for its shape",
                            RefusalSeverity::Warning,
                        ));
                        self.objects
                            .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
                        ImportTier::Flattened
                    }
                };
                Self::effects(node, &mut subs);
                self.entry(node, tier, true, subs);
                Ok(Some(node.id.clone()))
            }
        }
    }
}

/// Import one frame, as an agent wrote it, into a scene, reporting every departure. Picture
/// fills are named on the report; use [`import_figma_frame_with`] to draw the ones the project holds.
pub fn import_figma_frame(
    source_name: &str,
    frame: &FigmaNode,
    scene_id: &str,
) -> Result<ImportOutcome, ImportFailure> {
    import_figma_frame_with(source_name, frame, scene_id, None)
}

/// As [`import_figma_frame`], with a way to find the pictures the frame's fills name.
pub fn import_figma_frame_with(
    source_name: &str,
    frame: &FigmaNode,
    scene_id: &str,
    pictures: Option<&PictureLookup<'_>>,
) -> Result<ImportOutcome, ImportFailure> {
    let bad_side = |v: f64| !(1.0..=MAX_SIDE).contains(&v);
    if bad_side(frame.width) || bad_side(frame.height) {
        return Err(ImportFailure::Malformed(format!(
            "the root frame is {} by {}; a scene needs 1 to {MAX_SIDE} pixels each way",
            frame.width, frame.height
        )));
    }
    let mut builder = Builder {
        objects: Vec::new(),
        entries: Vec::new(),
        fonts: BTreeMap::new(),
        pictures,
        assets: Vec::new(),
        z: 0,
        count: 1,
    };
    // The root is the canvas; its children are already relative to its top-left.
    let mut root_subs = Vec::new();
    let picture = builder.picture(&frame.fills, &mut root_subs);
    let background = if picture.is_none() {
        paint_of(
            &frame.fills,
            "fill",
            frame.width,
            frame.height,
            &mut root_subs,
        )
    } else {
        None
    };
    if background.is_some() || picture.is_some() {
        // The canvas has no background of its own, so the frame's fill is the bottom object.
        let mut base = ObjectBase::new(
            format!("{}::fill", frame.id),
            format!("{} · fill", frame.name),
        );
        base.width = frame.width;
        base.height = frame.height;
        base.fill = background;
        base.z_index = builder.z;
        builder.z += 1;
        builder.objects.push(match &picture {
            Some((item, fit)) => Builder::image_object(base, item, *fit),
            None => SceneObject::Rect(RectObject { base, radius: 0.0 }),
        });
        root_subs.push(substitution(
            &format!("figma:{} fill", frame.kind),
            "a rectangle the size of the canvas, at the bottom",
            "the canvas has no background of its own",
            RefusalSeverity::Info,
        ));
    }
    if frame.clips_content {
        root_subs.push(substitution(
            &format!("figma:{} clip content", frame.kind),
            "the canvas edge",
            "the canvas already crops to its size",
            RefusalSeverity::Info,
        ));
    }
    Builder::effects(frame, &mut root_subs);
    for child in &frame.children {
        builder.add(child, 1)?;
    }
    // The root's own entry always carries something: the canvas replaces a frame.
    root_subs.push(substitution(
        &format!("figma:{} as the scene", frame.kind),
        "the scene canvas",
        "a frame is one scene (18.3)",
        RefusalSeverity::Info,
    ));
    builder.entries.push(ImportEntry {
        source_id: frame.id.clone(),
        source_name: frame.name.clone(),
        tier: ImportTier::Container,
        object_id: None,
        substitutions: root_subs,
    });

    let source = canonical_source(frame);
    let scene = SceneDocument {
        working_color_space: gx_contracts::color::WorkingColorSpace::Srgb,
        color_depth: gx_contracts::color::ColorDepth::NEW_PROJECT,
        id: scene_id.to_owned(),
        name: if frame.name.trim().is_empty() {
            frame.id.clone()
        } else {
            frame.name.clone()
        },
        version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: frame.width.round() as u32,
            height: frame.height.round() as u32,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline {
            duration_frames: 1,
            ..Default::default()
        },
        data_context: Default::default(),
        assets: std::iter::once(retained_source(
            source_name,
            source.as_bytes(),
            SourceKind::FigmaFrame,
        ))
        .chain(builder.assets)
        .collect(),
        fonts: builder.fonts.into_values().collect(),
        materials: Vec::new(),
        controls: Vec::new(),
        text_styles: Vec::new(),
        path_links: Vec::new(),
        guides: Vec::new(),
        scene_label: None,
        objects: builder.objects,
    };
    let report = ImportReport {
        source_format: "figma".into(),
        source_name: source_name.to_owned(),
        source_hash: Some(content_hash(source.as_bytes())),
        entries: builder.entries,
    };
    report
        .validate()
        .map_err(|error| ImportFailure::UnexplainedLoss(error.to_string()))?;
    Ok(ImportOutcome { scene, report })
}

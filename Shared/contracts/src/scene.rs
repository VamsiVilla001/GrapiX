//! The scene document (1.1), the object catalogue (1.2) and the asset library
//! addressing it embeds (1.7).
//!
//! 1.1 landed a lean core: the document shell and five object kinds. 1.2
//! completes the catalogue — all thirteen authorable kinds the 1.x tree
//! shipped, each with the authored property surface a renderer or an
//! inspector needs, plus the hierarchy resolver that composes them. Carried
//! forward per ADR-0002 A.4: port, don't redesign. The kind list is held
//! against 1.x's own machine-readable claim
//! (`Shared/shared-types/contracts/program-object-types.json` on branch
//! `Basic-v0.4-2026-09-06-project-container-material-library`) by a test.
//!
//! What the catalogue deliberately does not carry, and which step owns it:
//!
//! - Rich colour values — gradients behind `fill`/`stroke` — are **1.4**.
//! - Fit, blend and cull enums (an image's fit, a slab's culling, the value
//!   type of `material_slots`) are **1.3**, the step that exists to make
//!   them single-sourced.
//! - Per-property keyframe channels, path morphing and trim animation are
//!   the motion schema (**1.6**) and the timeline (**11.10**). The static
//!   authored values they animate are here.
//! - 1.x's layer masks, Photoshop layer styles, blending options and
//!   `importedDesign` provenance are **outside 2.0's planned scope**: no
//!   step in `GrapiX-Build-Plan.md` owns a design importer or a mask
//!   compositor. They are not deferred to an unnamed step.
//! - 1.x's `src` path on image and mesh is not ported. A scene addresses an
//!   asset by id and content hash, never by a path (invariant 31).
//!
//! Two invariants this module exists to keep unbreakable:
//!
//! - **1.7 / invariant 31**: an asset is addressed two ways — content hash
//!   (the store) and project-relative path (the library) — and both are
//!   retained, so replacing a file in place keeps bindings intact. The
//!   `AssetRef` enum is the two-address model; `AssetLibraryItem` carries
//!   both.
//! - **1.1's done-when**: the document round-trips Rust ↔ TypeScript with no
//!   loss, because the TS is generated from these types (invariant 22) and
//!   the round-trip test pins the exact JSON.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::font::FontDefinition;
use crate::{ContentHash, RationalRate, Revision};

// ---------------------------------------------------------------------------
// Assets — the library side of the two-address model (1.7).
// ---------------------------------------------------------------------------

/// The kind of thing an asset is. `Font` is here so the asset store and the
/// font subsystem agree on what a font asset is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Image,
    Video,
    Svg,
    Font,
    Model,
    ImageSequence,
    Wgsl,
    Script,
    Live,
    RenderTexture,
    Json,
    Lut,
    Unknown,
}

/// Whether an asset's bytes are available where they are needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AssetAvailability {
    Ready,
    Missing,
    Importing,
    Unsupported,
    Error,
}

/// An asset as the library knows it. Carries **both** addresses: the content
/// hash (immutable, addresses the store) and the project-relative path
/// (mutable, addresses the library). The hash is what a scene's bindings
/// resolve against, so re-importing over the same path — a new render of the
/// same logo — updates the hash but never the binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AssetLibraryItem {
    /// Stable scene-facing id. Survives relink; distinct from any storage id.
    pub asset_id: String,
    /// Display name, separate from the on-disk name (ADR-0002 B.3).
    pub name: String,
    pub kind: AssetKind,
    /// Project-relative path — the library address.
    pub path: String,
    /// Content hash — the store address. `None` only while importing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checksum: Option<ContentHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<AssetAvailability>,
}

impl AssetLibraryItem {
    /// Replace the bytes an asset points at, in place. The path (library
    /// address) and the asset id are untouched; only the content hash moves.
    /// This is the operation invariant 31 exists to keep cheap: a binding
    /// that references the asset id sees the new bytes with no edit.
    pub fn replace_bytes_in_place(&mut self, new_hash: ContentHash, new_size: Option<u64>) {
        self.checksum = Some(new_hash);
        if let Some(size) = new_size {
            self.size_bytes = Some(size);
        }
    }
}

// ---------------------------------------------------------------------------
// Canvas, timeline, data context — the document shell.
// ---------------------------------------------------------------------------

/// The scene's output canvas. Resolution and rate are configuration, never
/// constants (ADR-0002 Part C), and the rate is rational (invariant 12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SceneCanvas {
    pub width: u32,
    pub height: u32,
    pub frame_rate: RationalRate,
}

/// The scene timeline. Minimal for the lean core: duration and markers. The
/// keyframe model lands with the motion consumers that read it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SceneTimeline {
    /// Total duration in frames at the canvas rate.
    pub duration_frames: u64,
}

/// The live data a scene's bindings resolve against. Opaque here — the
/// binding contract (a later phase) owns the path grammar.
pub type DataContext = serde_json::Map<String, serde_json::Value>;

// ---------------------------------------------------------------------------
// Objects — the lean union. Adding a kind is an additive, reviewed change.
// ---------------------------------------------------------------------------

/// A 2D point in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// A 3D point in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Transform, box and appearance state every object carries — the shared core
/// the hierarchy resolver composes and the inspector edits. Ported from 1.x
/// `BaseSceneObject`; what was left behind is listed in the module doc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectBase {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    /// 0–1.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Translation in scene coordinates (top-left authoring origin).
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// Depth along the view axis; composes additively down the hierarchy.
    #[serde(default)]
    pub z_depth: f64,
    /// Draw order within a layer.
    #[serde(default)]
    pub z_index: i32,
    /// The layer this object belongs to (a `Layer` object's id), or empty for
    /// the implicit default layer.
    #[serde(default)]
    pub layer_id: String,
    /// The object's box, in scene units. Every kind has one: a rect and an
    /// image fill it, an ellipse is inscribed in it, paragraph text wraps
    /// inside it, and a binding can drive it — which is why it is on the base
    /// and not repeated per kind.
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    /// Rotation in degrees. `rotation` is the Z axis; X and Y are 3D and
    /// compose down the hierarchy only on meshes (`resolve_hierarchy`).
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub rotation_x: f64,
    #[serde(default)]
    pub rotation_y: f64,
    #[serde(default = "default_scale")]
    pub scale_x: f64,
    #[serde(default = "default_scale")]
    pub scale_y: f64,
    #[serde(default = "default_scale")]
    pub scale_z: f64,
    /// Object-local pivot in scene pixels; renderers apply T(x,y)·R·S·T(-anchor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub anchor: Option<Vec2>,
    /// Primary fill and stroke, as a CSS colour string. The rich colour model
    /// (gradients, tagged source spaces) is 1.4's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stroke: Option<String>,
    #[serde(default)]
    pub stroke_width: f64,
    /// Bound data paths (object property → data-context path). Opaque here;
    /// the binding contract owns the grammar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bindings: Option<serde_json::Map<String, serde_json::Value>>,
    /// Material slot assignments (slot name → material id). Opaque until
    /// 1.3's material model types the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub material_slots: Option<serde_json::Map<String, serde_json::Value>>,
}

fn default_true() -> bool {
    true
}
fn default_opacity() -> f64 {
    1.0
}
fn default_scale() -> f64 {
    1.0
}

impl ObjectBase {
    /// A base with identity transform, an empty box, visible and unlocked.
    /// The common case for building an object; every field is then set by
    /// name.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            visible: true,
            locked: false,
            opacity: 1.0,
            x: 0.0,
            y: 0.0,
            z_depth: 0.0,
            z_index: 0,
            layer_id: String::new(),
            width: 0.0,
            height: 0.0,
            rotation: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            scale_z: 1.0,
            anchor: None,
            fill: None,
            stroke: None,
            stroke_width: 0.0,
            bindings: None,
            material_slots: None,
        }
    }
}

/// Point text grows from its origin; paragraph text wraps inside the base box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextLayout {
    #[default]
    Point,
    Paragraph,
}

/// What to do when shaped text does not fit its box. Never silently clipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextAutoFit {
    #[default]
    None,
    Shrink,
    Fit,
}

/// CSS `writing-mode` values, which is what the shaper (3.6) consumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WritingMode {
    #[default]
    HorizontalTb,
    VerticalRl,
    VerticalLr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum VerticalAlign {
    #[default]
    Top,
    Middle,
    Bottom,
}

/// Base direction. `Auto` resolves from the first strong character, which is
/// what makes bidi text (3.6) correct without the author declaring it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextDirection {
    #[default]
    Auto,
    Ltr,
    Rtl,
}

/// Case applied when the text is drawn, not when it is typed: the authored
/// characters stay as they are, so a data binding can replace the text and
/// the case still applies, and switching it off returns the author's own
/// capitalisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TextCase {
    #[default]
    Original,
    Upper,
    Lower,
    Title,
    SmallCaps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextOverflow {
    #[default]
    Visible,
    Hidden,
    Clip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Underline and strikethrough: drawn from the font's metrics rather than
/// shaped, so they are object state and not part of the font definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextDecoration {
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strikethrough: bool,
}

/// A text object. The font is referenced by id into the scene's font list —
/// never by a system family name (ADR-0002 A.4's one rule), which is why
/// family, weight, style and stretch are on `FontDefinition` and not here.
/// The colour is the base's `fill`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub text: String,
    /// References `FontDefinition::font_id` in the scene's `fonts`.
    pub font_id: String,
    /// Em size in scene units.
    pub size: f64,
    #[serde(default)]
    pub layout: TextLayout,
    #[serde(default)]
    pub auto_fit: TextAutoFit,
    #[serde(default)]
    pub writing_mode: WritingMode,
    #[serde(default)]
    pub vertical_align: VerticalAlign,
    #[serde(default)]
    pub direction: TextDirection,
    #[serde(default)]
    pub text_case: TextCase,
    #[serde(default)]
    pub decoration: TextDecoration,
    #[serde(default)]
    pub overflow: TextOverflow,
    #[serde(default)]
    pub align: TextAlign,
    /// Line height as a multiple of `size`. Absent means the font's own
    /// metrics, which is not the same as 1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line_height: Option<f64>,
    /// Tracking, in thousandths of an em — After Effects' unit.
    #[serde(default)]
    pub letter_spacing: f64,
    #[serde(default)]
    pub word_spacing: f64,
    /// Space between paragraphs, in scene units.
    #[serde(default)]
    pub paragraph_spacing: f64,
    /// First-line indent, in scene units.
    #[serde(default)]
    pub text_indent: f64,
}

/// A rectangle filling the base box. `radius` is the corner radius.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RectObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    #[serde(default)]
    pub radius: f64,
}

/// An ellipse inscribed in the base box. It carries no fields of its own —
/// the box is the ellipse, and the fill and stroke are the base's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EllipseObject {
    #[serde(flatten)]
    pub base: ObjectBase,
}

/// An image drawn into the base box. The asset is referenced by id into the
/// scene's asset library — the stable address, so a replace-in-place keeps
/// this binding (1.7). How the pixels fit the box is 1.3's fit enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImageObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    /// References `AssetLibraryItem::asset_id` in the scene's `assets`.
    pub asset_id: String,
}

/// A group: a hierarchy container that affects descendants but paints no
/// pixels. Children are object ids, in scene order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GroupObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    #[serde(default)]
    pub child_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// The remaining catalogue kinds (1.2). Each carries the full shared base plus
// the fields that make the kind what it is.
// ---------------------------------------------------------------------------

/// A polyline in object-local coordinates, stroked with the base's stroke.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LineObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub points: Vec<Vec2>,
}

/// A cubic bezier path, structured like Lottie/Bodymovin's "sh" shape so it
/// round-trips with the web's proven vector-animation format. Segment k→k+1 is
/// a cubic bezier; tangents are relative to their vertex. All three arrays
/// must be the same length — the constraint that also makes a path animatable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BezierPath {
    pub closed: bool,
    pub vertices: Vec<Vec2>,
    pub in_tangents: Vec<Vec2>,
    pub out_tangents: Vec<Vec2>,
}

/// An After-Effects-style shape layer: a bezier path with fill and stroke
/// (the base carries both) and AE's Trim Paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShapeObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub path: BezierPath,
    /// Additional subpaths for compound paths; `path` remains primary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compound_paths: Option<Vec<BezierPath>>,
    #[serde(default = "default_true")]
    pub fill_enabled: bool,
    #[serde(default)]
    pub stroke_enabled: bool,
    #[serde(default)]
    pub fill_rule: FillRule,
    /// AE Trim Paths, as percentages of the path's total length: the stroke
    /// draws from `trim_start` to `trim_end`, rotated by `trim_offset`.
    /// Absent — or 0/100/0 — draws the whole stroke. The window is
    /// stroke-only; the fill always covers the whole region, which is what
    /// separates a wipe reveal from a scaling mask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trim_start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trim_end: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trim_offset: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FillRule {
    #[default]
    Nonzero,
    Evenodd,
}

/// A brush point: position, pressure, time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
pub struct BrushPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pressure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BrushBlendMode {
    Normal,
    Multiply,
    Screen,
    Add,
    Erase,
}

/// One paint stroke.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PaintStroke {
    pub id: String,
    pub points: Vec<BrushPoint>,
    pub size: f64,
    pub hardness: f64,
    pub opacity: f64,
    pub flow: f64,
    pub spacing: f64,
    pub smoothing: f64,
    pub roundness: f64,
    pub angle: f64,
    pub color: String,
    pub blend_mode: BrushBlendMode,
}

/// A paint object: a set of strokes composited with one blend mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PaintObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    #[serde(default)]
    pub strokes: Vec<PaintStroke>,
    pub paint_blend_mode: BrushBlendMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MeshPrimitiveKind {
    Model,
    Cube,
    Sphere,
    Cylinder,
    Torus,
    Slab,
}

/// One bevel of a slab, measured inward from its outline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlabBevel {
    pub enabled: bool,
    /// Width of the bevel, inward from the slab outline, in scene units.
    pub size: f64,
    /// Z depth the bevel occupies, in scene units.
    pub depth: f64,
}

/// XPression-style slab controls: a rounded, skewed extrusion with
/// independent front and back bevels. Geometry only — face culling is a
/// material property and arrives with 1.3's material model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlabProperties {
    /// Corner radius of the slab outline, in scene units.
    pub corner_radius: f64,
    /// Curved-corner tessellation quality.
    pub corner_segments: u32,
    /// Horizontal displacement between the slab's bottom and top edges.
    pub skew: f64,
    /// Whether texture coordinates follow the skewed outline.
    #[serde(default)]
    pub skew_texture: bool,
    pub front_bevel: SlabBevel,
    pub back_bevel: SlabBevel,
}

impl Default for SlabProperties {
    /// 1.x's `DEFAULT_SLAB_PROPERTIES`, carried forward so a slab authored in
    /// either tree has the same shape.
    fn default() -> Self {
        Self {
            corner_radius: 18.0,
            corner_segments: 6,
            skew: 0.0,
            skew_texture: false,
            front_bevel: SlabBevel {
                enabled: true,
                size: 6.0,
                depth: 4.0,
            },
            back_bevel: SlabBevel {
                enabled: false,
                size: 6.0,
                depth: 4.0,
            },
        }
    }
}

/// A 3D mesh: a primitive or an imported glTF model. Meshes are the only
/// objects whose X/Y rotations compose down the hierarchy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MeshObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub mesh_kind: MeshPrimitiveKind,
    /// Extrusion depth in scene units.
    pub depth: f64,
    /// Slab controls. Present only for `MeshPrimitiveKind::Slab`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slab: Option<SlabProperties>,
    /// References an `AssetLibraryItem` of kind `Model`. Required by
    /// `MeshPrimitiveKind::Model` and meaningless for the primitives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_asset_id: Option<String>,
    /// Ordered material element names read from the imported model's
    /// metadata, so per-element assignment (3.7) has stable names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub material_elements: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub anchor_3d: Option<Vec3>,
    /// The model's animation clip to play, by name or by index. The keyframe
    /// channels that animate this object's own properties are 1.6's; this
    /// selects an animation baked into the asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clip_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clip_index: Option<u32>,
    /// Playback rate multiplier for the selected clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_scale: Option<f64>,
    /// Frames to shift the clip by, relative to the scene timeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_offset: Option<i32>,
    #[serde(default)]
    pub animation_loop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LightKind {
    Directional,
    Point,
    Spot,
}

/// A light source. Affects meshes; paints no pixels itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LightObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub light_kind: LightKind,
    pub intensity: f64,
    pub color: String,
    /// Distance at which a point or spot light's intensity reaches zero.
    /// Absent means no cut-off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub range: Option<f64>,
    /// Falloff exponent over `range`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decay: Option<f64>,
    /// Spot cone half-angle in degrees, and the 0–1 softness of its edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cone_angle_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub penumbra: Option<f64>,
    /// Point the light aims at, for directional and spot lights.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target: Option<Vec3>,
    #[serde(default)]
    pub cast_shadow: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CameraKind {
    Perspective,
    Orthographic,
}

/// A camera. The scene's active camera selects the Program view; absence
/// means the synthetic 2D orthographic camera.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CameraObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub camera_kind: CameraKind,
    /// Vertical field of view in degrees. Perspective only.
    pub fov: f64,
    /// Orthographic zoom. 1.0 is one scene unit per canvas pixel.
    pub zoom: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub near: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub far: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target: Option<Vec3>,
    /// Up vector. Absent means +Y.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub up: Option<Vec3>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LayerKind {
    Object,
    Camera,
}

/// A layer: a hierarchy container like a group, with a kind. Paints no pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LayerObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub layer_kind: LayerKind,
    #[serde(default)]
    pub child_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MarkerKind {
    Event,
}

/// A named marker that emits an event when the playhead reaches its frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarkerObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub marker_kind: MarkerKind,
    pub event_name: String,
}

/// The authorable object kinds. A tagged enum, not an open struct: the set of
/// kinds a scene may contain is a reviewed contract, and the renderer refuses
/// a kind it does not know by name rather than ignoring it (invariant 18).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SceneObject {
    Text(TextObject),
    Rect(RectObject),
    Ellipse(EllipseObject),
    Image(ImageObject),
    Line(LineObject),
    Shape(ShapeObject),
    Paint(PaintObject),
    Mesh(MeshObject),
    Light(LightObject),
    Camera(CameraObject),
    Layer(LayerObject),
    Marker(MarkerObject),
    Group(GroupObject),
}

impl SceneObject {
    pub fn base(&self) -> &ObjectBase {
        match self {
            SceneObject::Text(o) => &o.base,
            SceneObject::Rect(o) => &o.base,
            SceneObject::Ellipse(o) => &o.base,
            SceneObject::Image(o) => &o.base,
            SceneObject::Line(o) => &o.base,
            SceneObject::Shape(o) => &o.base,
            SceneObject::Paint(o) => &o.base,
            SceneObject::Mesh(o) => &o.base,
            SceneObject::Light(o) => &o.base,
            SceneObject::Camera(o) => &o.base,
            SceneObject::Layer(o) => &o.base,
            SceneObject::Marker(o) => &o.base,
            SceneObject::Group(o) => &o.base,
        }
    }

    /// Whether this kind is a hierarchy container (layer or group). Only
    /// containers claim children in the resolver.
    pub fn is_container(&self) -> bool {
        matches!(self, SceneObject::Layer(_) | SceneObject::Group(_))
    }

    /// The child ids a container claims, in scene order.
    pub fn child_ids(&self) -> &[String] {
        match self {
            SceneObject::Layer(o) => &o.child_ids,
            SceneObject::Group(o) => &o.child_ids,
            _ => &[],
        }
    }
}

// ---------------------------------------------------------------------------
// Hierarchy resolution (1.2). Ported from 1.x `resolveSceneObjectHierarchy`.
//
// Containers (layer, group) claim children by id in scene order; a child
// belongs to the first valid parent that claims it. Missing, self-referential,
// later-parent and cyclic edges are ignored and reported — never silently
// dropped, and never fatal: a scene being repaired in the editor still
// resolves deterministically.
// ---------------------------------------------------------------------------

/// Why an edge was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum HierarchyDiagnosticCode {
    MissingChild,
    SelfReference,
    MultipleParents,
    Cycle,
}

/// An edge the resolver refused, with the reason. The scene still resolves;
/// the diagnostic is how the editor surfaces what was dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyDiagnostic {
    pub code: HierarchyDiagnosticCode,
    pub parent_id: String,
    pub child_id: String,
    /// Set when a later parent loses to the first ordered parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub existing_parent_id: Option<String>,
}

/// The inherited state a parent passes down. Transform composes as a 2D
/// affine (T·R·S·T(-anchor)); the scalar fields compose by their own rule.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Inherited {
    // 2D affine: [a c tx; b d ty].
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    tx: f64,
    ty: f64,
    z_depth: f64,
    rotation_x: f64,
    rotation_y: f64,
    rotation_z: f64,
    scale_x: f64,
    scale_y: f64,
    scale_z: f64,
    visible: bool,
    opacity: f64,
    locked: bool,
}

const IDENTITY: Inherited = Inherited {
    a: 1.0,
    b: 0.0,
    c: 0.0,
    d: 1.0,
    tx: 0.0,
    ty: 0.0,
    z_depth: 0.0,
    rotation_x: 0.0,
    rotation_y: 0.0,
    rotation_z: 0.0,
    scale_x: 1.0,
    scale_y: 1.0,
    scale_z: 1.0,
    visible: true,
    opacity: 1.0,
    locked: false,
};

impl Inherited {
    fn affine(self) -> (f64, f64, f64, f64, f64, f64) {
        (self.a, self.b, self.c, self.d, self.tx, self.ty)
    }
}

/// An object with its effective inherited transform and state applied.
///
/// Serialisable because the Editor consumes this result rather than
/// reimplementing it: `resolve_hierarchy` is the single implementation of the
/// composition rules (invariant 22), and this is the shape it returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedObject {
    pub id: String,
    /// Effective position of the object's origin in scene coordinates, after
    /// every ancestor's transform. The object's own rotation, scale and
    /// anchor are reported separately and applied by the renderer around this
    /// point, so the anchor is deliberately not folded in here.
    pub x: f64,
    pub y: f64,
    pub z_depth: f64,
    /// Effective Z rotation, in degrees.
    pub rotation_z: f64,
    /// Effective X and Y rotation. These compose down the hierarchy only on
    /// meshes; on every other kind they are the authored values. That is 1.x's
    /// rule carried forward — a 2D object does not inherit a parent's 3D tilt.
    pub rotation_x: f64,
    pub rotation_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub scale_z: f64,
    pub visible: bool,
    pub opacity: f64,
    pub locked: bool,
    /// True for layer and group. A container is never drawn; its transform
    /// reaches a frame only through its descendants.
    pub is_container: bool,
}

/// An accepted parent → child edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyEdge {
    pub parent_id: String,
    pub child_id: String,
}

/// A container's accepted children, in the order it claimed them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyChildren {
    pub parent_id: String,
    pub child_ids: Vec<String>,
}

/// The result of resolving a scene's hierarchy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyResolution {
    /// Every object's effective state, in the document's source order.
    /// Containers are included and marked, because the editor needs a group's
    /// effective placement even though nothing draws it.
    pub effective: Vec<ResolvedObject>,
    /// The accepted edges, in the order they were taken.
    pub edges: Vec<HierarchyEdge>,
    /// Each container's accepted, validated child order, in source order.
    pub children_by_parent: Vec<HierarchyChildren>,
    /// Every refused edge, in the order encountered. A refusal is reported and
    /// never fatal: a scene being repaired in the editor still resolves.
    pub diagnostics: Vec<HierarchyDiagnostic>,
}

impl HierarchyResolution {
    /// The objects that draw: everything that is not a container.
    pub fn renderable(&self) -> impl Iterator<Item = &ResolvedObject> {
        self.effective.iter().filter(|o| !o.is_container)
    }

    /// The containers, for editor guides and hierarchy inspectors.
    pub fn containers(&self) -> impl Iterator<Item = &ResolvedObject> {
        self.effective.iter().filter(|o| o.is_container)
    }

    /// The accepted parent of one child, if it has one.
    pub fn parent_of(&self, child_id: &str) -> Option<&str> {
        self.edges
            .iter()
            .find(|edge| edge.child_id == child_id)
            .map(|edge| edge.parent_id.as_str())
    }
}

/// Resolve the layer/group hierarchy without mutating the authored objects.
///
/// A child belongs to the first valid parent that claims it. Scales multiply,
/// rotations and z-depth add, visibility ANDs, opacity multiplies and lock
/// ORs — the composition rules 1.x's renderers depended on, ported from
/// `resolveSceneObjectHierarchy`.
///
/// The result does not depend on array order: the walk starts from the roots,
/// so a child declared before its parent still inherits.
pub fn resolve_hierarchy(objects: &[SceneObject]) -> HierarchyResolution {
    // Duplicate ids are a preflight error. Keeping the *first* here keeps
    // resolution deterministic while an invalid scene is being repaired in the
    // editor, which is what 1.x did; an object the map does not hold owns no
    // id, so it claims no children.
    let mut by_id: HashMap<&str, &SceneObject> = HashMap::with_capacity(objects.len());
    for object in objects {
        by_id.entry(object.base().id.as_str()).or_insert(object);
    }
    let owns_id = |object: &SceneObject| {
        by_id
            .get(object.base().id.as_str())
            .is_some_and(|held| std::ptr::eq(*held, object))
    };

    let mut diagnostics: Vec<HierarchyDiagnostic> = Vec::new();
    let mut parent_by_child: HashMap<&str, &str> = HashMap::new();
    let mut edges: Vec<HierarchyEdge> = Vec::new();
    let mut accepted_by_parent: HashMap<&str, Vec<&str>> = HashMap::new();

    for parent in objects {
        if !parent.is_container() || !owns_id(parent) {
            continue;
        }
        let parent_id = parent.base().id.as_str();
        for child in parent.child_ids() {
            let child_id = child.as_str();
            let refused = if child_id == parent_id {
                Some((HierarchyDiagnosticCode::SelfReference, None))
            } else if !by_id.contains_key(child_id) {
                Some((HierarchyDiagnosticCode::MissingChild, None))
            } else if let Some(existing) = parent_by_child.get(child_id) {
                Some((
                    HierarchyDiagnosticCode::MultipleParents,
                    Some((*existing).to_string()),
                ))
            } else if creates_cycle(parent_id, child_id, &parent_by_child) {
                Some((HierarchyDiagnosticCode::Cycle, None))
            } else {
                None
            };

            match refused {
                Some((code, existing_parent_id)) => diagnostics.push(HierarchyDiagnostic {
                    code,
                    parent_id: parent_id.to_string(),
                    child_id: child.clone(),
                    existing_parent_id,
                }),
                None => {
                    parent_by_child.insert(child_id, parent_id);
                    edges.push(HierarchyEdge {
                        parent_id: parent_id.to_string(),
                        child_id: child.clone(),
                    });
                    accepted_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(child_id);
                }
            }
        }
    }

    let mut resolved: HashMap<&str, ResolvedObject> = HashMap::with_capacity(objects.len());
    // Roots first. Scene order does not guarantee that a parent precedes its
    // child, and a child's effective state is only correct once its parent has
    // been composed, so the array must not decide the walk.
    for object in objects {
        if owns_id(object) && !parent_by_child.contains_key(object.base().id.as_str()) {
            resolve_one(object, IDENTITY, &by_id, &accepted_by_parent, &mut resolved);
        }
    }
    // The accepted edges are acyclic, so every object that owns its id has
    // been reached from a root. This pass only catches a malformed
    // duplicate-id document, so the result is always complete.
    for object in objects {
        if owns_id(object) && !resolved.contains_key(object.base().id.as_str()) {
            resolve_one(object, IDENTITY, &by_id, &accepted_by_parent, &mut resolved);
        }
    }

    // Source order out, so the document's draw order survives resolution.
    let effective: Vec<ResolvedObject> = objects
        .iter()
        .filter_map(|object| resolved.get(object.base().id.as_str()).cloned())
        .collect();
    let children_by_parent: Vec<HierarchyChildren> = objects
        .iter()
        .filter(|object| object.is_container() && owns_id(object))
        .filter_map(|object| {
            let parent_id = object.base().id.as_str();
            accepted_by_parent
                .get(parent_id)
                .map(|children| HierarchyChildren {
                    parent_id: parent_id.to_string(),
                    child_ids: children.iter().map(|id| (*id).to_string()).collect(),
                })
        })
        .collect();

    HierarchyResolution {
        effective,
        edges,
        children_by_parent,
        diagnostics,
    }
}

/// Whether making `parent` a parent of `child` would close a cycle: true when
/// `parent` is already a descendant of `child`.
fn creates_cycle<'a>(
    parent_id: &'a str,
    child_id: &str,
    parent_by_child: &HashMap<&'a str, &'a str>,
) -> bool {
    let mut ancestor = Some(parent_id);
    let mut seen: HashSet<&str> = HashSet::new();
    while let Some(current) = ancestor {
        if current == child_id {
            return true;
        }
        // Defensive: the accepted map is acyclic by construction, so a repeat
        // would mean this function was fed a corrupt one.
        if !seen.insert(current) {
            return true;
        }
        ancestor = parent_by_child.get(current).copied();
    }
    false
}

fn resolve_one<'a>(
    object: &'a SceneObject,
    inherited: Inherited,
    by_id: &HashMap<&'a str, &'a SceneObject>,
    accepted_by_parent: &HashMap<&'a str, Vec<&'a str>>,
    resolved: &mut HashMap<&'a str, ResolvedObject>,
) {
    let base = object.base();
    let id = base.id.as_str();
    if resolved.contains_key(id) {
        return;
    }

    let (x, y) = apply(inherited.affine(), base.x, base.y);
    let rotation_z = inherited.rotation_z + base.rotation;
    let is_mesh = matches!(object, SceneObject::Mesh(_));
    let record = ResolvedObject {
        id: base.id.clone(),
        x,
        y,
        z_depth: inherited.z_depth + base.z_depth,
        rotation_z,
        rotation_x: if is_mesh {
            inherited.rotation_x + base.rotation_x
        } else {
            base.rotation_x
        },
        rotation_y: if is_mesh {
            inherited.rotation_y + base.rotation_y
        } else {
            base.rotation_y
        },
        scale_x: inherited.scale_x * base.scale_x,
        scale_y: inherited.scale_y * base.scale_y,
        scale_z: inherited.scale_z * base.scale_z,
        visible: inherited.visible && base.visible,
        opacity: inherited.opacity * base.opacity,
        locked: inherited.locked || base.locked,
        is_container: object.is_container(),
    };

    if !object.is_container() {
        resolved.insert(id, record);
        return;
    }

    // What a container hands down: its own local space expressed in scene
    // coordinates, plus the composed scalars. X/Y rotation accumulates here
    // whatever the container's kind; only a mesh reads it back out.
    let local_to_scene = multiply(inherited, local_transform(base));
    let next = Inherited {
        a: local_to_scene.0,
        b: local_to_scene.1,
        c: local_to_scene.2,
        d: local_to_scene.3,
        tx: local_to_scene.4,
        ty: local_to_scene.5,
        z_depth: record.z_depth,
        rotation_x: inherited.rotation_x + base.rotation_x,
        rotation_y: inherited.rotation_y + base.rotation_y,
        rotation_z,
        scale_x: record.scale_x,
        scale_y: record.scale_y,
        scale_z: record.scale_z,
        visible: record.visible,
        opacity: record.opacity,
        locked: record.locked,
    };
    resolved.insert(id, record);

    for child_id in accepted_by_parent
        .get(id)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if let Some(child) = by_id.get(*child_id) {
            resolve_one(child, next, by_id, accepted_by_parent, resolved);
        }
    }
}

/// An object's local 2D affine: T(x,y) · R(rotation) · S(scale) · T(-anchor).
fn local_transform(base: &ObjectBase) -> (f64, f64, f64, f64, f64, f64) {
    let (ax, ay) = base.anchor.map(|a| (a.x, a.y)).unwrap_or((0.0, 0.0));
    let rad = base.rotation.to_radians();
    let (sin, cos) = rad.sin_cos();
    let (sx, sy) = (base.scale_x, base.scale_y);
    // R·S = [cos*sx, -sin*sy; sin*sx, cos*sy]
    let a = cos * sx;
    let b = sin * sx;
    let c = -sin * sy;
    let d = cos * sy;
    // Apply T(-anchor): the linear part acts on -anchor, then translate by x,y.
    let tx = base.x + a * -ax + c * -ay;
    let ty = base.y + b * -ax + d * -ay;
    (a, b, c, d, tx, ty)
}

/// Compose parent ∘ local (parent applied first, then local).
fn multiply(p: Inherited, l: (f64, f64, f64, f64, f64, f64)) -> (f64, f64, f64, f64, f64, f64) {
    let (pa, pb, pc, pd, ptx, pty) = (p.a, p.b, p.c, p.d, p.tx, p.ty);
    let (la, lb, lc, ld, ltx, lty) = l;
    (
        pa * la + pc * lb,
        pb * la + pd * lb,
        pa * lc + pc * ld,
        pb * lc + pd * ld,
        pa * ltx + pc * lty + ptx,
        pb * ltx + pd * lty + pty,
    )
}

fn apply(m: (f64, f64, f64, f64, f64, f64), x: f64, y: f64) -> (f64, f64) {
    (m.0 * x + m.2 * y + m.4, m.1 * x + m.3 * y + m.5)
}

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

/// The scene document: the unit the Editor authors, the package carries and
/// the engine prepares. Self-describing — fonts, assets and objects travel
/// together so a published package never depends on outside state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SceneDocument {
    pub id: String,
    pub name: String,
    /// Schema version. A reader refuses a version it does not know by name.
    pub version: u32,
    /// Monotonic authoring revision; the optimistic-concurrency token (0.8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub revision: Option<Revision>,
    pub canvas: SceneCanvas,
    #[serde(default)]
    pub timeline: SceneTimeline,
    /// Live data the scene's bindings resolve against.
    #[serde(default)]
    pub data_context: DataContext,
    /// The asset library this scene references.
    #[serde(default)]
    pub assets: Vec<AssetLibraryItem>,
    /// Fonts available to this scene, resolved package-first.
    #[serde(default)]
    pub fonts: Vec<FontDefinition>,
    /// The scene graph, in draw order.
    #[serde(default)]
    pub objects: Vec<SceneObject>,
}

impl SceneDocument {
    /// Look up an asset by its stable id.
    pub fn asset(&self, asset_id: &str) -> Option<&AssetLibraryItem> {
        self.assets.iter().find(|a| a.asset_id == asset_id)
    }

    /// Look up a font by id.
    pub fn font(&self, font_id: &str) -> Option<&FontDefinition> {
        self.fonts.iter().find(|f| f.font_id == font_id)
    }

    /// Replace an asset's bytes in place (1.7's done-when). The image objects
    /// binding the asset id are untouched and now resolve to the new bytes.
    /// Returns false if no asset carries the id.
    pub fn replace_asset_bytes(
        &mut self,
        asset_id: &str,
        new_hash: ContentHash,
        new_size: Option<u64>,
    ) -> bool {
        match self.assets.iter_mut().find(|a| a.asset_id == asset_id) {
            Some(asset) => {
                asset.replace_bytes_in_place(new_hash, new_size);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1.x's authorable object set, read off its own machine-readable claim:
    /// `programObjectTypes` plus `notRenderedByProgram` in
    /// `Shared/shared-types/contracts/program-object-types.json`, on branch
    /// `Basic-v0.4-2026-09-06-project-container-material-library`. 1.2's
    /// done-when is measured against this list, so a kind that tree could
    /// author and this one cannot is a failing test rather than an opinion.
    const ONE_X_AUTHORABLE_KINDS: [&str; 13] = [
        "rect", "ellipse", "text", "shape", "mesh", "light", "image", "line", "paint", "camera",
        "layer", "marker", "group",
    ];

    fn base(id: &str) -> ObjectBase {
        ObjectBase::new(id, id)
    }

    /// A base with every field set away from its default, so a round-trip
    /// proves the whole shared surface survives the wire — and so that a kind
    /// re-declaring a base field would be caught: `#[serde(flatten)]` emits
    /// the duplicate key twice, the reader keeps the last, and one of the two
    /// values comes back wrong. `fill` was declared on both the base and three
    /// kinds until 1.2.
    fn populated_base(id: &str) -> ObjectBase {
        let mut base = ObjectBase::new(id, format!("{id} name"));
        base.visible = false;
        base.locked = true;
        base.opacity = 0.75;
        base.x = 12.0;
        base.y = 34.0;
        base.z_depth = 5.0;
        base.z_index = 7;
        base.layer_id = "layer_1".into();
        base.width = 640.0;
        base.height = 360.0;
        base.rotation = 15.0;
        base.rotation_x = 25.0;
        base.rotation_y = 35.0;
        base.scale_x = 1.5;
        base.scale_y = 2.5;
        base.scale_z = 3.5;
        base.anchor = Some(Vec2 { x: 4.0, y: 8.0 });
        base.fill = Some("#102030".into());
        base.stroke = Some("#405060".into());
        base.stroke_width = 3.0;
        base.bindings = Some(
            serde_json::json!({ "text": "match.homeScore" })
                .as_object()
                .unwrap()
                .clone(),
        );
        base.material_slots = Some(
            serde_json::json!({ "front": "material_gold" })
                .as_object()
                .unwrap()
                .clone(),
        );
        base
    }

    /// One object of every kind in the catalogue, each with its own fields
    /// populated.
    fn catalogue() -> Vec<SceneObject> {
        vec![
            SceneObject::Text(TextObject {
                base: populated_base("text"),
                text: "Hello".into(),
                font_id: "font_inter".into(),
                size: 72.0,
                layout: TextLayout::Paragraph,
                auto_fit: TextAutoFit::Shrink,
                writing_mode: WritingMode::VerticalRl,
                vertical_align: VerticalAlign::Middle,
                direction: TextDirection::Rtl,
                text_case: TextCase::SmallCaps,
                decoration: TextDecoration {
                    underline: true,
                    strikethrough: false,
                },
                overflow: TextOverflow::Clip,
                align: TextAlign::Center,
                line_height: Some(1.2),
                letter_spacing: 20.0,
                word_spacing: 5.0,
                paragraph_spacing: 12.0,
                text_indent: 8.0,
            }),
            SceneObject::Rect(RectObject {
                base: populated_base("rect"),
                radius: 8.0,
            }),
            SceneObject::Ellipse(EllipseObject {
                base: populated_base("ellipse"),
            }),
            SceneObject::Image(ImageObject {
                base: populated_base("image"),
                asset_id: "asset_logo".into(),
            }),
            SceneObject::Line(LineObject {
                base: populated_base("line"),
                points: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 10.0, y: 4.0 }],
            }),
            SceneObject::Shape(ShapeObject {
                base: populated_base("shape"),
                path: BezierPath {
                    closed: true,
                    vertices: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 10.0, y: 0.0 }],
                    in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: -2.0, y: 0.0 }],
                    out_tangents: vec![Vec2 { x: 2.0, y: 0.0 }, Vec2 { x: 0.0, y: 0.0 }],
                },
                compound_paths: None,
                fill_enabled: true,
                stroke_enabled: true,
                fill_rule: FillRule::Evenodd,
                trim_start: Some(0.0),
                trim_end: Some(60.0),
                trim_offset: Some(10.0),
            }),
            SceneObject::Paint(PaintObject {
                base: populated_base("paint"),
                strokes: vec![PaintStroke {
                    id: "stroke_1".into(),
                    points: vec![BrushPoint {
                        x: 1.0,
                        y: 2.0,
                        pressure: Some(0.5),
                        time: Some(0.25),
                    }],
                    size: 12.0,
                    hardness: 0.8,
                    opacity: 1.0,
                    flow: 0.9,
                    spacing: 0.1,
                    smoothing: 0.3,
                    roundness: 1.0,
                    angle: 0.0,
                    color: "#ff0000".into(),
                    blend_mode: BrushBlendMode::Multiply,
                }],
                paint_blend_mode: BrushBlendMode::Normal,
            }),
            SceneObject::Mesh(MeshObject {
                base: populated_base("mesh"),
                mesh_kind: MeshPrimitiveKind::Slab,
                depth: 20.0,
                slab: Some(SlabProperties::default()),
                model_asset_id: Some("asset_model".into()),
                material_elements: Some(vec!["front".into(), "bevel".into()]),
                anchor_3d: Some(Vec3 {
                    x: 1.0,
                    y: 2.0,
                    z: 3.0,
                }),
                clip_name: Some("intro".into()),
                clip_index: Some(2),
                time_scale: Some(0.5),
                frame_offset: Some(-3),
                animation_loop: true,
            }),
            SceneObject::Light(LightObject {
                base: populated_base("light"),
                light_kind: LightKind::Spot,
                intensity: 2.0,
                color: "#ffffff".into(),
                range: Some(500.0),
                decay: Some(2.0),
                cone_angle_deg: Some(35.0),
                penumbra: Some(0.2),
                target: Some(Vec3 {
                    x: 0.0,
                    y: 0.0,
                    z: -1.0,
                }),
                cast_shadow: true,
            }),
            SceneObject::Camera(CameraObject {
                base: populated_base("camera"),
                camera_kind: CameraKind::Perspective,
                fov: 40.0,
                zoom: 1.0,
                near: Some(0.1),
                far: Some(5000.0),
                target: Some(Vec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                }),
                up: Some(Vec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                }),
            }),
            SceneObject::Layer(LayerObject {
                base: populated_base("layer"),
                layer_kind: LayerKind::Camera,
                child_ids: vec!["camera".into()],
            }),
            SceneObject::Marker(MarkerObject {
                base: populated_base("marker"),
                marker_kind: MarkerKind::Event,
                event_name: "lower_third_in".into(),
            }),
            SceneObject::Group(GroupObject {
                base: populated_base("group"),
                child_ids: vec!["rect".into()],
            }),
        ]
    }

    fn sample_scene() -> SceneDocument {
        let mut bg = base("bg");
        bg.width = 1920.0;
        bg.height = 200.0;
        bg.fill = Some("#102030".into());
        let mut title = base("title");
        title.fill = Some("#ffffff".into());
        let mut logo = base("logo");
        logo.width = 120.0;
        logo.height = 120.0;

        SceneDocument {
            id: "scene_1".into(),
            name: "Lower Third".into(),
            version: 1,
            revision: Some(Revision(3)),
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 250,
            },
            data_context: serde_json::Map::new(),
            assets: vec![AssetLibraryItem {
                asset_id: "asset_logo".into(),
                name: "Logo".into(),
                kind: AssetKind::Image,
                path: "images/logo.png".into(),
                checksum: Some(ContentHash("abc123".into())),
                mime_type: Some("image/png".into()),
                size_bytes: Some(1024),
                status: Some(AssetAvailability::Ready),
            }],
            fonts: vec![],
            objects: vec![
                SceneObject::Rect(RectObject {
                    base: bg,
                    radius: 0.0,
                }),
                SceneObject::Text(TextObject {
                    base: title,
                    text: "Hello".into(),
                    font_id: "font_inter".into(),
                    size: 72.0,
                    layout: TextLayout::Point,
                    auto_fit: TextAutoFit::None,
                    writing_mode: WritingMode::HorizontalTb,
                    vertical_align: VerticalAlign::Top,
                    direction: TextDirection::Auto,
                    text_case: TextCase::Original,
                    decoration: TextDecoration::default(),
                    overflow: TextOverflow::Visible,
                    align: TextAlign::Left,
                    line_height: None,
                    letter_spacing: 0.0,
                    word_spacing: 0.0,
                    paragraph_spacing: 0.0,
                    text_indent: 0.0,
                }),
                SceneObject::Image(ImageObject {
                    base: logo,
                    asset_id: "asset_logo".into(),
                }),
            ],
        }
    }

    fn group(id: &str, children: &[&str]) -> SceneObject {
        SceneObject::Group(GroupObject {
            base: base(id),
            child_ids: children.iter().map(|c| (*c).to_string()).collect(),
        })
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: base(id),
            radius: 0.0,
        })
    }

    fn effective<'a>(resolution: &'a HierarchyResolution, id: &str) -> &'a ResolvedObject {
        resolution
            .effective
            .iter()
            .find(|object| object.id == id)
            .expect("every object resolves")
    }

    #[test]
    fn every_authorable_kind_is_representable() {
        // 1.2's done-when, both halves: the catalogue covers 1.x's authorable
        // set exactly, and every kind survives the wire with every field it
        // carries — including the whole shared base (see `populated_base`).
        let objects = catalogue();
        let wire = serde_json::to_value(&objects).unwrap();
        let tags: std::collections::BTreeSet<&str> = wire
            .as_array()
            .unwrap()
            .iter()
            .map(|object| object["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            tags,
            ONE_X_AUTHORABLE_KINDS.into_iter().collect(),
            "the catalogue must cover 1.x's authorable set exactly"
        );

        let back: Vec<SceneObject> = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(back, objects);

        // Spot-check the wire names a consumer reads: camelCase fields, the
        // kebab-case CSS-derived enums, and the tag.
        assert_eq!(wire[0]["type"], "text");
        assert_eq!(wire[0]["writingMode"], "vertical-rl");
        assert_eq!(wire[0]["textCase"], "small-caps");
        assert_eq!(wire[0]["lineHeight"], 1.2);
        assert_eq!(wire[0]["materialSlots"]["front"], "material_gold");
        assert_eq!(wire[7]["slab"]["cornerRadius"], 18.0);
        assert_eq!(wire[7]["frameOffset"], -3);
        assert_eq!(wire[8]["coneAngleDeg"], 35.0);
    }

    #[test]
    fn an_empty_optional_is_absent_from_the_wire_not_null() {
        // `skip_serializing_if` and `#[ts(optional)]` must stay in step, or
        // the generated TS says `field?: T` about a wire that carries `null`.
        let object = SceneObject::Rect(RectObject {
            base: base("r"),
            radius: 0.0,
        });
        let wire = serde_json::to_value(&object).unwrap();
        let map = wire.as_object().unwrap();
        for absent in ["anchor", "fill", "stroke", "bindings", "materialSlots"] {
            assert!(!map.contains_key(absent), "{absent} should be absent");
        }
    }

    #[test]
    fn a_scene_document_round_trips_through_json() {
        let scene = sample_scene();
        let json = serde_json::to_string(&scene).unwrap();
        let back: SceneDocument = serde_json::from_str(&json).unwrap();
        assert_eq!(back, scene);
        // The wire shape is camelCase and the object tag is `type`.
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["canvas"]["frameRate"]["num"], 50);
        assert_eq!(v["objects"][0]["width"], 1920.0);
        assert_eq!(v["objects"][1]["type"], "text");
        assert_eq!(v["objects"][1]["fontId"], "font_inter");
        assert_eq!(v["assets"][0]["assetId"], "asset_logo");
    }

    #[test]
    fn replacing_asset_bytes_keeps_the_binding() {
        // 1.7's done-when: a replace-in-place changes the hash, and the image
        // object binding the asset id needs no edit to see the new bytes.
        let mut scene = sample_scene();
        let binding_before = match &scene.objects[2] {
            SceneObject::Image(o) => o.asset_id.clone(),
            _ => panic!("expected an image"),
        };
        assert!(scene.replace_asset_bytes("asset_logo", ContentHash("def456".into()), Some(2048)));
        let asset = scene.asset("asset_logo").unwrap();
        assert_eq!(asset.checksum, Some(ContentHash("def456".into())));
        assert_eq!(asset.size_bytes, Some(2048));
        // The library address is untouched.
        assert_eq!(asset.path, "images/logo.png");
        // The binding is the same id — it resolves to the new bytes.
        let binding_after = match &scene.objects[2] {
            SceneObject::Image(o) => o.asset_id.clone(),
            _ => panic!("expected an image"),
        };
        assert_eq!(binding_before, binding_after);
        // An unknown asset id is reported, not silently ignored.
        assert!(!scene.replace_asset_bytes("nosuch", ContentHash("x".into()), None));
    }

    #[test]
    fn an_unknown_object_type_is_refused_not_ignored() {
        // Invariant 18: a kind the schema does not know is a parse error, not
        // a skipped object.
        let bad = r#"{"id":"s","name":"s","version":1,"canvas":{"width":1,"height":1,"frameRate":{"num":25,"den":1}},"objects":[{"type":"hologram","id":"h","name":"h"}]}"#;
        assert!(serde_json::from_str::<SceneDocument>(bad).is_err());
    }

    #[test]
    fn a_child_inherits_its_parents_transform() {
        let mut parent = GroupObject {
            base: base("g"),
            child_ids: vec!["r".into()],
        };
        parent.base.x = 100.0;
        parent.base.y = 50.0;
        parent.base.rotation = 90.0;
        parent.base.scale_x = 2.0;
        parent.base.scale_y = 2.0;
        let mut child = RectObject {
            base: base("r"),
            radius: 0.0,
        };
        child.base.x = 10.0;

        let objects = vec![SceneObject::Group(parent), SceneObject::Rect(child)];
        let resolution = resolve_hierarchy(&objects);
        let child = effective(&resolution, "r");
        // The parent turns a quarter-turn and doubles, so the child's local
        // +10 on X lands 20 further down Y, at the parent's origin on X.
        assert!((child.x - 100.0).abs() < 1e-9, "x was {}", child.x);
        assert!((child.y - 70.0).abs() < 1e-9, "y was {}", child.y);
        assert_eq!(child.rotation_z, 90.0);
        assert_eq!(child.scale_x, 2.0);
        assert_eq!(resolution.parent_of("r"), Some("g"));
        assert!(resolution.diagnostics.is_empty());
    }

    #[test]
    fn composition_runs_the_whole_chain_not_just_one_parent() {
        // Two levels: the inner container's own transform is composed into
        // what it hands down, so a grandchild is placed by the whole chain.
        let mut outer = GroupObject {
            base: base("outer"),
            child_ids: vec!["inner".into()],
        };
        outer.base.x = 100.0;
        outer.base.opacity = 0.5;
        let mut inner = GroupObject {
            base: base("inner"),
            child_ids: vec!["r".into()],
        };
        inner.base.x = 10.0;
        inner.base.scale_x = 2.0;
        inner.base.opacity = 0.5;
        let mut leaf = RectObject {
            base: base("r"),
            radius: 0.0,
        };
        leaf.base.x = 5.0;

        let objects = vec![
            SceneObject::Group(outer),
            SceneObject::Group(inner),
            SceneObject::Rect(leaf),
        ];
        let resolution = resolve_hierarchy(&objects);
        let leaf = effective(&resolution, "r");
        // 100 (outer) + 10 (inner) + 5 × 2 (inner's scale applied to the
        // leaf's offset).
        assert!((leaf.x - 120.0).abs() < 1e-9, "x was {}", leaf.x);
        assert_eq!(leaf.scale_x, 2.0);
        assert!((leaf.opacity - 0.25).abs() < 1e-12);
        assert_eq!(resolution.parent_of("r"), Some("inner"));
        assert_eq!(resolution.parent_of("inner"), Some("outer"));
    }

    #[test]
    fn a_child_declared_before_its_parent_still_inherits() {
        // Resolution walks from the roots, not down the array. Walking the
        // array instead resolves a forward-declared child as a root and its
        // parent's transform is silently lost — the object draws in the wrong
        // place with nothing reported.
        let mut parent = GroupObject {
            base: base("g"),
            child_ids: vec!["r".into()],
        };
        parent.base.y = 50.0;
        parent.base.scale_y = 2.0;
        let mut child = RectObject {
            base: base("r"),
            radius: 0.0,
        };
        child.base.y = 10.0;
        let parent = SceneObject::Group(parent);
        let child = SceneObject::Rect(child);

        let in_order = resolve_hierarchy(&[parent.clone(), child.clone()]);
        let reversed = resolve_hierarchy(&[child, parent]);
        assert_eq!(effective(&in_order, "r"), effective(&reversed, "r"));
        assert!((effective(&reversed, "r").y - 70.0).abs() < 1e-9);
    }

    #[test]
    fn scalar_state_composes_by_its_own_rule() {
        let mut parent = GroupObject {
            base: base("g"),
            child_ids: vec!["r".into()],
        };
        parent.base.opacity = 0.5;
        parent.base.locked = true;
        parent.base.z_depth = 10.0;
        parent.base.scale_x = 3.0;
        let mut child = RectObject {
            base: base("r"),
            radius: 0.0,
        };
        child.base.opacity = 0.4;
        child.base.z_depth = 5.0;
        child.base.scale_x = 2.0;

        let objects = vec![SceneObject::Group(parent.clone()), SceneObject::Rect(child)];
        let resolution = resolve_hierarchy(&objects);
        let resolved = effective(&resolution, "r");
        assert!((resolved.opacity - 0.2).abs() < 1e-12, "opacity multiplies");
        assert_eq!(resolved.z_depth, 15.0, "z-depth adds");
        assert_eq!(resolved.scale_x, 6.0, "scale multiplies");
        assert!(resolved.locked, "lock ORs");
        assert!(resolved.visible);

        // An invisible parent hides its children, whatever they claim.
        let mut hidden = parent;
        hidden.base.visible = false;
        let objects = vec![SceneObject::Group(hidden), rect("r")];
        assert!(!effective(&resolve_hierarchy(&objects), "r").visible);
    }

    #[test]
    fn only_meshes_inherit_x_and_y_rotation() {
        let mut parent = GroupObject {
            base: base("g"),
            child_ids: vec!["m".into(), "r".into()],
        };
        parent.base.rotation_x = 30.0;
        parent.base.rotation_y = 10.0;
        let mut mesh_base = base("m");
        mesh_base.rotation_x = 5.0;
        let mut rect_base = base("r");
        rect_base.rotation_x = 5.0;

        let objects = vec![
            SceneObject::Group(parent),
            SceneObject::Mesh(MeshObject {
                base: mesh_base,
                mesh_kind: MeshPrimitiveKind::Cube,
                depth: 1.0,
                slab: None,
                model_asset_id: None,
                material_elements: None,
                anchor_3d: None,
                clip_name: None,
                clip_index: None,
                time_scale: None,
                frame_offset: None,
                animation_loop: false,
            }),
            SceneObject::Rect(RectObject {
                base: rect_base,
                radius: 0.0,
            }),
        ];
        let resolution = resolve_hierarchy(&objects);
        assert_eq!(effective(&resolution, "m").rotation_x, 35.0);
        assert_eq!(effective(&resolution, "m").rotation_y, 10.0);
        // A 2D object keeps the tilt it was authored with and does not pick
        // up its parent's.
        assert_eq!(effective(&resolution, "r").rotation_x, 5.0);
        assert_eq!(effective(&resolution, "r").rotation_y, 0.0);
    }

    #[test]
    fn containers_are_reported_but_never_renderable() {
        let objects = vec![group("g", &["r"]), rect("r")];
        let resolution = resolve_hierarchy(&objects);
        // Source order, both present: the editor needs a group's effective
        // placement even though nothing draws it.
        assert_eq!(resolution.effective.len(), 2);
        assert_eq!(resolution.effective[0].id, "g");
        assert!(resolution.effective[0].is_container);
        assert_eq!(
            resolution
                .renderable()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            ["r"]
        );
        assert_eq!(
            resolution
                .containers()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            ["g"]
        );
        assert_eq!(
            resolution.children_by_parent,
            vec![HierarchyChildren {
                parent_id: "g".into(),
                child_ids: vec!["r".into()],
            }]
        );
    }

    #[test]
    fn every_refused_edge_is_named_and_the_scene_still_resolves() {
        // Missing, self-referential, twice-claimed and cyclic edges are each
        // reported by name and dropped. None of them is fatal: a scene being
        // repaired in the editor still resolves completely.
        let objects = vec![
            group("a", &["ghost", "a", "r", "b"]),
            group("b", &["r", "a"]),
            rect("r"),
        ];
        let resolution = resolve_hierarchy(&objects);
        let codes: Vec<HierarchyDiagnosticCode> =
            resolution.diagnostics.iter().map(|d| d.code).collect();
        assert_eq!(
            codes,
            vec![
                HierarchyDiagnosticCode::MissingChild,
                HierarchyDiagnosticCode::SelfReference,
                HierarchyDiagnosticCode::MultipleParents,
                HierarchyDiagnosticCode::Cycle,
            ]
        );
        assert_eq!(resolution.diagnostics[0].child_id, "ghost");
        assert_eq!(
            resolution.diagnostics[2].existing_parent_id.as_deref(),
            Some("a"),
            "the first parent keeps the child and the later one is named"
        );
        assert_eq!(resolution.effective.len(), 3);
        assert_eq!(resolution.parent_of("r"), Some("a"));
        assert_eq!(resolution.parent_of("b"), Some("a"));

        // The resolution is a contract type: the editor shows these rather
        // than reimplementing the resolver (invariant 22).
        let wire = serde_json::to_value(&resolution).unwrap();
        assert_eq!(wire["diagnostics"][0]["code"], "missing-child");
        assert_eq!(wire["diagnostics"][2]["existingParentId"], "a");
        assert_eq!(wire["effective"][0]["isContainer"], true);
        assert_eq!(wire["childrenByParent"][0]["childIds"][0], "r");
        let back: HierarchyResolution = serde_json::from_value(wire).unwrap();
        assert_eq!(back, resolution);
    }

    #[test]
    fn a_duplicate_id_is_owned_by_the_first_object() {
        // Duplicate ids are a preflight error, but resolution still has to be
        // deterministic while the editor repairs the scene: the first object
        // owns the id, and the second claims and inherits nothing.
        let mut first = RectObject {
            base: ObjectBase::new("dup", "first"),
            radius: 0.0,
        };
        first.base.x = 1.0;
        let mut second = RectObject {
            base: ObjectBase::new("dup", "second"),
            radius: 0.0,
        };
        second.base.x = 900.0;

        let objects = vec![
            group("g", &["dup"]),
            SceneObject::Rect(first),
            SceneObject::Rect(second),
        ];
        let resolution = resolve_hierarchy(&objects);
        assert_eq!(resolution.effective.len(), 3);
        assert!(resolution.effective[1..].iter().all(|o| o.x == 1.0));
        assert_eq!(resolution.diagnostics.len(), 0);
    }
}

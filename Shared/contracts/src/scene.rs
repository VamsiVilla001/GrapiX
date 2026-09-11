//! The scene document (build plan 1.1) and the asset library addressing it
//! embeds (1.7).
//!
//! Scope, decided with the user 2026-09-11: a **lean core** rather than the
//! full 1.x object union. The document shell is complete; the object union
//! carries the five kinds the design system and lower-thirds actually use
//! (text, rect, ellipse, image, group), and is an enum so adding a kind is an
//! additive, reviewed change — not an open struct anyone can extend silently.
//! Meshes, lights and cameras belong to 1.2's catalogue step.
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

/// Transform and visibility state every object carries. 2D affine plus the
/// scalar fields the hierarchy resolver composes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectBase {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub visible: bool,
    /// 0–1.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Translation in scene coordinates.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "default_scale")]
    pub scale_x: f64,
    #[serde(default = "default_scale")]
    pub scale_y: f64,
    /// Rotation in degrees.
    #[serde(default)]
    pub rotation: f64,
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

/// A text object. The font is referenced by id into the scene's font list —
/// never by a system family name (ADR-0002 A.4's one rule).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub text: String,
    /// References `FontDefinition::font_id` in the scene's `fonts`.
    pub font_id: String,
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
}

/// A solid or stroked rectangle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RectObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill: Option<String>,
}

/// An ellipse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EllipseObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    pub radius_x: f64,
    pub radius_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill: Option<String>,
}

/// An image. The asset is referenced by id into the scene's asset library —
/// the stable address, so a replace-in-place keeps this binding (1.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImageObject {
    #[serde(flatten)]
    pub base: ObjectBase,
    /// References `AssetLibraryItem::asset_id` in the scene's `assets`.
    pub asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
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

/// The authorable object kinds. A tagged enum, not an open struct: the set of
/// kinds a scene may contain is a reviewed contract, and the renderer refuses
/// a kind it does not know by name rather than ignoring it (invariant 18).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SceneObject {
    Text(TextObject),
    Rect(RectObject),
    Ellipse(EllipseObject),
    Image(ImageObject),
    Group(GroupObject),
}

impl SceneObject {
    pub fn base(&self) -> &ObjectBase {
        match self {
            SceneObject::Text(o) => &o.base,
            SceneObject::Rect(o) => &o.base,
            SceneObject::Ellipse(o) => &o.base,
            SceneObject::Image(o) => &o.base,
            SceneObject::Group(o) => &o.base,
        }
    }
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
    pub fn replace_asset_bytes(&mut self, asset_id: &str, new_hash: ContentHash, new_size: Option<u64>) -> bool {
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

    fn base(id: &str) -> ObjectBase {
        ObjectBase {
            id: id.into(),
            name: id.into(),
            visible: true,
            opacity: 1.0,
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
        }
    }

    fn sample_scene() -> SceneDocument {
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
            timeline: SceneTimeline { duration_frames: 250 },
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
                    base: base("bg"),
                    width: 1920.0,
                    height: 200.0,
                    fill: Some("#102030".into()),
                }),
                SceneObject::Text(TextObject {
                    base: base("title"),
                    text: "Hello".into(),
                    font_id: "font_inter".into(),
                    size: 72.0,
                    color: Some("#ffffff".into()),
                }),
                SceneObject::Image(ImageObject {
                    base: base("logo"),
                    asset_id: "asset_logo".into(),
                    width: Some(120.0),
                    height: Some(120.0),
                }),
            ],
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
}

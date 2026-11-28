//! The one editor command type and atomic scene-edit application (11.36).
//!
//! Every authoring mutation is an [`EditorCommand`] value (invariant 60).
//! Scene content changes travel as [`SceneEdit`]s inside
//! [`EditorCommand::EditScene`]; no surface accepts a bare `SceneEdit`, so a
//! nested transaction is unrepresentable rather than refused at runtime.
//!
//! The executor that owns sessions, history and the project store lives in
//! `gx-editor`. This module holds what every surface shares: the wire types,
//! the pure [`apply_edits`] dispatch, the strict reader and the witnesses.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use ts_rs::TS;

use crate::animation::{self, AutoKey, KeyRef, SceneKeyframe};
use crate::authoring::{self, ObjectDeletion, ObjectDuplication};
use crate::bindings::{self, BindingIssue};
use crate::color::ColorValue;
use crate::control::{self, ControlField, TakePage};
use crate::design_system::{self, DesignSystem, DesignSystemCommit, MotionPreset};
use crate::effect::EffectInstance;
use crate::font::FontDefinition;
use crate::import::ImportReport;
use crate::material::BlendMode;
use crate::object_edit::{self, ObjectField};
use crate::phases::{self, TimelinePhase};
use crate::render_edit::{self, PaintSlot};
use crate::scene::{
    AssetLibraryItem, BezierPath, DataContext, FillRule, Mask, SceneDocument, StrokeStyle,
    TrackMatte, Vec2,
};
use crate::text_style::{self, TextStyle};
use crate::{asset_edit, font_edit, material_edit, ContentHash, RationalRate, Refusal, Revision};

/// Declares one wire enum together with its named payload structs.
///
/// Each variant is a newtype over a payload of the same name, so every command
/// has its own TS type, MCP input name and per-command JSON schema. The name
/// tables and the schema walk are generated from the same list as the enum,
/// so a variant cannot exist without them.
///
/// Payload bodies pass through as raw tokens, not `ty`/`meta` fragments: a
/// fragment reaches the derives as an opaque group, and ts-rs then cannot see
/// that an `Option` field is an `Option` for `#[ts(optional)]`.
macro_rules! commands {
    (
        $(#[$($enum_attr:tt)*])*
        $enum:ident, $tag:literal {
            $(
                $(#[$($payload_attr:tt)*])*
                $variant:ident = $wire:literal { $($fields:tt)* }
            ),* $(,)?
        }
    ) => {
        $(
            $(#[$($payload_attr)*])*
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
            #[serde(rename_all = "camelCase")]
            pub struct $variant { $($fields)* }

            impl From<$variant> for $enum {
                fn from(payload: $variant) -> Self {
                    Self::$variant(payload)
                }
            }
        )*

        $(#[$($enum_attr)*])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
        #[serde(tag = $tag, rename_all = "camelCase")]
        pub enum $enum {
            $( $variant($variant), )*
        }

        impl $enum {
            /// The wire tags, in declaration order.
            pub const NAMES: &'static [&'static str] = &[$($wire),*];
            /// The payload type names, in declaration order.
            pub const PAYLOAD_NAMES: &'static [&'static str] = &[$(stringify!($variant)),*];

            /// This value's wire tag.
            pub const fn name(&self) -> &'static str {
                match self {
                    $( Self::$variant(_) => $wire, )*
                }
            }

            /// Call `f(payload_name, wire_tag, schema)` once per payload, in
            /// declaration order, with each payload's own draft 2020-12 root
            /// schema. The schema lacks the tag property; codegen injects it.
            pub fn for_each_payload_schema(
                mut f: impl FnMut(&'static str, &'static str, schemars::Schema),
            ) {
                $( f(stringify!($variant), $wire, schemars::schema_for!($variant)); )*
            }
        }
    };
}

/// Identity of one open editor session. A `u32`, so TS receives `number`
/// rather than `bigint` (memory rule 22). Keys are monotonic from 1.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
pub struct SessionKey(pub u32);

/// Where a session's document is stored in the project store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneOrigin {
    pub project: String,
    pub scene_id: String,
}

/// The document an edit batch applies to: an open session, or a scene in the
/// project store (read, edited and written back in one command).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(
    tag = "target",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SceneTarget {
    Session { session: SessionKey },
    Stored { project: String, scene_id: String },
}

/// Where `OpenScene` takes its document from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SceneSource {
    /// A fresh document built in Rust by `scene::new_scene`.
    New { id: String, name: String },
    /// A scene file on disk.
    File { path: String },
    /// A stored project scene; an already-open origin is reused.
    Project { project: String, scene_id: String },
    /// An SVG document imported through the 7.2 pipeline. The text travels
    /// whole so the hash in the report is the hash of what was supplied; the
    /// session opens unbound, with the report as an `Imported` effect.
    ImportSvg {
        id: String,
        source_name: String,
        svg: String,
    },
}

/// Where `SaveScene` writes a session's document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(tag = "to", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveTarget {
    /// Update the stored scene the session is bound to; it must exist.
    Origin,
    /// Create the scene in a project; it must not exist. Binds the session.
    Project { project: String },
    /// Write a scene file.
    File { path: String },
    /// Save the session as the next numbered version of itself (11.30), and continue in it.
    ///
    /// A scene stored in a project is written, with its unsaved edits, as a new stored scene under
    /// the next free id (`strap` gives `strap_v002`, `strap_v003` gives `strap_v004`, and a number
    /// already taken is passed over) with the name numbered the same way. The version it came from
    /// is not written to: it stays exactly as it was last saved. The session then belongs to the
    /// new scene and starts a fresh history, because the scene it edits has a new identity. A scene
    /// saved to a file is written beside it as the next numbered file (`strap.json` gives
    /// `strap_v002.json`), and the session continues in that file with its history. A scene that has
    /// never been saved has no version to number from and refuses `sessionUnbound`. A failed write
    /// changes nothing.
    NextVersion,
}

/// Which preset phase `ApplyPreset` instantiates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PresetPhase {
    In,
    Out,
}

/// Which history stack `HistoryEmpty` found empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HistoryDirection {
    Undo,
    Redo,
}

/// The Editor module a gesture came from (11.37). Undo scoped to a module
/// reverses only batches tagged with it; an untagged batch belongs to
/// `Scene`. The surface that issues a gesture names its own module, because
/// guessing it from edit kinds would misfile a gesture that touches several.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum EditorModule {
    Scene,
    Viewport,
    ObjectManager,
    Inspector,
    Timeline,
    Animation,
    Materials,
    Fonts,
    TextStyles,
    Assets,
    TakePage,
    Bindings,
    ControlContract,
}

commands! {
    /// The one editor command type. Every authoring mutation, from every
    /// surface (Tauri, MCP), is a value of this type.
    EditorCommand, "command" {
        /// Open a document in a new session.
        OpenScene = "openScene" { pub source: SceneSource },
        /// Close a session; a dirty session refuses unless `force`.
        CloseScene = "closeScene" { pub session: SessionKey, pub force: bool },
        /// Apply an ordered, atomic edit batch to one document. One batch is
        /// one undo entry, tagged with the module that issued it.
        ///
        /// Against a stored scene the batch is a compare-and-swap (8.12):
        /// `if_revision` is the revision the caller read, the write lands only
        /// if that is still the stored scene's revision, and the outcome
        /// carries the new one. The MCP surface requires it for a stored
        /// target; a session target has no stored revision and must not name
        /// one.
        EditScene = "editScene" {
            pub target: SceneTarget,
            pub edits: Vec<SceneEdit>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub module: Option<EditorModule>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub if_revision: Option<Revision>,
        },
        /// Reverse the latest applied batch, or the latest one `module` issued.
        Undo = "undo" {
            pub session: SessionKey,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub module: Option<EditorModule>,
        },
        /// Reapply the latest undone batch, or the latest one `module` issued.
        Redo = "redo" {
            pub session: SessionKey,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub module: Option<EditorModule>,
        },
        /// Persist a session's document.
        SaveScene = "saveScene" { pub session: SessionKey, pub to: SaveTarget },
        /// Create an empty project in the store.
        CreateProject = "createProject" { pub project: String },
        /// Create an empty stored scene.
        CreateScene = "createScene" { pub project: String, pub scene_id: String, pub name: String },
        /// Copy a stored scene under a new id and name.
        DuplicateScene = "duplicateScene" {
            pub project: String,
            pub source_scene_id: String,
            pub scene_id: String,
            pub name: String,
        },
        /// Delete a stored scene. With `if_revision` the scene is deleted only
        /// if it is still the revision the caller read (8.12); the MCP surface
        /// requires it, so an agent never deletes work it has not seen.
        DeleteScene = "deleteScene" {
            pub project: String,
            pub scene_id: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub if_revision: Option<Revision>,
        },
        /// Store an operator take page.
        SaveTakePage = "saveTakePage" { pub project: String, pub page: TakePage },
        /// Confirm a design-system draft as the project's next version.
        ConfirmDesignSystem = "confirmDesignSystem" { pub project: String, pub commit: DesignSystemCommit },
        /// Save the selected keys of one object as one phase of a motion
        /// preset in the project's library (11.15). The document is read, never
        /// written: saving a preset is not a scene edit and is not undoable.
        SaveMotionPreset = "saveMotionPreset" {
            pub project: String,
            pub target: SceneTarget,
            pub object_id: String,
            pub preset_id: String,
            pub phase: PresetPhase,
            pub keys: Vec<KeyRef>,
        },
        /// Import an SVG into a new stored scene through the four-tier
        /// pipeline (7.2). The source is adopted into the project by content
        /// hash; the report is an `Imported` effect. Refuses an existing id.
        ImportScene = "importScene" {
            pub project: String,
            pub scene_id: String,
            /// The scene's display name; the source file's stem when absent.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub name: Option<String>,
            /// The source's own file name, kept in the report and the asset.
            pub source_name: String,
            pub svg: String,
        },
        /// Ingest one Figma frame into a new stored scene (18.2, 18.3). The user's own agent
        /// reads the frame through Figma's MCP and passes the text of `get_metadata` as
        /// `metadata`; GrapiX holds no Figma token and makes no network call. The frame becomes
        /// the canvas (its width and height), its nodes become objects at their Figma positions,
        /// and the report names everything `get_metadata` does not carry (fills, text content,
        /// fonts, radii, clipping). The metadata text is retained in the project by content
        /// hash. Refuses an existing id; one frame per call.
        ImportFigma = "importFigma" {
            pub project: String,
            pub scene_id: String,
            /// The scene's display name; the Figma frame's name when absent.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub name: Option<String>,
            /// What to call the retained source, for example the frame's name.
            pub source_name: String,
            /// The full-fidelity route: the frame as the agent read it through Figma's MCP
            /// (fills, strokes, radii, text, fonts, blend modes), in the typed shape of
            /// [`FigmaNode`]. Exactly one of `frame` and `metadata` is given.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub frame: Option<Box<crate::figma_frame::FigmaNode>>,
            /// The folder under `Images` the frame's pictures are filed in; the root frame's
            /// name when absent. A picture fill's `image` is looked up there as `<image>.png`,
            /// then `<image>.webp`.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub image_folder: Option<String>,
            /// The structure-only route: the reply of Figma's `get_metadata` for the frame,
            /// as received. Positions and nesting only, with no paint and no text.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub metadata: Option<String>,
        },
        /// File one file into a project (11.43), from a file on this machine: a picture
        /// (png, webp, jpg, jpeg, svg) into `Assets/Images`, a video (mp4, mov, avi, webm) into
        /// `Assets/Videos`, audio (wav, mp3) into `Assets/Audio`, a 3D model (gltf, glb, obj, fbx,
        /// stl, ply, dae, usd, usdz) into `Assets/Models`, or a font (otf, ttf, woff, woff2)
        /// into `Fonts`. The bytes decide which, not the name. The same bytes filed again are a
        /// no-op, and different bytes under an existing name refuse. The outcome's imported
        /// effect names the filed path and its content hash.
        ImportAsset = "importAsset" {
            pub project: String,
            /// One folder name under the class folder (a Figma frame's name, say); empty for
            /// the class folder itself.
            #[serde(default)]
            pub folder: String,
            /// An absolute path to the file on this machine.
            pub from: String,
            /// The file name to file it under; the source file's name when absent.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub name: Option<String>,
            /// What the file came from (a Figma node, a URL), kept in its record.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub source: Option<String>,
        },
        /// Take a session to the state just after one step of its change history (11.82),
        /// or to before every listed step when `step` is left out. It is what the right
        /// number of undos or redos gives, done in one replay: every step up to and
        /// including the named one is applied (one a module-scoped undo had skipped too),
        /// and every later step is undone and can be redone in its order. The jump is not
        /// itself a step, and going to where the session already is changes nothing. A
        /// replay that refuses changes nothing (`historyConflict`); a step the history no
        /// longer lists refuses `historyStepUnknown`.
        GoToHistoryStep = "goToHistoryStep" {
            pub session: SessionKey,
            /// The step's `id` from [`HistoryView`]; left out for the scene as opened.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub step: Option<u32>,
        },
    }
}

commands! {
    /// One change to one scene document. Only carried inside
    /// `EditorCommand::EditScene` and only applied through [`apply_edits`].
    SceneEdit, "edit" {
        CreateObject = "createObject" { pub kind: String, pub name: String },
        DeleteObject = "deleteObject" { pub object_id: String },
        DuplicateObject = "duplicateObject" { pub object_id: String },
        RenameObject = "renameObject" { pub object_id: String, pub name: String },
        /// One inspector field over every listed object.
        SetObjectField = "setObjectField" { pub object_ids: Vec<String>, pub field: ObjectField },
        SetObjectVisible = "setObjectVisible" { pub object_id: String, pub visible: bool },
        SetObjectLocked = "setObjectLocked" { pub object_id: String, pub locked: bool },
        /// A property value edit; with `autoKey` it also upserts a key at `frame`.
        EditProperty = "editProperty" {
            pub object_id: String,
            pub property: String,
            pub value: f64,
            pub frame: u64,
            pub auto_key: bool,
        },
        CreateKeyframe = "createKeyframe" { pub object_id: String, pub property: String, pub keyframe: SceneKeyframe },
        /// Replace a key that already exists at `keyframe.frame`.
        UpdateKeyframe = "updateKeyframe" { pub object_id: String, pub property: String, pub keyframe: SceneKeyframe },
        MoveKeyframe = "moveKeyframe" {
            pub object_id: String,
            pub property: String,
            pub from_frame: u64,
            pub to_frame: u64,
        },
        RemoveKeyframe = "removeKeyframe" { pub object_id: String, pub property: String, pub frame: u64 },
        /// Instantiate one phase of a starter motion preset at `atFrame`.
        ApplyPreset = "applyPreset" {
            pub object_id: String,
            pub preset_id: String,
            pub phase: PresetPhase,
            pub at_frame: u64,
            /// The preset's declared `duration` parameter, in milliseconds.
            /// Absent applies the phase at its own length.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub duration_ms: Option<f64>,
        },
        SetPhase = "setPhase" { pub phase: TimelinePhase },
        RemovePhase = "removePhase" { pub address: String },
        DeclareControl = "declareControl" { pub field: ControlField },
        RemoveControl = "removeControl" { pub field_id: String },
        /// Replace the declared control with the same `fieldId`.
        ReplaceControl = "replaceControl" { pub field: ControlField },
        SaveTextStyle = "saveTextStyle" { pub style: TextStyle },
        ApplyTextStyle = "applyTextStyle" { pub object_id: String, pub style_id: String },
        /// Bind `property` to a data path, or unbind it when `path` is absent.
        SetBinding = "setBinding" {
            pub object_id: String,
            pub property: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub path: Option<String>,
        },
        ReplaceDataContext = "replaceDataContext" { pub data_context: DataContext },
        /// Repoint every use of one material to another.
        RelinkMaterial = "relinkMaterial" { pub from_material_id: String, pub to_material_id: String },
        DeleteMaterial = "deleteMaterial" { pub material_id: String },
        /// Point a library asset at new bytes, keeping its id and bindings.
        RelinkAsset = "relinkAsset" {
            pub asset_id: String,
            pub new_hash: ContentHash,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub new_size: Option<u64>,
        },
        /// Tag the colour space an image asset's pixel values are in (3.17):
        /// what an untagged image needs before it can be drawn.
        SetAssetColorSpace = "setAssetColorSpace" {
            pub asset_id: String,
            pub color_space: crate::color::SourceColorSpace,
        },
        SetSceneName = "setSceneName" { pub name: String },
        /// Change the Scene ID, the label a person edits (1.13). Nothing that points at the scene changes. An empty label takes it away.
        SetSceneLabel = "setSceneLabel" { pub label: String },
        /// Change the id of a scene that is not bound to a stored origin.
        SetSceneId = "setSceneId" { pub id: String },
        /// Add prepared fonts and the font assets their faces need (11.13).
        /// The only way a font enters a scene.
        AddFonts = "addFonts" {
            pub fonts: Vec<FontDefinition>,
            pub assets: Vec<AssetLibraryItem>,
        },
        /// Remove one font nothing names, with the font assets no other font
        /// uses. The only way a font leaves a scene.
        RemoveFont = "removeFont" { pub font_id: String },
        /// Change a font's display name, fallbacks or enabled state (11.13).
        /// Switching off a font something names is refused, as removing it is.
        UpdateFont = "updateFont" {
            pub font_id: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub display_name: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub fallback_families: Option<Vec<String>>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub enabled: Option<bool>,
        },
        /// Replace a font's faces and files under the same id (11.13): what
        /// names the font keeps naming it, and its display name, fallbacks
        /// and enabled state are kept.
        ReplaceFont = "replaceFont" {
            pub font_id: String,
            pub font: FontDefinition,
            pub assets: Vec<AssetLibraryItem>,
        },
        /// Add imported assets with the provenance their import filled in
        /// (11.39). The only way a non-font asset enters a scene.
        AddAssets = "addAssets" { pub assets: Vec<AssetLibraryItem> },
        /// Change the canvas: its rational frame rate and/or its size (11.43).
        /// Frames are canonical (invariant 12): a rate change keeps every key
        /// frame number and the duration in frames, so the graphic plays the
        /// same frames at the new rate; only its wall-clock length changes.
        SetCanvas = "setCanvas" {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub frame_rate: Option<RationalRate>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub width: Option<u32>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub height: Option<u32>,
        },
        /// Create a shape from a bezier path (3.13). The path's own coordinates
        /// place it; its fill is grey and its stroke off until `setPaint` and
        /// `setStroke` say otherwise.
        CreateShape = "createShape" {
            pub name: String,
            pub path: BezierPath,
            /// Additional subpaths, drawn with the primary path as one
            /// compound shape under its fill rule; absent or empty is one path.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub compound_paths: Option<Vec<BezierPath>>,
        },
        /// Replace a group's ordered children (3.19). A child another group
        /// already claims, a missing child and a cycle refuse
        /// `sceneHierarchyInvalid`; a group is the only kind with children here.
        SetGroupChildren = "setGroupChildren" { pub group_id: String, pub child_ids: Vec<String> },
        /// Replace one object's mask list; an empty list clears it (3.19).
        /// Each mask refuses by name (`maskInvalid`, with its index) when the
        /// engine cannot draw it as authored.
        SetObjectMasks = "setObjectMasks" { pub object_id: String, pub masks: Vec<Mask> },
        /// Name a group's clip child, or clear it by leaving `clipChildId` out
        /// (3.19). The clip child must be one of the group's own children and
        /// draw pixels (`clipGroupInvalid`).
        SetClipChild = "setClipChild" {
            pub group_id: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub clip_child_id: Option<String>,
        },
        /// Set one object's track matte by its source's id, or clear it by
        /// leaving `trackMatte` out (3.19). Refuses by name
        /// (`trackMatteInvalid`) what cannot be drawn as authored.
        SetTrackMatte = "setTrackMatte" {
            pub object_id: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub track_matte: Option<TrackMatte>,
        },
        /// Turn Preserve Underlying Transparency on or off for one layer (3.28).
        SetPreserveTransparency = "setPreserveTransparency" {
            pub object_id: String,
            pub preserve: bool,
        },
        /// Set one shape's trim window (3.13): start and end in percent of the
        /// path, offset in percent of a turn. A value left out is its default
        /// (0, 100, 0); all three replace what the shape had.
        SetTrim = "setTrim" {
            pub object_id: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub start: Option<f64>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub end: Option<f64>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub offset: Option<f64>,
        },
        /// Set one paint of every listed object to a colour or gradient, or
        /// clear it by leaving `paint` out (3.17). A shape's fill or stroke
        /// switch follows the paint.
        SetPaint = "setPaint" {
            pub object_ids: Vec<String>,
            pub slot: PaintSlot,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub paint: Option<ColorValue>,
        },
        /// Set the stroke width and style of every listed object (3.17). A
        /// style left out is the default: miter joins, butt caps, solid.
        SetStroke = "setStroke" {
            pub object_ids: Vec<String>,
            pub width: f64,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub style: Option<StrokeStyle>,
        },
        /// Set the layer blend mode of every listed object (3.20); left out
        /// is `normal`. A kind that draws nothing itself (a group, a layer, a
        /// marker, a camera, a light) refuses `objectFieldNotApplicable`.
        SetBlendMode = "setBlendMode" {
            pub object_ids: Vec<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub blend_mode: Option<BlendMode>,
        },
        /// Set the pivot every listed object rotates and scales about; left
        /// out is the object's origin. Refuses a non-finite point by name.
        SetAnchor = "setAnchor" {
            pub object_ids: Vec<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub anchor: Option<Vec2>,
        },
        /// Replace one object's ordered effect stack (3.22); empty clears it.
        /// Each effect is checked as the validator checks it (`effectInvalid`).
        SetEffects = "setEffects" { pub object_id: String, pub effects: Vec<EffectInstance> },
        /// Replace a shape's geometry: its path and every additional subpath
        /// (a compound path); an empty list leaves one path. `fill_rule`, when
        /// given, decides where overlapping subpaths fill (even-odd cuts a
        /// hole); left out keeps the shape's rule.
        SetShapePath = "setShapePath" {
            pub shape_id: String,
            pub path: BezierPath,
            #[serde(default)]
            pub compound_paths: Vec<BezierPath>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub fill_rule: Option<FillRule>,
        },
        /// One semantic operation on one path (11.107, the Pen spec's path
        /// commands): insert, delete or convert vertices, set a handle, move
        /// vertices, reshape a segment, reverse, restart or close. `target`
        /// names a shape's subpath or a mask; the result is checked as
        /// `setShapePath` or `setObjectMasks` checks it.
        EditPath = "editPath" {
            pub object_id: String,
            pub target: crate::path_geometry::PathTarget,
            pub op: crate::path_geometry::PathOp,
            /// The frame an edit of an animated path is made at (11.112): a
            /// move, handle or kind edit sets the key there; an edit of which
            /// vertices there are (insert, delete, reverse, first vertex,
            /// close) lands in every key at once. Left out, the path is static.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub frame: Option<u64>,
            /// For a path that is linked (11.112): the revision the edit was made on. The edit is refused when the
            /// shared path has been edited since.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub base_revision: Option<u64>,
        },
        /// Make `target`'s path the same path as `source`'s (11.112): the numbers of `source` are copied in and the
        /// two are one linked path from then on, an edit of either changing both. A mask is given an id when it has
        /// none. Refused when either path is animated or `target` is linked already.
        LinkPaths = "linkPaths" {
            pub source: crate::path_link::PathAddress,
            pub target: crate::path_link::PathAddress,
        },
        /// Take one path out of its link (11.112): it keeps the path it has, and is independent from then on.
        UnlinkPath = "unlinkPath" {
            pub path: crate::path_link::PathAddress,
        },
        /// Put a guide on the canvas (11.44): a line along `axis` at `position` pixels. The lowest free id is given to it.
        AddGuide = "addGuide" {
            pub axis: crate::scene::GuideAxis,
            pub position: f64,
        },
        /// Move a guide to another position.
        MoveGuide = "moveGuide" {
            pub id: u32,
            pub position: f64,
        },
        /// Take a guide off the canvas.
        RemoveGuide = "removeGuide" {
            pub id: u32,
        },
        /// Take one subpath out of a compound shape (11.112): the others keep their contour ids, and the path channels and links of
        /// the shape follow them to their new places; those of the subpath taken out end with it. A shape keeps at least one path.
        RemoveSubpath = "removeSubpath" {
            pub shape_id: String,
            pub subpath: usize,
        },
        /// Put a whole path key on a path channel (11.112), creating the
        /// channel on its first key. A key at a frame that has one replaces it.
        SetPathKey = "setPathKey" {
            pub object_id: String,
            pub target: crate::path_geometry::PathTarget,
            pub frame: u64,
            pub path: BezierPath,
            #[serde(default)]
            pub easing: crate::animation::SceneEasing,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            #[ts(optional)]
            pub bezier: Option<crate::animation::CubicBezier>,
        },
        /// Take one path key off a path channel (11.112). The last key's
        /// removal ends the channel and leaves the path as that key had it.
        RemovePathKey = "removePathKey" {
            pub object_id: String,
            pub target: crate::path_geometry::PathTarget,
            pub frame: u64,
        },
        /// Move a path key to another frame (11.112); a frame that has a key
        /// already is refused, as `moveKeyframe` refuses it.
        MovePathKey = "movePathKey" {
            pub object_id: String,
            pub target: crate::path_geometry::PathTarget,
            pub from_frame: u64,
            pub to_frame: u64,
        },
        CreateColourKey = "createColourKey" {
            pub object_id: String,
            pub property: crate::animation::colour::ColourProperty,
            pub keyframe: crate::animation::colour::ColourKeyframe,
        },
        UpdateColourKey = "updateColourKey" {
            pub object_id: String,
            pub property: crate::animation::colour::ColourProperty,
            pub keyframe: crate::animation::colour::ColourKeyframe,
        },
        MoveColourKey = "moveColourKey" {
            pub object_id: String,
            pub property: crate::animation::colour::ColourProperty,
            pub from_frame: u64,
            pub to_frame: u64,
        },
        RemoveColourKey = "removeColourKey" {
            pub object_id: String,
            pub property: crate::animation::colour::ColourProperty,
            pub frame: u64,
        },
        /// Set a text animator, or remove it and its keys with null.
        SetTextAnimator = "setTextAnimator" {
            pub object_ids: Vec<String>,
            pub animator: Option<crate::text_animator::TextAnimator>,
        },
        /// Put one of EffectCraft's text-animator presets (listing id
        /// `ec.textanimator.<name>`) on a text: its animator replaces the
        /// text's, and its keys start at `at_frame` (11.61). One undo entry;
        /// a preset the engine cannot draw yet refuses by name.
        ApplyTextAnimatorPreset = "applyTextAnimatorPreset" {
            pub object_id: String,
            pub preset_id: String,
            pub at_frame: u64,
        },
    }
}

/// What a scene edit may read beside the document itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct EditContext<'a> {
    /// The confirmed design system of the document's project, if any.
    pub design_system: Option<&'a DesignSystem>,
    /// The stored scene the document is bound to, if any.
    pub origin: Option<&'a SceneOrigin>,
    /// The project's saved motion presets, when the edits name one (11.15).
    /// Starter presets are always available and are looked up first.
    pub presets: Option<&'a [MotionPreset]>,
}

/// What one applied edit or command changed. An output only: TS type, no
/// schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "effect",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditEffect {
    None,
    ObjectCreated {
        object_id: String,
    },
    ObjectDeleted(ObjectDeletion),
    ObjectDuplicated(ObjectDuplication),
    ObjectsChanged {
        object_ids: Vec<String>,
    },
    PresetApplied {
        duration_frames: u64,
    },
    MotionPresetSaved {
        project: String,
        preset_id: String,
        phase: PresetPhase,
    },
    MaterialsRelinked {
        changed: Vec<String>,
    },
    DataContextReplaced {
        newly_invalid: Vec<BindingIssue>,
    },
    SessionOpened {
        session: SessionKey,
    },
    SessionClosed {
        session: SessionKey,
    },
    Stored {
        origin: SceneOrigin,
        /// The Scene ID allocated by a creation command.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        scene_label: Option<String>,
    },
    ProjectCreated {
        project: String,
    },
    TakePageSaved {
        project: String,
        page_id: String,
    },
    FontRemoved {
        font_id: String,
        asset_ids: Vec<String>,
    },
    /// The font's old files nothing uses any more left with the replace.
    FontReplaced {
        font_id: String,
        asset_ids: Vec<String>,
    },
    /// A session opened from an import (7.2): every substitution, named.
    Imported {
        report: ImportReport,
    },
    DesignSystemConfirmed {
        project: String,
        version: u32,
    },
}

/// A session as the browser sees it. The document flows out only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session: SessionKey,
    pub document: SceneDocument,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<SceneOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    pub undo_depth: u32,
    pub redo_depth: u32,
    pub dirty: bool,
    pub project_dirty: bool,
}

/// One step of a session's change history (11.82): one edit batch, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStep {
    /// What `GoToHistoryStep` names. It stays the step's own for as long as the step is
    /// listed, so a list read a moment ago still points at the right step.
    pub id: u32,
    /// The part of the app that made the change (11.37).
    pub module: EditorModule,
    /// The wire tag of every edit in the batch, in order ([`SceneEdit::NAMES`]).
    pub edits: Vec<String>,
    /// What the first edit was about, when it names something a reader recognises: the
    /// name given to a new or renamed object, a property, a preset or a style id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub about: Option<String>,
    /// False for a step that is undone and can be redone.
    pub applied: bool,
}

/// A session's change history, oldest step first (11.82). The scene is the document as
/// opened with every applied step replayed in this order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    pub session: SessionKey,
    pub steps: Vec<HistoryStep>,
    /// Older steps that are no longer listed: past the history limit they are part of the
    /// scene as opened, and cannot be undone.
    pub folded: u32,
    /// The most steps one scene keeps.
    pub limit: u32,
}

/// The result of one executed command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<SessionView>,
    pub effects: Vec<EditEffect>,
    /// The stored scene's revision after this command (8.12), for a command
    /// that addressed a stored scene. A batch that changed nothing answers the
    /// revision it found, unchanged. Absent for a command that stored nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub revision: Option<Revision>,
}

/// Apply an ordered edit batch atomically.
///
/// Every edit runs against one candidate copy, in order, so a later edit sees
/// what an earlier one did. Only if all of them succeed is the candidate
/// swapped in; the first refusal leaves `scene` untouched. On success the
/// before-image is returned for the caller's history, with one effect per
/// edit. An empty batch is refused: it would be a history entry that changes
/// nothing and names nothing.
pub fn apply_edits(
    scene: &mut SceneDocument,
    edits: &[SceneEdit],
    ctx: &EditContext<'_>,
) -> Result<(SceneDocument, Vec<EditEffect>), Refusal> {
    if edits.is_empty() {
        return Err(Refusal::EditBatchEmpty);
    }
    let mut candidate = scene.clone();
    let mut effects = Vec::with_capacity(edits.len());
    for edit in edits {
        effects.push(apply_edit(&mut candidate, edit, ctx)?);
    }
    animation::validate_scene_animation(&candidate)?;
    Ok((std::mem::replace(scene, candidate), effects))
}

fn apply_edit(
    scene: &mut SceneDocument,
    edit: &SceneEdit,
    ctx: &EditContext<'_>,
) -> Result<EditEffect, Refusal> {
    Ok(match edit {
        SceneEdit::CreateObject(p) => EditEffect::ObjectCreated {
            object_id: authoring::create_object(scene, &p.kind, &p.name)?,
        },
        SceneEdit::DeleteObject(p) => {
            EditEffect::ObjectDeleted(authoring::delete_object(scene, &p.object_id)?)
        }
        SceneEdit::DuplicateObject(p) => {
            EditEffect::ObjectDuplicated(authoring::duplicate_object(scene, &p.object_id)?)
        }
        SceneEdit::RenameObject(p) => {
            authoring::rename_object(scene, &p.object_id, &p.name)?;
            EditEffect::None
        }
        SceneEdit::SetObjectField(p) => {
            object_edit::set_object_field(scene, &p.object_ids, &p.field)?
        }
        SceneEdit::SetObjectVisible(p) => {
            object_edit::set_object_visible(scene, &p.object_id, p.visible)?;
            EditEffect::None
        }
        SceneEdit::SetObjectLocked(p) => {
            object_edit::set_object_locked(scene, &p.object_id, p.locked)?;
            EditEffect::None
        }
        SceneEdit::EditProperty(p) => {
            let auto_key = if p.auto_key {
                AutoKey::On
            } else {
                AutoKey::Off
            };
            animation::apply_property_edit(
                scene,
                &p.object_id,
                &p.property,
                p.value,
                p.frame,
                auto_key,
            )?;
            EditEffect::None
        }
        SceneEdit::CreateKeyframe(p) => {
            animation::create_keyframe(scene, &p.object_id, &p.property, p.keyframe.clone())?;
            EditEffect::None
        }
        SceneEdit::UpdateKeyframe(p) => {
            animation::update_keyframe(scene, &p.object_id, &p.property, p.keyframe.clone())?;
            EditEffect::None
        }
        SceneEdit::MoveKeyframe(p) => {
            animation::move_keyframe(scene, &p.object_id, &p.property, p.from_frame, p.to_frame)?;
            EditEffect::None
        }
        SceneEdit::RemoveKeyframe(p) => {
            animation::remove_keyframe_in_batch(scene, &p.object_id, &p.property, p.frame)?;
            EditEffect::None
        }
        SceneEdit::ApplyPreset(p) => {
            let preset = design_system::starter_preset(&p.preset_id)
                .or_else(|| {
                    ctx.presets.and_then(|saved| {
                        saved
                            .iter()
                            .find(|preset| preset.id == p.preset_id)
                            .cloned()
                    })
                })
                .ok_or_else(|| Refusal::MotionPresetUnknown {
                    preset: p.preset_id.clone(),
                })?;
            let phase = match p.phase {
                PresetPhase::In => &preset.phases.r#in,
                PresetPhase::Out => &preset.phases.out,
            };
            let retimed = match p.duration_ms {
                Some(milliseconds) => Some(preset.phase_with_duration(phase, milliseconds)?),
                None => None,
            };
            EditEffect::PresetApplied {
                duration_frames: animation::apply_preset_phase(
                    scene,
                    &p.object_id,
                    retimed.as_ref().unwrap_or(phase),
                    p.at_frame,
                )?,
            }
        }
        SceneEdit::SetPhase(p) => {
            phases::set_phase(&mut scene.timeline, p.phase.clone())?;
            EditEffect::None
        }
        SceneEdit::RemovePhase(p) => {
            phases::remove_phase(&mut scene.timeline, &p.address)?;
            EditEffect::None
        }
        SceneEdit::DeclareControl(p) => {
            control::declare_control_field(scene, p.field.clone())?;
            EditEffect::None
        }
        SceneEdit::RemoveControl(p) => {
            control::remove_control_field(scene, &p.field_id)?;
            EditEffect::None
        }
        SceneEdit::ReplaceControl(p) => {
            control::replace_control_field(scene, p.field.clone())?;
            EditEffect::None
        }
        SceneEdit::SaveTextStyle(p) => {
            text_style::save_text_style(scene, p.style.clone())?;
            EditEffect::None
        }
        SceneEdit::ApplyTextStyle(p) => {
            text_style::apply_text_style(scene, &p.object_id, &p.style_id, ctx.design_system)?;
            EditEffect::None
        }
        SceneEdit::SetBinding(p) => {
            bindings::set_binding(scene, &p.object_id, &p.property, p.path.as_deref())?;
            EditEffect::None
        }
        SceneEdit::ReplaceDataContext(p) => EditEffect::DataContextReplaced {
            newly_invalid: bindings::replace_data_context(scene, p.data_context.clone())?,
        },
        SceneEdit::RelinkMaterial(p) => EditEffect::MaterialsRelinked {
            changed: material_edit::relink_material(scene, &p.from_material_id, &p.to_material_id)?,
        },
        SceneEdit::DeleteMaterial(p) => {
            material_edit::delete_material(scene, &p.material_id)?;
            EditEffect::None
        }
        SceneEdit::RelinkAsset(p) => {
            // A relink that did nothing and said it worked is how an author
            // ends up debugging the wrong file: an unknown id is refused.
            if !scene.replace_asset_bytes(&p.asset_id, p.new_hash.clone(), p.new_size) {
                return Err(Refusal::SceneAssetUnknown {
                    asset_id: p.asset_id.clone(),
                    object: scene.id.clone(),
                });
            }
            EditEffect::None
        }
        SceneEdit::SetAssetColorSpace(p) => {
            match scene.assets.iter_mut().find(|a| a.asset_id == p.asset_id) {
                Some(asset) => asset.color_space = Some(p.color_space),
                None => {
                    return Err(Refusal::SceneAssetUnknown {
                        asset_id: p.asset_id.clone(),
                        object: scene.id.clone(),
                    })
                }
            }
            EditEffect::None
        }
        SceneEdit::SetSceneName(p) => {
            let name = p.name.trim();
            if name.is_empty() {
                return Err(Refusal::SceneNameEmpty);
            }
            scene.name = name.to_owned();
            EditEffect::None
        }
        SceneEdit::SetSceneLabel(p) => {
            if p.label.trim().is_empty() {
                if scene.scene_label.is_none() {
                    return Err(Refusal::ObjectFieldUnchanged { field: "sceneLabel".into() });
                }
                scene.scene_label = None;
            } else {
                let label = crate::ids::parse_scene_label(&p.label)?;
                if scene.scene_label.as_deref() == Some(label.as_str()) {
                    return Err(Refusal::ObjectFieldUnchanged { field: "sceneLabel".into() });
                }
                scene.scene_label = Some(label);
            }
            EditEffect::None
        }
        SceneEdit::SetSceneId(p) => {
            // A stored scene's id is its address; renaming it in place would
            // orphan the stored file. Duplicate is the way to a new id.
            if let Some(origin) = ctx.origin {
                return Err(Refusal::SceneIdBound {
                    project: origin.project.clone(),
                    scene_id: origin.scene_id.clone(),
                });
            }
            if !crate::platform::is_canonical_filename(&p.id) {
                return Err(Refusal::SceneIdInvalid { id: p.id.clone() });
            }
            scene.id = p.id.clone();
            EditEffect::None
        }
        SceneEdit::AddFonts(p) => {
            font_edit::add_fonts(scene, &p.fonts, &p.assets)?;
            EditEffect::None
        }
        SceneEdit::RemoveFont(p) => EditEffect::FontRemoved {
            asset_ids: font_edit::remove_font(scene, &p.font_id)?,
            font_id: p.font_id.clone(),
        },
        SceneEdit::UpdateFont(p) => {
            font_edit::update_font(
                scene,
                &p.font_id,
                p.display_name.as_deref(),
                p.fallback_families.as_deref(),
                p.enabled,
            )?;
            EditEffect::None
        }
        SceneEdit::ReplaceFont(p) => EditEffect::FontReplaced {
            asset_ids: font_edit::replace_font(scene, &p.font_id, &p.font, &p.assets)?,
            font_id: p.font_id.clone(),
        },
        SceneEdit::AddAssets(p) => {
            asset_edit::add_assets(scene, &p.assets)?;
            EditEffect::None
        }
        SceneEdit::SetCanvas(p) => {
            set_canvas(scene, p.frame_rate, p.width, p.height)?;
            EditEffect::None
        }
        SceneEdit::CreateShape(p) => render_edit::create_shape(
            scene,
            &p.name,
            &p.path,
            p.compound_paths.as_deref().unwrap_or_default(),
        )?,
        SceneEdit::SetGroupChildren(p) => {
            render_edit::set_group_children(scene, &p.group_id, &p.child_ids)?
        }
        SceneEdit::SetObjectMasks(p) => {
            render_edit::set_object_masks(scene, &p.object_id, &p.masks)?
        }
        SceneEdit::SetClipChild(p) => {
            render_edit::set_clip_child(scene, &p.group_id, p.clip_child_id.as_deref())?
        }
        SceneEdit::SetTrackMatte(p) => {
            render_edit::set_track_matte(scene, &p.object_id, p.track_matte.as_ref())?
        }
        SceneEdit::SetPreserveTransparency(p) => {
            render_edit::set_preserve_transparency(scene, &p.object_id, p.preserve)?
        }
        SceneEdit::SetTrim(p) => {
            render_edit::set_trim(scene, &p.object_id, p.start, p.end, p.offset)?
        }
        SceneEdit::SetPaint(p) => {
            render_edit::set_paint(scene, &p.object_ids, p.slot, p.paint.as_ref())?
        }
        SceneEdit::SetStroke(p) => {
            render_edit::set_stroke(scene, &p.object_ids, p.width, p.style.as_ref())?
        }
        SceneEdit::SetBlendMode(p) => {
            render_edit::set_blend_mode(scene, &p.object_ids, p.blend_mode)?
        }
        SceneEdit::SetAnchor(p) => render_edit::set_anchor(scene, &p.object_ids, p.anchor)?,
        SceneEdit::SetEffects(p) => render_edit::set_effects(scene, &p.object_id, &p.effects)?,
        SceneEdit::SetShapePath(p) => render_edit::set_shape_path(
            scene,
            &p.shape_id,
            &p.path,
            &p.compound_paths,
            p.fill_rule,
        )?,
        SceneEdit::EditPath(p) => {
            render_edit::edit_path(scene, &p.object_id, p.target, &p.op, p.frame, p.base_revision)?
        }
        SceneEdit::AddGuide(p) => render_edit::add_guide(scene, p.axis, p.position)?,
        SceneEdit::MoveGuide(p) => render_edit::move_guide(scene, p.id, p.position)?,
        SceneEdit::RemoveGuide(p) => render_edit::remove_guide(scene, p.id)?,
        SceneEdit::RemoveSubpath(p) => render_edit::remove_subpath(scene, &p.shape_id, p.subpath)?,
        SceneEdit::LinkPaths(p) => render_edit::link_paths(scene, &p.source, &p.target)?,
        SceneEdit::UnlinkPath(p) => render_edit::unlink_path(scene, &p.path)?,
        SceneEdit::SetPathKey(p) => render_edit::set_path_key(
            scene,
            &p.object_id,
            p.target,
            p.frame,
            &p.path,
            p.easing,
            p.bezier,
        )?,
        SceneEdit::RemovePathKey(p) => {
            render_edit::remove_path_key(scene, &p.object_id, p.target, p.frame)?
        }
        SceneEdit::MovePathKey(p) => {
            render_edit::move_path_key(scene, &p.object_id, p.target, p.from_frame, p.to_frame)?
        }
        SceneEdit::CreateColourKey(p) => {
            animation::colour::create_key(scene, &p.object_id, p.property, p.keyframe.clone())?;
            EditEffect::None
        }
        SceneEdit::UpdateColourKey(p) => {
            animation::colour::update_key(scene, &p.object_id, p.property, p.keyframe.clone())?;
            EditEffect::None
        }
        SceneEdit::MoveColourKey(p) => {
            animation::colour::move_key(scene, &p.object_id, p.property, p.from_frame, p.to_frame)?;
            EditEffect::None
        }
        SceneEdit::RemoveColourKey(p) => {
            animation::colour::remove_key(scene, &p.object_id, p.property, p.frame)?;
            EditEffect::None
        }
        SceneEdit::SetTextAnimator(p) => {
            animation::set_text_animator(scene, &p.object_ids, p.animator.as_ref())?;
            EditEffect::None
        }
        SceneEdit::ApplyTextAnimatorPreset(p) => EditEffect::PresetApplied {
            duration_frames: crate::text_animator_presets::apply(
                scene,
                &p.object_id,
                &p.preset_id,
                p.at_frame,
            )?,
        },
    })
}

/// Apply a canvas change, all or nothing. A rate with a zero term is refused
/// (`InvalidRate`), a zero side is refused by name, and an edit that changes
/// nothing is refused rather than recorded as an empty history entry.
fn set_canvas(
    scene: &mut SceneDocument,
    frame_rate: Option<RationalRate>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), Refusal> {
    let mut canvas = scene.canvas.clone();
    if let Some(rate) = frame_rate {
        canvas.frame_rate = RationalRate::new(rate.num, rate.den)?;
    }
    for (field, value, slot) in [
        ("canvas.width", width, &mut canvas.width),
        ("canvas.height", height, &mut canvas.height),
    ] {
        if let Some(value) = value {
            if value == 0 {
                return Err(Refusal::ObjectFieldValueInvalid {
                    field: field.to_owned(),
                    detail: "must be at least 1 pixel".to_owned(),
                });
            }
            *slot = value;
        }
    }
    if canvas == scene.canvas {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "canvas".to_owned(),
        });
    }
    scene.canvas = canvas;
    Ok(())
}

/// Parse typed JSON, refusing any key the type does not carry.
///
/// Serde drops unknown keys in silence, and `deny_unknown_fields` would guard
/// only the top level of nested contract types. So, as the scene reader does,
/// the input is parsed, re-serialised, and diffed: an input key absent from
/// the round trip is unknown and refuses with its path — unless its value is
/// `null`, which serde treats as absence for an optional field.
pub fn parse_strict<T: DeserializeOwned + Serialize>(
    value: serde_json::Value,
) -> Result<T, Refusal> {
    let parsed: T =
        serde_json::from_value(value.clone()).map_err(|error| Refusal::SceneParseFailed {
            detail: format!("command does not match its schema: {error}"),
        })?;
    let understood = serde_json::to_value(&parsed).map_err(|error| Refusal::SceneParseFailed {
        detail: format!("command does not round-trip: {error}"),
    })?;
    let mut unknown = Vec::new();
    crate::scene::collect_unknown_keys(&value, &understood, String::new(), &mut unknown);
    match unknown.into_iter().next() {
        Some(path) => Err(Refusal::CommandUnknownField { path }),
        None => Ok(parsed),
    }
}

/// The strict reader every command surface calls on untrusted input.
pub fn parse_command(value: serde_json::Value) -> Result<EditorCommand, Refusal> {
    parse_strict(value)
}

#[cfg(any(test, feature = "fixtures"))]
pub mod witness {
    use std::collections::BTreeMap;

    use super::*;
    use crate::color::ColorValue;
    use crate::control::ControlFieldKind;
    use crate::design_system::{
        DesignSystemCommit, DesignSystemDraft, DesignSystemSource, DesignSystemSourceKind,
        DraftVisualTokens, MotionTokens,
    };
    use crate::font::{EmbeddingPolicy, FontDefinition, FontLoadStatus};
    use crate::material::{MaterialBinding, MaterialDefinition};
    use crate::phases::PhaseKind;
    use crate::scene;
    use crate::scene::{
        AssetKind, AssetLibraryItem, ObjectBase, RectObject, SceneObject, TextCase, TextObject,
        Vec2,
    };
    use crate::text_style::StyleNumber;

    pub fn variant_index(c: &EditorCommand) -> usize {
        match c {
            EditorCommand::OpenScene(_) => 0,
            EditorCommand::CloseScene(_) => 1,
            EditorCommand::EditScene(_) => 2,
            EditorCommand::Undo(_) => 3,
            EditorCommand::Redo(_) => 4,
            EditorCommand::SaveScene(_) => 5,
            EditorCommand::CreateProject(_) => 6,
            EditorCommand::CreateScene(_) => 7,
            EditorCommand::DuplicateScene(_) => 8,
            EditorCommand::DeleteScene(_) => 9,
            EditorCommand::SaveTakePage(_) => 10,
            EditorCommand::ConfirmDesignSystem(_) => 11,
            EditorCommand::SaveMotionPreset(_) => 12,
            EditorCommand::ImportScene(_) => 13,
            EditorCommand::ImportFigma(_) => 14,
            EditorCommand::ImportAsset(_) => 15,
            EditorCommand::GoToHistoryStep(_) => 16,
        }
    }

    pub fn edit_index(e: &SceneEdit) -> usize {
        match e {
            SceneEdit::CreateObject(_) => 0,
            SceneEdit::DeleteObject(_) => 1,
            SceneEdit::DuplicateObject(_) => 2,
            SceneEdit::RenameObject(_) => 3,
            SceneEdit::SetObjectField(_) => 4,
            SceneEdit::SetObjectVisible(_) => 5,
            SceneEdit::SetObjectLocked(_) => 6,
            SceneEdit::EditProperty(_) => 7,
            SceneEdit::CreateKeyframe(_) => 8,
            SceneEdit::UpdateKeyframe(_) => 9,
            SceneEdit::MoveKeyframe(_) => 10,
            SceneEdit::RemoveKeyframe(_) => 11,
            SceneEdit::ApplyPreset(_) => 12,
            SceneEdit::SetPhase(_) => 13,
            SceneEdit::RemovePhase(_) => 14,
            SceneEdit::DeclareControl(_) => 15,
            SceneEdit::RemoveControl(_) => 16,
            SceneEdit::ReplaceControl(_) => 17,
            SceneEdit::SaveTextStyle(_) => 18,
            SceneEdit::ApplyTextStyle(_) => 19,
            SceneEdit::SetBinding(_) => 20,
            SceneEdit::ReplaceDataContext(_) => 21,
            SceneEdit::RelinkMaterial(_) => 22,
            SceneEdit::DeleteMaterial(_) => 23,
            SceneEdit::RelinkAsset(_) => 24,
            SceneEdit::SetSceneName(_) => 25,
            SceneEdit::SetSceneId(_) => 26,
            SceneEdit::AddFonts(_) => 27,
            SceneEdit::RemoveFont(_) => 28,
            SceneEdit::AddAssets(_) => 29,
            SceneEdit::UpdateFont(_) => 30,
            SceneEdit::ReplaceFont(_) => 31,
            SceneEdit::SetCanvas(_) => 32,
            SceneEdit::SetAssetColorSpace(_) => 33,
            SceneEdit::SetObjectMasks(_) => 34,
            SceneEdit::SetClipChild(_) => 35,
            SceneEdit::SetTrackMatte(_) => 36,
            SceneEdit::SetTrim(_) => 37,
            SceneEdit::SetPaint(_) => 38,
            SceneEdit::SetStroke(_) => 39,
            SceneEdit::CreateShape(_) => 40,
            SceneEdit::SetGroupChildren(_) => 41,
            SceneEdit::SetBlendMode(_) => 42,
            SceneEdit::SetAnchor(_) => 43,
            SceneEdit::SetEffects(_) => 44,
            SceneEdit::SetShapePath(_) => 45,
            SceneEdit::EditPath(_) => 46,
            SceneEdit::SetPreserveTransparency(_) => 47,
            SceneEdit::SetPathKey(_) => 48,
            SceneEdit::RemovePathKey(_) => 49,
            SceneEdit::MovePathKey(_) => 50,
            SceneEdit::LinkPaths(_) => 51,
            SceneEdit::UnlinkPath(_) => 52,
            SceneEdit::RemoveSubpath(_) => 53,
            SceneEdit::AddGuide(_) => 54,
            SceneEdit::MoveGuide(_) => 55,
            SceneEdit::RemoveGuide(_) => 56,
            SceneEdit::SetSceneLabel(_) => 57,
            SceneEdit::CreateColourKey(_) => 58,
            SceneEdit::UpdateColourKey(_) => 59,
            SceneEdit::MoveColourKey(_) => 60,
            SceneEdit::RemoveColourKey(_) => 61,
            SceneEdit::SetTextAnimator(_) => 62,
            SceneEdit::ApplyTextAnimatorPreset(_) => 63,
        }
    }

    /// The ordered command trace conformance executes on a fresh
    /// `gx_editor::command::Workspace` whose project store is empty: every
    /// command succeeds, and together they cover every `EditorCommand`
    /// variant and every `SceneEdit` variant. Session keys start at 1;
    /// session 1 (opened from the fixture written into `scratch`) is still
    /// open at the end, for the harness's publish-by-target.
    pub fn every_command(scratch: &std::path::Path) -> Vec<EditorCommand> {
        std::fs::create_dir_all(scratch).expect("the witness scratch directory is writable");
        let fixture_path = scratch.join("witness.gpx");
        let saved_path = scratch.join("saved.gpx");
        // A file for `ImportAsset`: a PNG header of 1 by 1, which is all the importer reads.
        let picture_path = scratch.join("witness.png");
        let mut picture = b"\x89PNG\r\n\x1a\n".to_vec();
        picture.extend_from_slice(&13u32.to_be_bytes());
        picture.extend_from_slice(b"IHDR");
        picture.extend_from_slice(&1u32.to_be_bytes());
        picture.extend_from_slice(&1u32.to_be_bytes());
        picture.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(&picture_path, picture).expect("the witness picture writes");
        std::fs::write(
            &fixture_path,
            serde_json::to_vec(&fixture_scene()).expect("the witness fixture serialises"),
        )
        .expect("the witness fixture writes");

        let session = SessionKey(1);
        vec![
            EditorCommand::OpenScene(OpenScene {
                source: SceneSource::File {
                    path: fixture_path.display().to_string(),
                },
            }),
            EditorCommand::EditScene(EditScene {
                target: SceneTarget::Session { session },
                edits: scene_edits(),
                module: Some(EditorModule::Inspector),
                if_revision: None,
            }),
            // One module-scoped undo and one project-level redo, so both
            // scopes run over the wire.
            EditorCommand::Undo(Undo {
                session,
                module: Some(EditorModule::Inspector),
            }),
            EditorCommand::Redo(Redo {
                session,
                module: None,
            }),
            // Back to the scene as opened and forward again to the batch (its id is 1, the
            // first step of the session), so the batch is applied for what follows.
            EditorCommand::GoToHistoryStep(GoToHistoryStep {
                session,
                step: None,
            }),
            EditorCommand::GoToHistoryStep(GoToHistoryStep {
                session,
                step: Some(1),
            }),
            EditorCommand::SaveScene(SaveScene {
                session,
                to: SaveTarget::File {
                    path: saved_path.display().to_string(),
                },
            }),
            EditorCommand::OpenScene(OpenScene {
                source: SceneSource::New {
                    id: "temporary".into(),
                    name: "Temporary".into(),
                },
            }),
            EditorCommand::CloseScene(CloseScene {
                session: SessionKey(2),
                force: false,
            }),
            EditorCommand::CreateProject(CreateProject {
                project: "witness-project".into(),
            }),
            EditorCommand::CreateScene(CreateScene {
                project: "witness-project".into(),
                scene_id: "stored".into(),
                name: "Stored".into(),
            }),
            EditorCommand::DuplicateScene(DuplicateScene {
                project: "witness-project".into(),
                source_scene_id: "stored".into(),
                scene_id: "copy".into(),
                name: "Copy".into(),
            }),
            EditorCommand::DeleteScene(DeleteScene {
                project: "witness-project".into(),
                scene_id: "copy".into(),
                if_revision: Some(Revision(0)),
            }),
            EditorCommand::ImportScene(ImportScene {
                project: "witness-project".into(),
                scene_id: "imported".into(),
                name: None,
                source_name: "witness.svg".into(),
                svg: r#"<svg><rect id="bar" width="10" height="10"/><g id="group"/></svg>"#.into(),
            }),
            EditorCommand::ImportAsset(ImportAsset {
                project: "witness-project".into(),
                folder: "witness".into(),
                from: picture_path.display().to_string(),
                name: None,
                source: None,
            }),
            EditorCommand::ImportFigma(ImportFigma {
                project: "witness-project".into(),
                scene_id: "ingested".into(),
                name: None,
                source_name: "witness.xml".into(),
                frame: None,
                image_folder: None,
                metadata: Some(r#"<frame id="1:1" name="Frame" x="0" y="0" width="1920" height="1080"><rounded-rectangle id="1:2" name="Plate" x="0" y="0" width="100" height="50"/></frame>"#.into()),
            }),
            EditorCommand::SaveTakePage(SaveTakePage {
                project: "witness-project".into(),
                page: TakePage {
                    page_id: "page".into(),
                    name: "Page".into(),
                    scene_id: "stored".into(),
                    values: BTreeMap::new(),
                },
            }),
            EditorCommand::ConfirmDesignSystem(ConfirmDesignSystem {
                project: "witness-project".into(),
                commit: design_system_commit(),
            }),
            // The witness card carries the fade the batch above applied at
            // frame 10, so these two opacity keys exist when this runs.
            EditorCommand::SaveMotionPreset(SaveMotionPreset {
                project: "witness-project".into(),
                target: SceneTarget::Session { session },
                object_id: "card".into(),
                preset_id: "witness-fade".into(),
                phase: PresetPhase::In,
                keys: vec![
                    KeyRef {
                        property: "opacity".into(),
                        frame: 10,
                    },
                    KeyRef {
                        property: "opacity".into(),
                        frame: 25,
                    },
                ],
            }),
        ]
    }

    /// The document session 1 opens: it carries every prerequisite the
    /// [`scene_edits`] batch needs (a rect bound to material `m1`, a text
    /// object, a font, an image asset and numeric data).
    pub fn fixture_scene() -> SceneDocument {
        let mut scene = scene::new_scene(
            "witness",
            "Witness",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        scene.timeline.duration_frames = 100;
        scene
            .data_context
            .insert("headline".into(), serde_json::json!(1.0));
        scene.assets.push(AssetLibraryItem {
            asset_id: "asset1".into(),
            name: "Asset".into(),
            kind: AssetKind::Image,
            path: "asset.png".into(),
            checksum: Some(ContentHash("old".into())),
            mime_type: None,
            size_bytes: Some(1),
            status: None,
            provenance: crate::provenance::AssetProvenance::default(),
            color_space: None,
        });
        scene.materials = vec![material("m1"), material("m2")];
        let mut card = ObjectBase::new("card", "Card");
        card.material_slots = Some(BTreeMap::from([(
            "fill".into(),
            MaterialBinding::new("m1"),
        )]));
        scene.objects.push(SceneObject::Rect(RectObject {
            base: card,
            radius: 0.0,
        }));
        scene.fonts.push(FontDefinition {
            font_id: "font".into(),
            family: "Witness".into(),
            display_name: "Witness".into(),
            faces: Vec::new(),
            fallback_families: Vec::new(),
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        });
        scene.objects.push(SceneObject::Text(TextObject {
            base: ObjectBase::new("text", "Text"),
            text: "Witness".into(),
            font_id: "font".into(),
            size: 24.0,
            layout: Default::default(),
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
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
        }));
        scene
    }

    fn material(id: &str) -> MaterialDefinition {
        MaterialDefinition {
            material_id: id.into(),
            name: id.into(),
            kind: Default::default(),
            color: ColorValue::opaque_white(),
            opacity: 1.0,
            blend_mode: Default::default(),
            alpha_mode: Default::default(),
            cull_mode: Default::default(),
            depth_mode: Default::default(),
            double_sided: false,
            textures: Vec::new(),
            shader_id: None,
        }
    }

    fn design_system_commit() -> DesignSystemCommit {
        DesignSystemCommit {
            draft: DesignSystemDraft {
                name: "Witness".into(),
                visual: DraftVisualTokens {
                    palette: Vec::new(),
                    spacing: Vec::new(),
                    min_text_size: Some(1.0),
                },
                motion: MotionTokens {
                    duration: Vec::new(),
                    easing: Vec::new(),
                    stagger: Vec::new(),
                },
                brief: String::new(),
                mappings: Vec::new(),
                unexpressible: Vec::new(),
                source: DesignSystemSource {
                    kind: DesignSystemSourceKind::W3c,
                    sha256: ContentHash("witness".into()),
                    document: "{}".into(),
                },
            },
            confirmed_by: "witness".into(),
        }
    }

    /// One ordered, successful batch covering every `SceneEdit` variant
    /// against [`fixture_scene`] (no origin, no design system).
    pub fn scene_edits() -> Vec<SceneEdit> {
        vec![
            SceneEdit::CreateObject(CreateObject {
                kind: "rect".into(),
                name: "Created".into(),
            }),
            SceneEdit::DuplicateObject(DuplicateObject {
                object_id: "rect-1".into(),
            }),
            SceneEdit::DeleteObject(DeleteObject {
                object_id: "rect-2".into(),
            }),
            SceneEdit::RenameObject(RenameObject {
                object_id: "rect-1".into(),
                name: "Renamed".into(),
            }),
            SceneEdit::SetObjectField(SetObjectField {
                object_ids: vec!["card".into()],
                field: crate::object_edit::ObjectField::X(10.0),
            }),
            SceneEdit::EditProperty(EditProperty {
                object_id: "card".into(),
                property: "x".into(),
                value: 11.0,
                frame: 1,
                auto_key: true,
            }),
            SceneEdit::UpdateKeyframe(UpdateKeyframe {
                object_id: "card".into(),
                property: "x".into(),
                keyframe: SceneKeyframe {
                    frame: 1,
                    value: 12.0,
                    easing: animation::SceneEasing::Linear,
                    bezier: None,
                },
            }),
            SceneEdit::MoveKeyframe(MoveKeyframe {
                object_id: "card".into(),
                property: "x".into(),
                from_frame: 1,
                to_frame: 2,
            }),
            SceneEdit::RemoveKeyframe(RemoveKeyframe {
                object_id: "card".into(),
                property: "x".into(),
                frame: 2,
            }),
            SceneEdit::CreateKeyframe(CreateKeyframe {
                object_id: "card".into(),
                property: "y".into(),
                keyframe: SceneKeyframe {
                    frame: 3,
                    value: 5.0,
                    easing: animation::SceneEasing::Linear,
                    bezier: None,
                },
            }),
            SceneEdit::ApplyPreset(ApplyPreset {
                object_id: "card".into(),
                preset_id: "fade".into(),
                phase: PresetPhase::In,
                at_frame: 10,
                duration_ms: None,
            }),
            SceneEdit::SetPhase(SetPhase {
                phase: TimelinePhase {
                    kind: PhaseKind::In,
                    name: None,
                    start_frame: 0,
                    end_frame: 5,
                },
            }),
            SceneEdit::RemovePhase(RemovePhase {
                address: "in".into(),
            }),
            SceneEdit::DeclareControl(DeclareControl {
                field: control_field("Control"),
            }),
            SceneEdit::ReplaceControl(ReplaceControl {
                field: control_field("Replacement"),
            }),
            SceneEdit::RemoveControl(RemoveControl {
                field_id: "control".into(),
            }),
            SceneEdit::SaveTextStyle(SaveTextStyle {
                style: TextStyle {
                    style_id: "headline".into(),
                    name: "Headline".into(),
                    font_id: "font".into(),
                    size: StyleNumber::Literal(24.0),
                    line_height: None,
                    letter_spacing: None,
                    text_case: TextCase::Original,
                    fill: None,
                    stroke: None,
                    stroke_width: None,
                },
            }),
            SceneEdit::ApplyTextStyle(ApplyTextStyle {
                object_id: "text".into(),
                style_id: "headline".into(),
            }),
            SceneEdit::SetBinding(SetBinding {
                object_id: "card".into(),
                property: "x".into(),
                path: Some("headline".into()),
            }),
            SceneEdit::ReplaceDataContext(ReplaceDataContext {
                data_context: serde_json::Map::from_iter([(
                    "headline".into(),
                    serde_json::json!(2.0),
                )]),
            }),
            SceneEdit::RelinkMaterial(RelinkMaterial {
                from_material_id: "m1".into(),
                to_material_id: "m2".into(),
            }),
            SceneEdit::DeleteMaterial(DeleteMaterial {
                material_id: "m1".into(),
            }),
            SceneEdit::RelinkAsset(RelinkAsset {
                asset_id: "asset1".into(),
                new_hash: ContentHash("new".into()),
                new_size: Some(2),
            }),
            SceneEdit::SetAssetColorSpace(SetAssetColorSpace {
                asset_id: "asset1".into(),
                color_space: crate::color::SourceColorSpace::Srgb,
            }),
            SceneEdit::SetSceneName(SetSceneName {
                name: "Renamed Witness".into(),
            }),
            SceneEdit::SetSceneId(SetSceneId {
                id: "witness-renamed".into(),
            }),
            SceneEdit::SetSceneLabel(SetSceneLabel {
                label: "7".into(),
            }),
            SceneEdit::SetObjectVisible(SetObjectVisible {
                object_id: "rect-1".into(),
                visible: false,
            }),
            SceneEdit::SetObjectLocked(SetObjectLocked {
                object_id: "rect-1".into(),
                locked: true,
            }),
            SceneEdit::AddFonts(AddFonts {
                fonts: vec![FontDefinition {
                    font_id: "added-font".into(),
                    family: "Added".into(),
                    display_name: "Added".into(),
                    faces: vec![crate::font::FontFaceDefinition {
                        face_id: "added-face".into(),
                        family: "Added".into(),
                        weight: 400,
                        style: crate::font::FontStyle::Normal,
                        stretch: None,
                        unicode_range: None,
                        source: crate::font::FontSource::File {
                            asset_id: "added-font-asset".into(),
                            format: crate::font::FontFormat::Woff2,
                            original_url: None,
                            stylesheet_url: None,
                        },
                        status: None,
                        error_message: None,
                    }],
                    fallback_families: Vec::new(),
                    embedding_policy: EmbeddingPolicy::Package,
                    license: Some("OFL".into()),
                    enabled: true,
                    source_label: None,
                    status: FontLoadStatus::Ready,
                    error_message: None,
                }],
                assets: vec![AssetLibraryItem {
                    asset_id: "added-font-asset".into(),
                    name: "Added".into(),
                    kind: AssetKind::Font,
                    path: "assets/fonts/added.woff2".into(),
                    checksum: Some(ContentHash("added".into())),
                    mime_type: Some("font/woff2".into()),
                    size_bytes: Some(1),
                    status: None,
                    provenance: crate::provenance::AssetProvenance::default(),
                    color_space: None,
                }],
            }),
            // The font is unused, so it may be switched off as well as renamed.
            SceneEdit::UpdateFont(UpdateFont {
                font_id: "added-font".into(),
                display_name: Some("Added Display".into()),
                fallback_families: Some(vec!["Arial".into()]),
                enabled: Some(false),
            }),
            SceneEdit::ReplaceFont(ReplaceFont {
                font_id: "added-font".into(),
                font: FontDefinition {
                    font_id: "replacement-font".into(),
                    family: "Replaced".into(),
                    display_name: "Replaced".into(),
                    faces: vec![crate::font::FontFaceDefinition {
                        face_id: "replaced-face".into(),
                        family: "Replaced".into(),
                        weight: 700,
                        style: crate::font::FontStyle::Normal,
                        stretch: None,
                        unicode_range: None,
                        source: crate::font::FontSource::File {
                            asset_id: "replaced-font-asset".into(),
                            format: crate::font::FontFormat::Woff2,
                            original_url: None,
                            stylesheet_url: None,
                        },
                        status: None,
                        error_message: None,
                    }],
                    fallback_families: Vec::new(),
                    embedding_policy: EmbeddingPolicy::Package,
                    license: Some("OFL".into()),
                    enabled: true,
                    source_label: None,
                    status: FontLoadStatus::Ready,
                    error_message: None,
                },
                assets: vec![AssetLibraryItem {
                    asset_id: "replaced-font-asset".into(),
                    name: "Replaced".into(),
                    kind: AssetKind::Font,
                    path: "assets/fonts/replaced.woff2".into(),
                    checksum: Some(ContentHash("replaced".into())),
                    mime_type: Some("font/woff2".into()),
                    size_bytes: Some(1),
                    status: None,
                    provenance: crate::provenance::AssetProvenance::default(),
                    color_space: None,
                }],
            }),
            SceneEdit::RemoveFont(RemoveFont {
                font_id: "added-font".into(),
            }),
            // Every provenance field set, so the trace carries the whole
            // record through the command surface (11.39).
            SceneEdit::AddAssets(AddAssets {
                assets: vec![AssetLibraryItem {
                    asset_id: "added-image".into(),
                    name: "Added image".into(),
                    kind: AssetKind::Image,
                    path: "assets/images/added.png".into(),
                    checksum: Some(ContentHash("added-image".into())),
                    mime_type: Some("image/png".into()),
                    size_bytes: Some(1),
                    status: None,
                    provenance: crate::provenance::AssetProvenance {
                        origin: Some(crate::provenance::AssetOrigin::Model),
                        tool: Some(crate::provenance::ProvenanceTool {
                            name: "witness-model".into(),
                            version: Some("1".into()),
                        }),
                        provider: Some("witness-provider".into()),
                        license_class: Some(crate::provenance::LicenseClass::Commercial),
                        prompt_hash: Some(ContentHash("witness-prompt".into())),
                        sources: vec!["witness-source".into()],
                        approval: Some(crate::provenance::AssetApproval {
                            user: "witness".into(),
                            at: "2026-10-03T00:00:00Z".into(),
                        }),
                        c2pa_manifest: Some("assets/c2pa/added.c2pa".into()),
                    },
                    color_space: None,
                }],
            }),
            // 59.94 is 60000/1001: a rate a float cannot carry, carried exact.
            SceneEdit::SetCanvas(SetCanvas {
                frame_rate: Some(RationalRate::P59_94),
                width: None,
                height: None,
            }),
            // The render features (3.17 to 3.19), authored through the same
            // path: a group holding a shape and an ellipse, the shape as its
            // clip child, a mask, a track matte, a trim window, a gradient
            // fill and a round dashed stroke.
            SceneEdit::CreateObject(CreateObject {
                kind: "group".into(),
                name: "Stack".into(),
            }),
            SceneEdit::CreateShape(CreateShape {
                name: "Path".into(),
                path: BezierPath {
                    closed: false,
                    vertices: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 100.0, y: 0.0 }],
                    in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 2],
                    out_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 2],
                    vertex_ids: None,
                    vertex_kinds: None,
                    auto_tension: None,
                },
                compound_paths: None,
            }),
            SceneEdit::CreateObject(CreateObject {
                kind: "ellipse".into(),
                name: "Content".into(),
            }),
            SceneEdit::SetGroupChildren(SetGroupChildren {
                group_id: "group-1".into(),
                child_ids: vec!["shape-1".into(), "ellipse-1".into()],
            }),
            SceneEdit::SetObjectMasks(SetObjectMasks {
                object_id: "card".into(),
                masks: vec![crate::scene::Mask {
id: None,
                    path: BezierPath {
                        closed: true,
                        vertices: vec![
                            Vec2 { x: 0.0, y: 0.0 },
                            Vec2 { x: 80.0, y: 0.0 },
                            Vec2 { x: 40.0, y: 60.0 },
                        ],
                        in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                        out_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                        vertex_ids: None,
                        vertex_kinds: None,
                        auto_tension: None,
                    },
                    mode: crate::scene::MaskMode::Add,
                    feather: 4.0,
                    feather_y: None,
                    falloff: Default::default(),
                    feather_points: None,
                    expansion: 0.0,
                    opacity: 1.0,
                    inverted: false,
                }],
            }),
            SceneEdit::SetClipChild(SetClipChild {
                group_id: "group-1".into(),
                clip_child_id: Some("shape-1".into()),
            }),
            SceneEdit::SetTrackMatte(SetTrackMatte {
                object_id: "text".into(),
                track_matte: Some(crate::scene::TrackMatte {
                    source_id: "ellipse-1".into(),
                    mode: crate::scene::TrackMatteMode::Luma,
                }),
            }),
            SceneEdit::SetTrim(SetTrim {
                object_id: "shape-1".into(),
                start: Some(0.0),
                end: Some(50.0),
                offset: None,
            }),
            SceneEdit::SetPaint(SetPaint {
                object_ids: vec!["ellipse-1".into()],
                slot: PaintSlot::Fill,
                paint: Some(ColorValue::LinearGradient {
                    angle: 0.0,
                    start_x: 0.0,
                    start_y: 0.0,
                    end_x: 1.0,
                    end_y: 0.0,
                    stops: vec![
                        crate::color::GradientStop {
                            position: 0.0,
                            color: crate::color::Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                        },
                        crate::color::GradientStop {
                            position: 1.0,
                            color: crate::color::Rgba::srgb(0.0, 0.0, 1.0, 1.0),
                        },
                    ],
                    spread: Default::default(),
                    coordinate_mode: Default::default(),
                }),
            }),
            SceneEdit::SetStroke(SetStroke {
                object_ids: vec!["ellipse-1".into()],
                width: 4.0,
                style: Some(StrokeStyle {
                    join: crate::scene::StrokeJoin::Round,
                    cap: crate::scene::StrokeCap::Round,
                    miter_limit: 4.0,
                    dash: vec![12.0, 6.0],
                    dash_offset: 0.0,
                }),
            }),
            SceneEdit::SetBlendMode(SetBlendMode {
                object_ids: vec!["ellipse-1".into()],
                blend_mode: Some(BlendMode::Multiply),
            }),
            SceneEdit::SetAnchor(SetAnchor {
                object_ids: vec!["ellipse-1".into()],
                anchor: Some(Vec2 { x: 10.0, y: 10.0 }),
            }),
            SceneEdit::SetEffects(SetEffects {
                object_id: "ellipse-1".into(),
                effects: vec![EffectInstance::new(
                    "exposure",
                    crate::effect::Effect::Exposure(crate::effect::Exposure {
                        exposure: 0.5,
                        offset: 0.0,
                        gamma_correction: 1.0,
                    }),
                )],
            }),
            SceneEdit::SetShapePath(SetShapePath {
                shape_id: "shape-1".into(),
                path: BezierPath {
                    closed: true,
                    vertices: vec![
                        Vec2 { x: 0.0, y: 0.0 },
                        Vec2 { x: 100.0, y: 0.0 },
                        Vec2 { x: 100.0, y: 100.0 },
                    ],
                    in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    out_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    vertex_ids: None,
                    vertex_kinds: None,
                    auto_tension: None,
                },
                compound_paths: vec![BezierPath {
                    closed: true,
                    vertices: vec![
                        Vec2 { x: 20.0, y: 20.0 },
                        Vec2 { x: 60.0, y: 20.0 },
                        Vec2 { x: 60.0, y: 60.0 },
                    ],
                    in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    out_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    vertex_ids: None,
                    vertex_kinds: None,
                    auto_tension: None,
                }],
                fill_rule: Some(FillRule::Evenodd),
            }),
            SceneEdit::SetPreserveTransparency(SetPreserveTransparency {
                object_id: "card".into(),
                preserve: true,
            }),
            SceneEdit::EditPath(EditPath {
                object_id: "shape-1".into(),
                target: crate::path_geometry::PathTarget::Shape { subpath: 0 },
                op: crate::path_geometry::PathOp::InsertVertex { segment: 0, t: 0.5 },
                frame: None,
                base_revision: None,
            }),
            SceneEdit::LinkPaths(LinkPaths {
                source: crate::path_link::PathAddress {
                    object_id: "shape-1".into(),
                    target: crate::path_geometry::PathTarget::Shape { subpath: 0 },
                },
                target: crate::path_link::PathAddress {
                    object_id: "card".into(),
                    target: crate::path_geometry::PathTarget::Mask { index: 0 },
                },
            }),
            SceneEdit::UnlinkPath(UnlinkPath {
                path: crate::path_link::PathAddress {
                    object_id: "card".into(),
                    target: crate::path_geometry::PathTarget::Mask { index: 0 },
                },
            }),
            SceneEdit::SetPathKey(SetPathKey {
                object_id: "shape-1".into(),
                target: crate::path_geometry::PathTarget::Shape { subpath: 0 },
                frame: 0,
                path: BezierPath {
                    closed: false,
                    vertices: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 20.0, y: 0.0 }, Vec2 { x: 40.0, y: 10.0 }],
                    in_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    out_tangents: vec![Vec2 { x: 0.0, y: 0.0 }; 3],
                    vertex_ids: Some(vec![0, 1, 2]),
                    vertex_kinds: None,
                    auto_tension: None,
                },
                easing: crate::animation::SceneEasing::Linear,
                bezier: None,
            }),
            SceneEdit::MovePathKey(MovePathKey {
                object_id: "shape-1".into(),
                target: crate::path_geometry::PathTarget::Shape { subpath: 0 },
                from_frame: 0,
                to_frame: 1,
            }),
            SceneEdit::RemovePathKey(RemovePathKey {
                object_id: "shape-1".into(),
                target: crate::path_geometry::PathTarget::Shape { subpath: 0 },
                frame: 1,
            }),
            SceneEdit::CreateColourKey(CreateColourKey {
                object_id: "shape-1".into(),
                property: animation::colour::ColourProperty::Fill,
                keyframe: animation::colour::ColourKeyframe {
                    frame: 0,
                    value: crate::color::Rgba::srgb(1.0, 0.0, 0.0, 1.0),
                    easing: animation::SceneEasing::Linear,
                    bezier: None,
                },
            }),
            SceneEdit::UpdateColourKey(UpdateColourKey {
                object_id: "shape-1".into(),
                property: animation::colour::ColourProperty::Fill,
                keyframe: animation::colour::ColourKeyframe {
                    frame: 0,
                    value: crate::color::Rgba::srgb(0.0, 0.0, 1.0, 1.0),
                    easing: animation::SceneEasing::Hold,
                    bezier: None,
                },
            }),
            SceneEdit::MoveColourKey(MoveColourKey {
                object_id: "shape-1".into(),
                property: animation::colour::ColourProperty::Fill,
                from_frame: 0,
                to_frame: 1,
            }),
            SceneEdit::RemoveColourKey(RemoveColourKey {
                object_id: "shape-1".into(),
                property: animation::colour::ColourProperty::Fill,
                frame: 1,
            }),
            SceneEdit::RemoveSubpath(RemoveSubpath {
                shape_id: "shape-1".into(),
                subpath: 1,
            }),
            SceneEdit::AddGuide(AddGuide {
                axis: crate::scene::GuideAxis::X,
                position: 960.0,
            }),
            SceneEdit::MoveGuide(MoveGuide { id: 1, position: 480.0 }),
            SceneEdit::RemoveGuide(RemoveGuide { id: 1 }),
            SceneEdit::SetTextAnimator(SetTextAnimator {
                object_ids: vec!["text".into()],
                animator: Some(crate::text_animator::TextAnimator::default()),
            }),
            SceneEdit::ApplyTextAnimatorPreset(ApplyTextAnimatorPreset {
                object_id: "text".into(),
                // 1.5 s: it fits the witness scene's 100 frames at its rate.
                preset_id: "ec.textanimator.fadeUpCharacters".into(),
                at_frame: 0,
            }),
        ]
    }

    #[test]
    fn set_text_animator_is_atomic_and_removing_it_clears_only_its_keys() {
        let mut scene = fixture_scene();
        scene.timeline.duration_frames = 20;
        let text = "text".to_owned();
        let rect = authoring::create_object(&mut scene, "rect", "Plate").unwrap();
        let editable = |object_ids, animator| SceneEdit::SetTextAnimator(SetTextAnimator { object_ids, animator });
        let ctx = EditContext::default();
        let animator = crate::text_animator::TextAnimator { x: 12.0, ..Default::default() };
        let original = scene.clone();
        assert!(matches!(
            apply_edits(&mut scene, &[editable(vec![text.clone(), rect.clone()], Some(animator.clone()))], &ctx),
            Err(Refusal::AnimationPropertyUnsupported { object, property }) if object == rect && property == "textAnimator"
        ));
        assert_eq!(scene, original);
        let invalid = crate::text_animator::TextAnimator { scale: -1.0, ..animator.clone() };
        assert!(apply_edits(&mut scene, &[editable(vec![text.clone()], Some(invalid))], &ctx).is_err());
        assert_eq!(scene, original);

        let (before, _) = apply_edits(&mut scene, &[editable(vec![text.clone()], Some(animator))], &ctx).unwrap();
        assert_eq!(before, original);
        let key = |value| SceneKeyframe { frame: 5, value, easing: animation::SceneEasing::Linear, bezier: None };
        let property = "textAnimator.selector.start";
        assert!(animation::set_keyframe(&mut scene, &text, property, key(1.1)).is_err());
        animation::set_keyframe(&mut scene, &text, property, key(0.25)).unwrap();
        animation::set_keyframe(&mut scene, &text, "opacity", key(0.5)).unwrap();
        let before_remove = scene.clone();
        let (previous, _) = apply_edits(&mut scene, &[editable(vec![text.clone()], None)], &ctx).unwrap();
        assert_eq!(previous, before_remove);
        assert_eq!(scene.timeline.channels.len(), 1);
        assert_eq!(scene.timeline.channels[0].property, "opacity");
        let SceneObject::Text(removed) = scene.objects.iter().find(|object| object.base().id == text).unwrap()
            else { unreachable!() };
        assert!(removed.text_animator.is_none());
    }

    fn control_field(label: &str) -> ControlField {
        ControlField {
            field_id: "control".into(),
            label: label.into(),
            object_id: "card".into(),
            property: "x".into(),
            kind: ControlFieldKind::Number,
            default: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::scene::{new_scene, ObjectBase, RectObject, SceneObject};

    const NO_CONTEXT: EditContext<'static> = EditContext {
        design_system: None,
        origin: None,
        presets: None,
    };

    fn scene_with_card() -> SceneDocument {
        let mut scene = new_scene(
            "scene",
            "Scene",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        scene.objects.push(SceneObject::Rect(RectObject {
            base: ObjectBase::new("card", "Card"),
            radius: 0.0,
        }));
        scene
    }

    fn create(kind: &str, name: &str) -> SceneEdit {
        CreateObject {
            kind: kind.into(),
            name: name.into(),
        }
        .into()
    }

    fn rename(object_id: &str, name: &str) -> SceneEdit {
        RenameObject {
            object_id: object_id.into(),
            name: name.into(),
        }
        .into()
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "gx-contracts-command-{label}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn an_empty_batch_is_refused_without_mutation() {
        let mut scene = scene_with_card();
        let before = scene.clone();
        assert_eq!(
            apply_edits(&mut scene, &[], &NO_CONTEXT),
            Err(Refusal::EditBatchEmpty)
        );
        assert_eq!(scene, before);
    }

    #[test]
    fn deleting_several_keys_checks_the_final_curve_not_an_intermediate_join() {
        let mut scene = scene_with_card();
        let key = |frame, value| animation::SceneKeyframe {
            frame,
            value,
            easing: animation::SceneEasing::Linear,
            bezier: None,
        };
        let mut first = key(0, 0.0);
        first.easing = animation::SceneEasing::CustomBezier;
        first.bezier = Some(animation::CubicBezier {
            x1: 0.25,
            y1: 1.4,
            x2: 0.75,
            y2: 1.4,
        });
        for key in [first, key(40, 0.5), key(80, 1.0), key(100, 0.5)] {
            animation::set_keyframe(&mut scene, "card", "opacity", key).unwrap();
        }
        let delete = |frame| {
            SceneEdit::RemoveKeyframe(RemoveKeyframe {
                object_id: "card".into(),
                property: "opacity".into(),
                frame,
            })
        };
        let before = scene.clone();
        assert!(matches!(
            apply_edits(&mut scene, &[delete(40)], &NO_CONTEXT),
            Err(Refusal::KeyframeValueOutOfDomain { .. })
        ));
        assert_eq!(scene, before);
        apply_edits(&mut scene, &[delete(40), delete(80)], &NO_CONTEXT).unwrap();
        assert_eq!(
            scene.timeline.channels[0]
                .keys
                .iter()
                .map(|key| key.frame)
                .collect::<Vec<_>>(),
            [0, 100]
        );
        animation::validate_scene_animation(&scene).unwrap();
    }

    #[test]
    fn a_batch_applies_in_order_and_returns_the_before_image() {
        let mut scene = scene_with_card();
        let original = scene.clone();
        // The rename names the object the create made: a later edit sees an
        // earlier one, which is what one gesture of several edits needs.
        let (before, effects) = apply_edits(
            &mut scene,
            &[create("rect", "Bar"), rename("rect-1", "Renamed bar")],
            &NO_CONTEXT,
        )
        .unwrap();
        assert_eq!(before, original);
        assert_eq!(
            effects,
            vec![
                EditEffect::ObjectCreated {
                    object_id: "rect-1".into()
                },
                EditEffect::None
            ]
        );
        assert_eq!(scene.objects.len(), 2);
        assert_eq!(scene.objects[1].base().name, "Renamed bar");
    }

    #[test]
    fn a_refused_member_leaves_the_whole_batch_unapplied() {
        let mut scene = scene_with_card();
        let before = scene.clone();
        let refusal = apply_edits(
            &mut scene,
            &[create("rect", "Bar"), rename("missing", "Nope")],
            &NO_CONTEXT,
        )
        .unwrap_err();
        assert!(
            matches!(refusal, Refusal::SceneObjectUnknown { .. }),
            "{refusal:?}"
        );
        assert_eq!(
            scene, before,
            "the first member must not survive the second's refusal"
        );
    }

    #[test]
    fn unknown_command_fields_refuse_with_their_path() {
        let refusal = parse_command(serde_json::json!({
            "command": "editScene",
            "target": { "target": "session", "session": 1, "project": "news" },
            "edits": [{ "edit": "setSceneName", "name": "News" }]
        }))
        .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::CommandUnknownField {
                path: "target.project".into()
            }
        );

        let refusal = parse_command(serde_json::json!({
            "command": "editScene",
            "target": { "target": "session", "session": 1 },
            "edits": [
                { "edit": "setSceneName", "name": "News" },
                {
                    "edit": "createKeyframe",
                    "objectId": "card",
                    "property": "x",
                    "keyframe": { "frame": 1, "value": 2.0, "easing": "linear", "tension": 1 }
                }
            ]
        }))
        .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::CommandUnknownField {
                path: "edits[1].keyframe.tension".into()
            }
        );

        let refusal = parse_command(serde_json::json!({
            "command": "undo", "session": 1, "steps": 2
        }))
        .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::CommandUnknownField {
                path: "steps".into()
            }
        );
    }

    #[test]
    fn an_explicit_null_is_absence_not_an_unknown_field() {
        let parsed = parse_command(serde_json::json!({
            "command": "editScene",
            "target": { "target": "session", "session": 1 },
            "edits": [{ "edit": "setBinding", "objectId": "card", "property": "x", "path": null, "future": null }]
        }))
        .unwrap();
        assert_eq!(
            parsed,
            EditorCommand::EditScene(EditScene {
                target: SceneTarget::Session {
                    session: SessionKey(1)
                },
                edits: vec![SceneEdit::SetBinding(SetBinding {
                    object_id: "card".into(),
                    property: "x".into(),
                    path: None,
                })],
                module: None,
                if_revision: None,
            })
        );
    }

    #[test]
    fn a_malformed_command_is_a_parse_refusal() {
        for value in [
            serde_json::json!({ "command": "teleport" }),
            serde_json::json!({ "command": "undo" }),
            serde_json::json!({ "command": "undo", "session": "one" }),
            serde_json::json!([]),
        ] {
            assert!(
                matches!(
                    parse_command(value.clone()),
                    Err(Refusal::SceneParseFailed { .. })
                ),
                "{value} was not refused as malformed"
            );
        }
    }

    #[test]
    fn every_variant_round_trips_through_the_strict_reader() {
        let root = scratch("round-trip");
        let commands = witness::every_command(&root);
        let mut command_indices = BTreeSet::new();
        let mut edit_indices = BTreeSet::new();
        for command in &commands {
            command_indices.insert(witness::variant_index(command));
            let wire = serde_json::to_value(command).unwrap();
            assert_eq!(wire["command"], command.name());
            assert_eq!(parse_command(wire).as_ref(), Ok(command));
            if let EditorCommand::EditScene(edit) = command {
                for scene_edit in &edit.edits {
                    edit_indices.insert(witness::edit_index(scene_edit));
                    let wire = serde_json::to_value(scene_edit).unwrap();
                    assert_eq!(wire["edit"], scene_edit.name());
                    assert_eq!(parse_strict::<SceneEdit>(wire).as_ref(), Ok(scene_edit));
                }
            }
        }
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(command_indices, (0..EditorCommand::NAMES.len()).collect());
        assert_eq!(edit_indices, (0..SceneEdit::NAMES.len()).collect());
        assert_eq!(
            EditorCommand::NAMES.len(),
            EditorCommand::PAYLOAD_NAMES.len()
        );
        assert_eq!(SceneEdit::NAMES.len(), SceneEdit::PAYLOAD_NAMES.len());
    }

    #[test]
    fn the_witness_edit_batch_applies_to_the_witness_fixture() {
        let mut scene = witness::fixture_scene();
        let edits = witness::scene_edits();
        let (_, effects) = apply_edits(&mut scene, &edits, &NO_CONTEXT).unwrap();
        assert_eq!(effects.len(), edits.len());
        assert_eq!(scene.name, "Renamed Witness");
        assert_eq!(scene.id, "witness-renamed");
    }

    #[test]
    fn the_witness_fixture_is_a_strictly_readable_scene() {
        let bytes = serde_json::to_vec(&witness::fixture_scene()).unwrap();
        crate::scene::parse_scene_document(&bytes).unwrap();
    }

    #[test]
    fn payload_schemas_follow_the_wire_names() {
        let mut seen = Vec::new();
        EditorCommand::for_each_payload_schema(|payload, tag, schema| {
            seen.push((payload, tag));
            if payload == "OpenScene" {
                let text = serde_json::to_string(&schema).unwrap();
                // Struct-variant fields are camelCase on the wire, and the
                // schema must say so, or it validates a shape serde rejects.
                assert!(text.contains("\"sceneId\""), "{text}");
                assert!(!text.contains("scene_id"), "{text}");
            }
        });
        let expected: Vec<_> = EditorCommand::PAYLOAD_NAMES
            .iter()
            .copied()
            .zip(EditorCommand::NAMES.iter().copied())
            .collect();
        assert_eq!(seen, expected);

        let mut binding_required = None;
        SceneEdit::for_each_payload_schema(|payload, _, schema| {
            if payload == "SetBinding" {
                binding_required = Some(schema.as_value()["required"].clone());
            }
        });
        assert_eq!(
            binding_required,
            Some(serde_json::json!(["objectId", "property"]))
        );
    }

    #[test]
    fn optional_payload_fields_are_optional_in_typescript() {
        let declaration = <SetBinding as TS>::decl();
        assert!(declaration.contains("path?: string"), "{declaration}");
        let declaration = <RelinkAsset as TS>::decl();
        assert!(declaration.contains("newSize?: bigint"), "{declaration}");
    }

    #[test]
    fn a_bound_scene_keeps_its_id() {
        let mut scene = scene_with_card();
        let origin = SceneOrigin {
            project: "news".into(),
            scene_id: "scene".into(),
        };
        let bound = EditContext {
            design_system: None,
            origin: Some(&origin),
            presets: None,
        };
        let edit: SceneEdit = SetSceneId { id: "other".into() }.into();
        assert_eq!(
            apply_edits(&mut scene, std::slice::from_ref(&edit), &bound),
            Err(Refusal::SceneIdBound {
                project: "news".into(),
                scene_id: "scene".into()
            })
        );
        apply_edits(&mut scene, &[edit], &NO_CONTEXT).unwrap();
        assert_eq!(scene.id, "other");
    }

    #[test]
    fn scene_identity_edits_refuse_unusable_values() {
        let mut scene = scene_with_card();
        for id in ["", "a/b", "..", "con"] {
            let edit: SceneEdit = SetSceneId { id: id.into() }.into();
            assert_eq!(
                apply_edits(&mut scene, &[edit], &NO_CONTEXT),
                Err(Refusal::SceneIdInvalid { id: id.into() })
            );
        }
        let edit: SceneEdit = SetSceneName { name: "   ".into() }.into();
        assert_eq!(
            apply_edits(&mut scene, &[edit], &NO_CONTEXT),
            Err(Refusal::SceneNameEmpty)
        );
        let edit: SceneEdit = SetSceneName {
            name: "  News  ".into(),
        }
        .into();
        apply_edits(&mut scene, &[edit], &NO_CONTEXT).unwrap();
        assert_eq!(scene.name, "News");
    }

    #[test]
    fn renaming_a_scene_id_changes_the_label_and_breaks_no_cue() {
        use crate::ids::CueTable;
        let mut scene = scene_with_card();
        let key = crate::TakeId(scene.id.clone());
        let mut show = CueTable::default();
        show.assign("Open", key.clone()).unwrap();
        let set = |label: &str| -> SceneEdit { SetSceneLabel { label: label.into() }.into() };
        apply_edits(&mut scene, &[set("12")], &NO_CONTEXT).unwrap();
        assert_eq!(scene.scene_label.as_deref(), Some("12"));
        apply_edits(&mut scene, &[set("  Opener-2  ")], &NO_CONTEXT).unwrap();
        assert_eq!(scene.scene_label.as_deref(), Some("Opener-2"));
        // The scene key, and so every cue that holds it, is what it was.
        assert_eq!(scene.id, "scene");
        assert_eq!(show.scene_of("open").unwrap(), &key);
        // A label the rules refuse, an unchanged one and an empty one are each told apart.
        assert!(matches!(
            apply_edits(&mut scene, &[set("two words")], &NO_CONTEXT),
            Err(Refusal::SceneLabelInvalid { fault: crate::ids::IdFault::BadCharacter, .. })
        ));
        assert_eq!(
            apply_edits(&mut scene, &[set("Opener-2")], &NO_CONTEXT),
            Err(Refusal::ObjectFieldUnchanged { field: "sceneLabel".into() })
        );
        assert_eq!(scene.scene_label.as_deref(), Some("Opener-2"), "a refused edit leaves the label alone");
        apply_edits(&mut scene, &[set("  ")], &NO_CONTEXT).unwrap();
        assert_eq!(scene.scene_label, None);
        assert_eq!(
            apply_edits(&mut scene, &[set("")], &NO_CONTEXT),
            Err(Refusal::ObjectFieldUnchanged { field: "sceneLabel".into() })
        );
    }

    #[test]
    fn a_scene_file_with_a_refused_scene_id_is_refused_by_name() {
        let mut scene = scene_with_card();
        scene.scene_label = Some("not ok".into());
        let refused = crate::drawability::drawability_refusals(&scene);
        assert!(
            refused.iter().any(|r| matches!(r.code, Refusal::SceneLabelInvalid { .. }) && r.field.as_deref() == Some("sceneLabel")),
            "{refused:?}"
        );
        scene.scene_label = Some("7".into());
        assert!(crate::drawability::drawability_refusals(&scene).iter().all(|r| !matches!(r.code, Refusal::SceneLabelInvalid { .. })));
    }

    #[test]
    fn an_unknown_asset_or_preset_is_refused_by_name() {
        let mut scene = scene_with_card();
        let edit: SceneEdit = RelinkAsset {
            asset_id: "missing".into(),
            new_hash: ContentHash("abc".into()),
            new_size: None,
        }
        .into();
        assert_eq!(
            apply_edits(&mut scene, &[edit], &NO_CONTEXT),
            Err(Refusal::SceneAssetUnknown {
                asset_id: "missing".into(),
                object: "scene".into()
            })
        );
        let edit: SceneEdit = ApplyPreset {
            object_id: "card".into(),
            preset_id: "teleport".into(),
            phase: PresetPhase::In,
            at_frame: 0,
            duration_ms: None,
        }
        .into();
        assert_eq!(
            apply_edits(&mut scene, &[edit], &NO_CONTEXT),
            Err(Refusal::MotionPresetUnknown {
                preset: "teleport".into()
            })
        );
    }

    #[test]
    fn a_preset_phase_writes_keys_and_reports_its_length() {
        let mut scene = scene_with_card();
        scene.timeline.duration_frames = 200;
        let edit: SceneEdit = ApplyPreset {
            object_id: "card".into(),
            preset_id: "fade".into(),
            phase: PresetPhase::In,
            at_frame: 10,
            duration_ms: None,
        }
        .into();
        let (_, effects) = apply_edits(&mut scene, &[edit], &NO_CONTEXT).unwrap();
        assert!(
            matches!(effects[0], EditEffect::PresetApplied { duration_frames } if duration_frames > 0)
        );
        assert!(!scene.timeline.channels.is_empty());
    }

    fn slide_in_at(scene: &mut SceneDocument, at_frame: u64) {
        let edit: SceneEdit = ApplyPreset {
            object_id: "card".into(),
            preset_id: "slide".into(),
            phase: PresetPhase::In,
            at_frame,
            duration_ms: None,
        }
        .into();
        apply_edits(scene, &[edit], &NO_CONTEXT).unwrap();
    }

    fn x_keys(scene: &SceneDocument, object: &str) -> Vec<(u64, f64)> {
        scene
            .timeline
            .channels
            .iter()
            .find(|channel| channel.object_id == object && channel.property == "x")
            .map(|channel| {
                channel
                    .keys
                    .iter()
                    .map(|key| (key.frame, key.value))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn captured_keys_save_as_a_phase_that_applies_to_a_differently_sized_object() {
        use crate::animation::{capture_motion_phase, KeyRef};
        use crate::design_system::{DurationSpec, MotionPhase, MotionPhases, MotionPreset};

        let mut scene = scene_with_card();
        scene.objects.push(SceneObject::Rect(RectObject {
            base: {
                let mut base = ObjectBase::new("wide", "Wide");
                base.x = 100.0;
                base.width = 400.0;
                base
            },
            radius: 0.0,
        }));
        if let Some(SceneObject::Rect(card)) = scene.objects.first_mut() {
            card.base.x = 50.0;
            card.base.width = 100.0;
        }
        slide_in_at(&mut scene, 10);
        let authored = x_keys(&scene, "card");
        assert_eq!(authored.len(), 2, "{authored:?}");
        let refs: Vec<KeyRef> = authored
            .iter()
            .map(|(frame, _)| KeyRef {
                property: "x".into(),
                frame: *frame,
            })
            .collect();

        let phase = capture_motion_phase(&scene, "card", &refs).unwrap();
        // 20 frames at 50p is 400 ms, and the offsets are in object-widths.
        assert_eq!(phase.duration, DurationSpec::Ms(400.0));
        assert_eq!(phase.channels.len(), 1);
        assert_eq!(phase.channels[0].property, "position.x");
        assert_eq!(phase.channels[0].keys[0].t, 0.0);
        assert_eq!(phase.channels[0].keys[1].t, 1.0);
        assert_eq!(phase.channels[0].keys[0].v, -1.0);
        assert_eq!(phase.channels[0].keys[1].v, 0.0);

        let empty = || MotionPhase {
            duration: DurationSpec::Ms(0.0),
            channels: Vec::new(),
        };
        let saved = MotionPreset {
            id: "mine".into(),
            applies_to: vec!["rect".into()],
            phases: MotionPhases {
                r#in: phase,
                out: empty(),
                hold: None,
                r#continue: Vec::new(),
                update: None,
            },
            params: Vec::new(),
            stagger: None,
        };
        // A saved preset with no out phase is the unusable one G.6.6 names.
        assert!(saved.validate().is_err());
        let library = [saved];
        let context = EditContext {
            presets: Some(&library),
            ..NO_CONTEXT
        };
        let edit: SceneEdit = ApplyPreset {
            object_id: "wide".into(),
            preset_id: "mine".into(),
            phase: PresetPhase::In,
            at_frame: 100,
            duration_ms: None,
        }
        .into();
        apply_edits(&mut scene, &[edit], &context).unwrap();
        // One width of 400 to the left of x=100, arriving on it: the same
        // motion, scaled to the object it landed on.
        assert_eq!(x_keys(&scene, "wide"), vec![(100, -300.0), (120, 100.0)]);

        // Without the library the same id is unknown, not silently a starter.
        let mut other = scene_with_card();
        let edit: SceneEdit = ApplyPreset {
            object_id: "card".into(),
            preset_id: "mine".into(),
            phase: PresetPhase::In,
            at_frame: 0,
            duration_ms: None,
        }
        .into();
        assert_eq!(
            apply_edits(&mut other, &[edit], &NO_CONTEXT),
            Err(Refusal::MotionPresetUnknown {
                preset: "mine".into()
            })
        );
    }

    #[test]
    fn capture_refuses_by_name_and_names_what_it_did_not_save() {
        use crate::animation::{capture_motion_phase, KeyRef};

        let mut scene = scene_with_card();
        slide_in_at(&mut scene, 10);
        let key = |frame: u64| KeyRef {
            property: "x".into(),
            frame,
        };
        assert_eq!(
            capture_motion_phase(&scene, "card", &[]),
            Err(Refusal::MotionPresetSelectionEmpty {
                object: "card".into()
            })
        );
        assert_eq!(
            capture_motion_phase(&scene, "card", &[key(10)]),
            Err(Refusal::MotionPresetSpanZero {
                object: "card".into(),
                frame: 10
            })
        );
        assert_eq!(
            capture_motion_phase(&scene, "card", &[key(10), key(11)]),
            Err(Refusal::KeyframeUnknown {
                object: "card".into(),
                property: "x".into(),
                frame: 11
            })
        );
        assert_eq!(
            capture_motion_phase(
                &scene,
                "card",
                &[KeyRef {
                    property: "fill".into(),
                    frame: 10
                }]
            ),
            Err(Refusal::AnimationPropertyUnsupported {
                object: "card".into(),
                property: "fill".into()
            })
        );
        // The scene is only read: nothing above wrote a channel.
        assert_eq!(x_keys(&scene, "card").len(), 2);
    }

    #[test]
    fn a_preset_duration_is_held_to_its_declared_range() {
        let apply = |duration_ms: Option<f64>, preset: &str| -> SceneEdit {
            ApplyPreset {
                object_id: "card".into(),
                preset_id: preset.into(),
                phase: PresetPhase::In,
                at_frame: 10,
                duration_ms,
            }
            .into()
        };
        // Fade declares 80-2000 ms: 600 ms at 50p is 30 frames, not its own 15.
        let mut scene = scene_with_card();
        scene.timeline.duration_frames = 200;
        let (_, effects) =
            apply_edits(&mut scene, &[apply(Some(600.0), "fade")], &NO_CONTEXT).unwrap();
        assert!(matches!(
            effects[0],
            EditEffect::PresetApplied {
                duration_frames: 30
            }
        ));
        let frames: Vec<u64> = scene.timeline.channels[0]
            .keys
            .iter()
            .map(|key| key.frame)
            .collect();
        assert_eq!(frames, vec![10, 40]);

        // Outside the range, or not finite: refused by name, scene untouched.
        for bad in [10.0, 5000.0, f64::NAN] {
            let mut scene = scene_with_card();
            scene.timeline.duration_frames = 200;
            let refusal =
                apply_edits(&mut scene, &[apply(Some(bad), "fade")], &NO_CONTEXT).unwrap_err();
            assert!(
                matches!(&refusal, Refusal::MotionPresetParamInvalid { preset, param, .. } if preset == "fade" && param == "duration"),
                "{bad}: {refusal:?}"
            );
            assert!(scene.timeline.channels.is_empty());
        }
    }

    #[test]
    fn set_canvas_changes_the_rate_exactly_and_keeps_every_frame() {
        let mut scene = new_scene("rate", "Rate", crate::color::WorkingColorSpace::NEW_PROJECT);
        let text = authoring::create_object(&mut scene, "rect", "Plate").unwrap();
        animation::create_keyframe(
            &mut scene,
            &text,
            "x",
            SceneKeyframe {
                frame: 48,
                value: 10.0,
                easing: Default::default(),
                bezier: None,
            },
        )
        .unwrap();
        let ctx = EditContext::default();
        let edits = [SceneEdit::SetCanvas(SetCanvas {
            frame_rate: Some(RationalRate::P29_97),
            width: None,
            height: None,
        })];
        apply_edits(&mut scene, &edits, &ctx).unwrap();
        assert_eq!(
            scene.canvas.frame_rate,
            RationalRate {
                num: 30000,
                den: 1001
            },
            "the rational is carried exact"
        );
        assert_eq!(
            scene.timeline.duration_frames, 250,
            "frames are canonical: the duration in frames is kept"
        );
        assert_eq!(
            scene.timeline.channels[0].keys[0].frame, 48,
            "a key stays on its frame"
        );

        let edits = [SceneEdit::SetCanvas(SetCanvas {
            frame_rate: None,
            width: Some(3840),
            height: Some(2160),
        })];
        apply_edits(&mut scene, &edits, &ctx).unwrap();
        assert_eq!((scene.canvas.width, scene.canvas.height), (3840, 2160));

        let before = scene.clone();
        let refused = |edit: SetCanvas| {
            apply_edits(&mut scene.clone(), &[SceneEdit::SetCanvas(edit)], &ctx).unwrap_err()
        };
        assert!(matches!(
            refused(SetCanvas {
                frame_rate: Some(RationalRate { num: 0, den: 1 }),
                width: None,
                height: None
            }),
            Refusal::InvalidRate { num: 0, den: 1 }
        ));
        assert!(matches!(
            refused(SetCanvas {
                frame_rate: None,
                width: Some(0),
                height: None
            }),
            Refusal::ObjectFieldValueInvalid { .. }
        ));
        assert!(matches!(
            refused(SetCanvas {
                frame_rate: Some(RationalRate::P29_97),
                width: Some(3840),
                height: None
            }),
            Refusal::ObjectFieldUnchanged { .. }
        ));
        assert!(matches!(
            refused(SetCanvas {
                frame_rate: None,
                width: None,
                height: None
            }),
            Refusal::ObjectFieldUnchanged { .. }
        ));
        assert_eq!(scene, before, "a refused canvas edit changes nothing");
    }
}

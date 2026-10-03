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

use crate::animation::{self, AutoKey, SceneKeyframe};
use crate::authoring::{self, ObjectDeletion, ObjectDuplication};
use crate::bindings::{self, BindingIssue};
use crate::control::{self, ControlField, TakePage};
use crate::design_system::{self, DesignSystem, DesignSystemCommit};
use crate::object_edit::{self, ObjectField};
use crate::phases::{self, TimelinePhase};
use crate::font::FontDefinition;
use crate::scene::{AssetLibraryItem, DataContext, SceneDocument};
use crate::text_style::{self, TextStyle};
use crate::{font_edit, material_edit, ContentHash, Refusal};

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

commands! {
    /// The one editor command type. Every authoring mutation, from every
    /// surface (Tauri, MCP), is a value of this type.
    EditorCommand, "command" {
        /// Open a document in a new session.
        OpenScene = "openScene" { pub source: SceneSource },
        /// Close a session; a dirty session refuses unless `force`.
        CloseScene = "closeScene" { pub session: SessionKey, pub force: bool },
        /// Apply an ordered, atomic edit batch to one document.
        EditScene = "editScene" { pub target: SceneTarget, pub edits: Vec<SceneEdit> },
        /// Restore a session's previous document.
        Undo = "undo" { pub session: SessionKey },
        /// Reapply the last undone batch.
        Redo = "redo" { pub session: SessionKey },
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
        /// Delete a stored scene.
        DeleteScene = "deleteScene" { pub project: String, pub scene_id: String },
        /// Store an operator take page.
        SaveTakePage = "saveTakePage" { pub project: String, pub page: TakePage },
        /// Confirm a design-system draft as the project's next version.
        ConfirmDesignSystem = "confirmDesignSystem" { pub project: String, pub commit: DesignSystemCommit },
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
        SetSceneName = "setSceneName" { pub name: String },
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
    }
}

/// What a scene edit may read beside the document itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct EditContext<'a> {
    /// The confirmed design system of the document's project, if any.
    pub design_system: Option<&'a DesignSystem>,
    /// The stored scene the document is bound to, if any.
    pub origin: Option<&'a SceneOrigin>,
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
    ObjectCreated { object_id: String },
    ObjectDeleted(ObjectDeletion),
    ObjectDuplicated(ObjectDuplication),
    ObjectsChanged { object_ids: Vec<String> },
    PresetApplied { duration_frames: u64 },
    MaterialsRelinked { changed: Vec<String> },
    DataContextReplaced { newly_invalid: Vec<BindingIssue> },
    SessionOpened { session: SessionKey },
    SessionClosed { session: SessionKey },
    Stored { origin: SceneOrigin },
    ProjectCreated { project: String },
    TakePageSaved { project: String, page_id: String },
    FontRemoved { font_id: String, asset_ids: Vec<String> },
    DesignSystemConfirmed { project: String, version: u32 },
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

/// The result of one executed command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<SessionView>,
    pub effects: Vec<EditEffect>,
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
            animation::remove_keyframe(scene, &p.object_id, &p.property, p.frame)?;
            EditEffect::None
        }
        SceneEdit::ApplyPreset(p) => {
            let preset = design_system::starter_preset(&p.preset_id).ok_or_else(|| {
                Refusal::MotionPresetUnknown {
                    preset: p.preset_id.clone(),
                }
            })?;
            let phase = match p.phase {
                PresetPhase::In => &preset.phases.r#in,
                PresetPhase::Out => &preset.phases.out,
            };
            EditEffect::PresetApplied {
                duration_frames: animation::apply_preset_phase(
                    scene,
                    &p.object_id,
                    phase,
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
        SceneEdit::SetSceneName(p) => {
            let name = p.name.trim();
            if name.is_empty() {
                return Err(Refusal::SceneNameEmpty);
            }
            scene.name = name.to_owned();
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
    })
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
            }),
            EditorCommand::Undo(Undo { session }),
            EditorCommand::Redo(Redo { session }),
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
        ]
    }

    /// The document session 1 opens: it carries every prerequisite the
    /// [`scene_edits`] batch needs (a rect bound to material `m1`, a text
    /// object, a font, an image asset and numeric data).
    pub fn fixture_scene() -> SceneDocument {
        let mut scene = scene::new_scene("witness", "Witness");
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
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
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
            SceneEdit::SetSceneName(SetSceneName {
                name: "Renamed Witness".into(),
            }),
            SceneEdit::SetSceneId(SetSceneId {
                id: "witness-renamed".into(),
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
                }],
            }),
            SceneEdit::RemoveFont(RemoveFont {
                font_id: "added-font".into(),
            }),
        ]
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
    };

    fn scene_with_card() -> SceneDocument {
        let mut scene = new_scene("scene", "Scene");
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
        }
        .into();
        let (_, effects) = apply_edits(&mut scene, &[edit], &NO_CONTEXT).unwrap();
        assert!(
            matches!(effects[0], EditEffect::PresetApplied { duration_frames } if duration_frames > 0)
        );
        assert!(!scene.timeline.channels.is_empty());
    }
}

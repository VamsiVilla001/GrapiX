//! The Editor's Tauri 2 shell (build plan 11.1).
//!
//! **This file is where invariants 4 and 5 are enforced.** The Editor owns
//! mutable authoring content and cannot change Program or outputs. That is
//! not a runtime check on a message here — it is the absence of a command:
//! the surface below has no `cue`, no `take`, no `clear` and no
//! `configure_output`, so a compromised or mistaken web layer cannot reach
//! one however it asks. A flag on a shared command would be a check that can
//! be forgotten; an absent command cannot be.
//!
//! What it does expose: create, load and save an authored `SceneDocument`,
//! and publish one over the asset plane. Publication is the whole of the
//! Editor's authority over Program — it produces a revision Playout may
//! later take, and nothing more (invariant 7: a mutable Editor scene never
//! replaces a published one in place).
//!
//! The shell never imports renderer internals (invariant 3). It speaks the
//! asset plane's published contract and holds no GPU state.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::path::PathBuf;

use gx_contracts::animation::{
    animation_surface, apply_preset_phase, apply_property_edit, create_keyframe, move_keyframe,
    remove_keyframe, set_keyframe, AnimationSurface, AutoKey, SceneKeyframe,
};
use gx_contracts::authoring::{
    create_object, delete_object, duplicate_object, rename_object, ObjectDeletion,
    ObjectDuplication, CREATABLE_KINDS,
};
use gx_contracts::design_system::{starter_presets, MotionPreset};
use gx_contracts::platform::service_data_root;
use gx_editor::project::Projects;
use gx_asset_plane::{publish_scene, PublishClientError, PublishRefusal, PublishReply};
use gx_contracts::scene::{parse_scene_document, SceneCanvas, SceneDocument, SceneTimeline};
use gx_contracts::{RationalRate, Refusal, Revision, TakeId};
use serde::{Deserialize, Serialize};

/// The asset-plane endpoint an Editor publishes to by default.
///
/// The control port plus one, matching the worker's own default. Exposed to
/// the web layer as a starting value, never as a silent fallback: a failed
/// connection is reported with the address it tried.
pub const DEFAULT_ASSET_ENDPOINT: &str = "127.0.0.1:4401";

/// Everything the Editor shell can fail at, named.
///
/// One enum for the whole surface, because the web layer shows the same
/// message box for all of them and a stringly-typed error would let a
/// refusal be presented as a crash.
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
pub enum EditorError {
    /// The path could not be read.
    ReadScene { path: String, detail: String },
    /// The path could not be written.
    WriteScene { path: String, detail: String },
    /// The bytes are not a scene this schema accepts. Carries the contract's
    /// own refusal text, so an unknown field is named by its JSON path rather
    /// than reported as "invalid".
    InvalidScene { detail: String },
    /// The endpoint text is not a socket address.
    InvalidEndpoint { endpoint: String },
    /// The asset plane could not be reached at all. Distinct from a refusal:
    /// nothing was decided, so nothing was published.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the document and declined it, by name.
    PublishRefused { detail: String },
    /// A keyframe edit violated the shared animation contract.
    AnimationRefused { detail: String, cause: Refusal },
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
    /// Project or scene CRUD could not complete. The detail retains the
    /// store's named refusal or IO path; this is not an asset-plane failure.
    ProjectFailed { detail: String },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadScene { path, detail } => write!(f, "cannot read {path}: {detail}"),
            Self::WriteScene { path, detail } => write!(f, "cannot write {path}: {detail}"),
            Self::InvalidScene { detail } => write!(f, "scene is not valid: {detail}"),
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the asset plane at {endpoint}: {detail}")
            }
            Self::PublishRefused { detail } => write!(f, "publication refused: {detail}"),
            Self::AnimationRefused { detail, .. } => write!(f, "animation edit refused: {detail}"),
            Self::ProjectFailed { detail } => write!(f, "project operation failed: {detail}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
        }
    }
}

impl std::error::Error for EditorError {}

/// What a successful publication produced.
///
/// The revision is the point: Playout takes an exact revision, so the Editor
/// must report the one it created rather than "published successfully".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub take_id: TakeId,
    pub revision: Revision,
}

/// An empty authored document at the canvas and rate the Editor starts from.
///
/// 1920×1080 at 50/1 is a starting point an author changes, not a policy:
/// the rate is rational because every rate in this system is (invariant 12).
pub fn new_scene(id: &str, name: &str) -> SceneDocument {
    SceneDocument {
        id: id.to_owned(),
        name: name.to_owned(),
        version: 1,
        revision: None,
        active_camera_id: None,
        canvas: SceneCanvas {
            width: 1920,
            height: 1080,
            frame_rate: RationalRate::P50,
        },
        timeline: SceneTimeline::default(),
        data_context: Default::default(),
        assets: Vec::new(),
        fonts: Vec::new(),
        materials: Vec::new(),
        objects: Vec::new(),
    }
}

/// Read an authored document, refusing anything the closed schema rejects.
///
/// Parsing goes through `parse_scene_document`, the same function the engine
/// and every mock use (invariant 45), so a document the Editor accepts is one
/// the engine will also parse. An Editor with a laxer reader would let an
/// author save something that refuses only at publish.
pub fn load_scene(path: &PathBuf) -> Result<SceneDocument, EditorError> {
    let bytes = std::fs::read(path).map_err(|error| EditorError::ReadScene {
        path: path.display().to_string(),
        detail: error.to_string(),
    })?;
    parse_scene_document(&bytes).map_err(|refusal| EditorError::InvalidScene {
        detail: refusal.to_string(),
    })
}

/// Write an authored document.
///
/// Pretty-printed because this file is edited by people and diffed in review;
/// the wire form is produced fresh at publish, so formatting here costs
/// nothing downstream.
pub fn save_scene(path: &PathBuf, scene: &SceneDocument) -> Result<(), EditorError> {
    let bytes = serde_json::to_vec_pretty(scene).map_err(|error| EditorError::Protocol {
        detail: error.to_string(),
    })?;
    std::fs::write(path, bytes).map_err(|error| EditorError::WriteScene {
        path: path.display().to_string(),
        detail: error.to_string(),
    })
}
fn animation_refused(cause: Refusal) -> EditorError {
    EditorError::AnimationRefused {
        detail: cause.to_string(),
        cause,
    }
}

/// Carry a project-store failure into the shell's project error surface.
fn project_failed(error: gx_editor::project::EditorError) -> EditorError {
    EditorError::ProjectFailed {
        detail: error.to_string(),
    }
}

fn project_condition(detail: impl Into<String>) -> EditorError {
    EditorError::ProjectFailed {
        detail: detail.into(),
    }
}

fn describe_project_error(error: &gx_editor::project::EditorError) -> String {
    error.to_string()
}

/// Apply one keyframe create through the Rust-owned contract and return the
/// updated authoring document. The browser never reimplements these rules.
pub fn keyframe_create(
    mut scene: SceneDocument,
    object_id: &str,
    property: &str,
    keyframe: SceneKeyframe,
) -> Result<SceneDocument, EditorError> {
    create_keyframe(&mut scene, object_id, property, keyframe).map_err(animation_refused)?;
    Ok(scene)
}

/// Update one existing key's value or easing without changing its frame.
pub fn keyframe_update(
    mut scene: SceneDocument,
    object_id: &str,
    property: &str,
    keyframe: SceneKeyframe,
) -> Result<SceneDocument, EditorError> {
    let exists = scene.timeline.channels.iter().any(|channel| {
        channel.object_id == object_id
            && channel.property == property
            && channel.keys.iter().any(|key| key.frame == keyframe.frame)
    });
    if !exists {
        return Err(animation_refused(Refusal::KeyframeUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: keyframe.frame,
        }));
    }
    set_keyframe(&mut scene, object_id, property, keyframe).map_err(animation_refused)?;
    Ok(scene)
}

pub fn keyframe_move(
    mut scene: SceneDocument,
    object_id: &str,
    property: &str,
    from_frame: u64,
    to_frame: u64,
) -> Result<SceneDocument, EditorError> {
    move_keyframe(&mut scene, object_id, property, from_frame, to_frame)
        .map_err(animation_refused)?;
    Ok(scene)
}

pub fn keyframe_remove(
    mut scene: SceneDocument,
    object_id: &str,
    property: &str,
    frame: u64,
) -> Result<SceneDocument, EditorError> {
    remove_keyframe(&mut scene, object_id, property, frame).map_err(animation_refused)?;
    Ok(scene)
}
/// Apply a property value edit with Auto-Key behaviour resolved in Rust.
///
/// `auto_key` off changes the base value only; on also upserts one key at
/// `frame`. The whole edit is validated before anything is written, so a
/// refusal returns the document untouched.
pub fn property_edit(
    mut scene: SceneDocument,
    object_id: &str,
    property: &str,
    value: f64,
    frame: u64,
    auto_key: bool,
) -> Result<SceneDocument, EditorError> {
    let mode = if auto_key { AutoKey::On } else { AutoKey::Off };
    apply_property_edit(&mut scene, object_id, property, value, frame, mode)
        .map_err(animation_refused)?;
    Ok(scene)
}

/// Apply one phase of a starter preset to an object at a frame.
///
/// The caller names intent — which preset, which phase, where — and never a
/// frame count: the phase's duration resolves against the scene's own rational
/// rate here (G.6.2), so the same preset lands on 15 frames at 50p and 9 at
/// 29.97 without the browser doing arithmetic.
pub fn preset_apply(
    mut scene: SceneDocument,
    object_id: &str,
    preset_id: &str,
    phase: &str,
    at_frame: u64,
) -> Result<SceneDocument, EditorError> {
    let preset = starter_presets()
        .into_iter()
        .find(|candidate| candidate.id == preset_id)
        .ok_or_else(|| {
            animation_refused(Refusal::NotImplemented {
                what: format!("no preset named {preset_id}"),
            })
        })?;
    let phase = match phase {
        "in" => &preset.phases.r#in,
        "out" => &preset.phases.out,
        other => {
            return Err(animation_refused(Refusal::NotImplemented {
                what: format!("preset {preset_id} has no {other} phase on this surface"),
            }))
        }
    };
    apply_preset_phase(&mut scene, object_id, phase, at_frame).map_err(animation_refused)?;
    Ok(scene)
}



/// A created object: the document, and the id to select.
///
/// The id is returned rather than left for the caller to find by diffing two
/// documents — the editor has to select what it just made, and a guess there
/// selects the wrong object the moment ordering changes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCreated {
    pub scene: SceneDocument,
    pub object_id: String,
}

/// A deleted object: the document, and everything the delete took with it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDeleted {
    pub scene: SceneDocument,
    pub deletion: ObjectDeletion,
}

/// A duplicated object: the document, and everything the copy created.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDuplicated {
    pub scene: SceneDocument,
    pub duplication: ObjectDuplication,
}

/// Create an object of `kind`, centred in the canvas, and report its id.
pub fn object_create(
    mut scene: SceneDocument,
    kind: &str,
    name: &str,
) -> Result<ObjectCreated, EditorError> {
    let object_id = create_object(&mut scene, kind, name).map_err(animation_refused)?;
    Ok(ObjectCreated { scene, object_id })
}

/// Delete an object and everything that referred to it, and report what went.
pub fn object_delete(
    mut scene: SceneDocument,
    object_id: &str,
) -> Result<ObjectDeleted, EditorError> {
    let deletion = delete_object(&mut scene, object_id).map_err(animation_refused)?;
    Ok(ObjectDeleted { scene, deletion })
}

/// Duplicate an object, its descendants and its animation.
pub fn object_duplicate(
    mut scene: SceneDocument,
    object_id: &str,
) -> Result<ObjectDuplicated, EditorError> {
    let duplication = duplicate_object(&mut scene, object_id).map_err(animation_refused)?;
    Ok(ObjectDuplicated {
        scene,
        duplication,
    })
}

/// Rename an object.
pub fn object_rename(
    mut scene: SceneDocument,
    object_id: &str,
    name: &str,
) -> Result<SceneDocument, EditorError> {
    rename_object(&mut scene, object_id, name).map_err(animation_refused)?;
    Ok(scene)
}

// ---------------------------------------------------------------------------
// Projects and scenes (11.18, over 7.1's store).
//
// The store is `services/editor`'s `Projects`, not a second implementation:
// it already refuses every write until a project folder exists, and reads
// through the same closed reader the engine uses, so a scene the Editor lists
// is one the engine will parse. The shell's only job is to name the root and
// hand the refusals through.
// ---------------------------------------------------------------------------

/// The per-user projects root. A shell that cannot name one says so rather
/// than writing into whatever directory it was launched from.
fn projects() -> Result<Projects, EditorError> {
    let root = service_data_root().map_err(animation_refused)?;
    Ok(Projects::at_root(root.join("projects")))
}

/// A scene as the manager lists it. Ids come from the store; the rest is what
/// the panel needs to say something true about each one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedScene {
    pub scene_id: String,
    pub name: String,
    /// Set when the scene carries a revision, meaning it has been published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_revision: Option<u64>,
    /// Why this row cannot be opened, when its file exists but will not parse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// One complete manager refresh. The design-system version and rows are read
/// together so drift cannot be calculated against a version from an earlier
/// refresh.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSceneCatalog {
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_design_system_version: Option<u32>,
    pub scenes: Vec<ListedScene>,
}

fn require_component(value: &str, label: &str) -> Result<(), EditorError> {
    if gx_contracts::platform::is_canonical_filename(value) {
        Ok(())
    } else {
        Err(project_condition(format!(
            "{label} {value:?} is not one canonical filename"
        )))
    }
}

pub fn project_list() -> Result<Vec<String>, EditorError> {
    projects()?.list_projects().map_err(project_failed)
}

fn project_create_in(store: &Projects, project: &str) -> Result<(), EditorError> {
    require_component(project, "project")?;
    if store.exists(project) {
        return Err(project_condition(format!(
            "project {project:?} already exists"
        )));
    }
    store.create_project(project).map_err(project_failed)
}

pub fn project_create(project: &str) -> Result<(), EditorError> {
    project_create_in(&projects()?, project)
}

/// The scenes in a project, each read through the closed reader.
///
/// A scene that will not parse is reported by name rather than dropped from
/// the list: an author whose file has gone bad needs to see it, not to find
/// it silently missing.
fn scene_catalog_from(
    store: &Projects,
    project: &str,
) -> Result<ProjectSceneCatalog, EditorError> {
    require_component(project, "project")?;
    let ids = store.list_scenes(project).map_err(project_failed)?;
    let mut listed = Vec::with_capacity(ids.len());
    for scene_id in ids {
        match store.read_scene(project, &scene_id) {
            Ok(scene) => listed.push(ListedScene {
                scene_id,
                name: scene.name,
                published_revision: scene.revision.map(|revision| revision.0),
                unavailable_reason: None,
            }),
            Err(error) => listed.push(ListedScene {
                name: scene_id.clone(),
                scene_id,
                published_revision: None,
                unavailable_reason: Some(format!(
                    "scene file is unreadable: {}",
                    describe_project_error(&error)
                )),
            }),
        }
    }
    let current_design_system_version = store
        .design_system(project)
        .and_then(|design_system| design_system.current_version())
        .map_err(project_failed)?;
    Ok(ProjectSceneCatalog {
        project: project.to_owned(),
        current_design_system_version,
        scenes: listed,
    })
}

pub fn scene_list(project: &str) -> Result<ProjectSceneCatalog, EditorError> {
    scene_catalog_from(&projects()?, project)
}

pub fn scene_read(project: &str, scene_id: &str) -> Result<SceneDocument, EditorError> {
    require_component(project, "project")?;
    require_component(scene_id, "scene id")?;
    projects()?
        .read_scene(project, scene_id)
        .map_err(project_failed)
}

fn scene_exists(store: &Projects, project: &str, scene_id: &str) -> Result<bool, EditorError> {
    Ok(store
        .list_scenes(project)
        .map_err(project_failed)?
        .iter()
        .any(|id| id == scene_id))
}

fn scene_create_in(
    store: &Projects,
    project: &str,
    scene: &SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    require_component(project, "project")?;
    require_component(&scene.id, "scene id")?;
    if scene_exists(store, project, &scene.id)? {
        return Err(project_condition(format!(
            "scene id {:?} already exists in project {:?}",
            scene.id, project
        )));
    }
    store.write_scene(project, scene).map_err(project_failed)?;
    scene_catalog_from(store, project)
}

pub fn scene_create(
    project: &str,
    scene: &SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    scene_create_in(&projects()?, project, scene)
}

fn scene_update_in(
    store: &Projects,
    project: &str,
    scene: &SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    require_component(project, "project")?;
    require_component(&scene.id, "scene id")?;
    if !scene_exists(store, project, &scene.id)? {
        return Err(project_condition(format!(
            "scene id {:?} does not exist in project {:?}; create it first",
            scene.id, project
        )));
    }
    store.write_scene(project, scene).map_err(project_failed)?;
    scene_catalog_from(store, project)
}

pub fn scene_update(
    project: &str,
    scene: &SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    scene_update_in(&projects()?, project, scene)
}

fn scene_delete_in(
    store: &Projects,
    project: &str,
    scene_id: &str,
) -> Result<ProjectSceneCatalog, EditorError> {
    require_component(project, "project")?;
    require_component(scene_id, "scene id")?;
    store
        .delete_scene(project, scene_id)
        .map_err(project_failed)?;
    scene_catalog_from(store, project)
}

pub fn scene_delete(project: &str, scene_id: &str) -> Result<ProjectSceneCatalog, EditorError> {
    scene_delete_in(&projects()?, project, scene_id)
}


/// Publish one complete document and report the revision it became.
///
/// Publication is atomic at the far end: the engine either produces a new
/// immutable revision or refuses the whole document (invariant 30). This
/// function keeps the two outcomes distinct all the way to the web layer —
/// an unreachable engine is not a refusal, and a refusal is not a crash.
pub fn publish(endpoint: &str, scene: SceneDocument) -> Result<PublishResult, EditorError> {
    let address: SocketAddr = endpoint.parse().map_err(|_| EditorError::InvalidEndpoint {
        endpoint: endpoint.to_owned(),
    })?;
    match publish_scene(address, scene) {
        Ok(PublishReply::Published { take_id, revision }) => {
            Ok(PublishResult { take_id, revision })
        }
        Ok(PublishReply::Refused(PublishRefusal::InvalidPublishRequest { detail })) => {
            Err(EditorError::PublishRefused { detail })
        }
        Ok(PublishReply::Refused(
            PublishRefusal::SceneRefused { cause } | PublishRefusal::PreparationRefused { cause },
        )) => Err(EditorError::PublishRefused {
            detail: cause.to_string(),
        }),
        Err(PublishClientError::Connect(source)) => Err(EditorError::Unreachable {
            endpoint: endpoint.to_owned(),
            detail: source.to_string(),
        }),
        Err(other) => Err(EditorError::Protocol {
            detail: other.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// The Tauri command surface.
//
// Every command the Editor has. Read the list: there is no way to reach
// Program from here, and that is the design.
// ---------------------------------------------------------------------------

#[tauri::command]
fn cmd_new_scene(id: String, name: String) -> SceneDocument {
    new_scene(&id, &name)
}

#[tauri::command]
fn cmd_load_scene(path: String) -> Result<SceneDocument, EditorError> {
    load_scene(&PathBuf::from(path))
}

#[tauri::command]
fn cmd_save_scene(path: String, scene: SceneDocument) -> Result<(), EditorError> {
    save_scene(&PathBuf::from(path), &scene)
}
#[tauri::command]
fn cmd_animation_surface() -> AnimationSurface {
    animation_surface()
}

#[tauri::command]
fn cmd_keyframe_create(
    scene: SceneDocument,
    object_id: String,
    property: String,
    keyframe: SceneKeyframe,
) -> Result<SceneDocument, EditorError> {
    keyframe_create(scene, &object_id, &property, keyframe)
}

#[tauri::command]
fn cmd_keyframe_update(
    scene: SceneDocument,
    object_id: String,
    property: String,
    keyframe: SceneKeyframe,
) -> Result<SceneDocument, EditorError> {
    keyframe_update(scene, &object_id, &property, keyframe)
}

#[tauri::command]
fn cmd_keyframe_move(
    scene: SceneDocument,
    object_id: String,
    property: String,
    from_frame: u64,
    to_frame: u64,
) -> Result<SceneDocument, EditorError> {
    keyframe_move(scene, &object_id, &property, from_frame, to_frame)
}

#[tauri::command]
fn cmd_keyframe_remove(
    scene: SceneDocument,
    object_id: String,
    property: String,
    frame: u64,
) -> Result<SceneDocument, EditorError> {
    keyframe_remove(scene, &object_id, &property, frame)
}
#[tauri::command]
fn cmd_property_edit(
    scene: SceneDocument,
    object_id: String,
    property: String,
    value: f64,
    frame: u64,
    auto_key: bool,
) -> Result<SceneDocument, EditorError> {
    property_edit(scene, &object_id, &property, value, frame, auto_key)
}

/// The kinds the object menu offers. Read from Rust so the menu cannot drift
/// from what `create_object` will actually accept.
#[tauri::command]
fn cmd_object_kinds() -> Vec<&'static str> {
    CREATABLE_KINDS.to_vec()
}

#[tauri::command]
fn cmd_object_create(
    scene: SceneDocument,
    kind: String,
    name: String,
) -> Result<ObjectCreated, EditorError> {
    object_create(scene, &kind, &name)
}

#[tauri::command]
fn cmd_object_delete(
    scene: SceneDocument,
    object_id: String,
) -> Result<ObjectDeleted, EditorError> {
    object_delete(scene, &object_id)
}

#[tauri::command]
fn cmd_object_duplicate(
    scene: SceneDocument,
    object_id: String,
) -> Result<ObjectDuplicated, EditorError> {
    object_duplicate(scene, &object_id)
}

#[tauri::command]
fn cmd_object_rename(
    scene: SceneDocument,
    object_id: String,
    name: String,
) -> Result<SceneDocument, EditorError> {
    object_rename(scene, &object_id, &name)
}

#[tauri::command]
fn cmd_project_list() -> Result<Vec<String>, EditorError> {
    project_list()
}

#[tauri::command]
fn cmd_project_create(project: String) -> Result<Vec<String>, EditorError> {
    project_create(&project)?;
    project_list()
}

#[tauri::command]
fn cmd_scene_list(project: String) -> Result<ProjectSceneCatalog, EditorError> {
    scene_list(&project)
}

#[tauri::command]
fn cmd_scene_read(project: String, scene_id: String) -> Result<SceneDocument, EditorError> {
    scene_read(&project, &scene_id)
}

#[tauri::command]
fn cmd_scene_create(
    project: String,
    scene: SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    scene_create(&project, &scene)
}

#[tauri::command]
fn cmd_scene_update(
    project: String,
    scene: SceneDocument,
) -> Result<ProjectSceneCatalog, EditorError> {
    scene_update(&project, &scene)
}

#[tauri::command]
fn cmd_scene_delete(
    project: String,
    scene_id: String,
) -> Result<ProjectSceneCatalog, EditorError> {
    scene_delete(&project, &scene_id)
}


#[tauri::command]
fn cmd_starter_presets() -> Vec<MotionPreset> {
    starter_presets()
}

#[tauri::command]
fn cmd_preset_apply(
    scene: SceneDocument,
    object_id: String,
    preset_id: String,
    phase: String,
    at_frame: u64,
) -> Result<SceneDocument, EditorError> {
    preset_apply(scene, &object_id, &preset_id, &phase, at_frame)
}


#[tauri::command]
fn cmd_publish(endpoint: String, scene: SceneDocument) -> Result<PublishResult, EditorError> {
    publish(&endpoint, scene)
}

#[tauri::command]
fn cmd_default_endpoint() -> &'static str {
    DEFAULT_ASSET_ENDPOINT
}

/// Build and run the Editor window.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cmd_new_scene,
            cmd_load_scene,
            cmd_save_scene,
            cmd_publish,
            cmd_animation_surface,
            cmd_default_endpoint,
            cmd_keyframe_create,
            cmd_keyframe_update,
            cmd_keyframe_move,
            cmd_keyframe_remove,
            cmd_property_edit,
            cmd_starter_presets,
            cmd_preset_apply,
            cmd_object_kinds,
            cmd_object_create,
            cmd_object_delete,
            cmd_object_duplicate,
            cmd_object_rename,
            cmd_project_list,
            cmd_project_create,
            cmd_scene_list,
            cmd_scene_read,
            cmd_scene_create,
            cmd_scene_update,
            cmd_scene_delete,
        ])
        .run(tauri::generate_context!())
        .expect("the Editor shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch_projects(label: &str) -> (std::path::PathBuf, Projects) {
        let root = std::env::temp_dir().join(format!(
            "gx-editor-shell-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
        ));
        (root.clone(), Projects::at_root(root))
    }

    #[test]
    fn a_new_scene_is_complete_authoring_content() {
        let scene = new_scene("lower-third", "Lower Third");
        assert_eq!(scene.id, "lower-third");
        assert_eq!(scene.canvas.frame_rate, RationalRate::P50);
        // Never pre-pinned: a revision exists only after the engine issues
        // one, so an unpublished document carrying one would be a lie.

        assert_eq!(scene.revision, None);
    }

    #[test]
    fn an_object_can_be_created_duplicated_renamed_and_deleted_through_the_shell() {
        // The four edits that make the Editor an authoring tool rather than a
        // reader, driven exactly as the web layer drives them.
        let scene = new_scene("lower-third", "Lower Third");
        assert!(scene.objects.is_empty(), "a new scene starts empty");

        let created = object_create(scene, "rect", "Card").expect("create");
        assert_eq!(created.object_id, "rect-1");
        assert_eq!(created.scene.objects.len(), 1);

        let copied = object_duplicate(created.scene, "rect-1").expect("duplicate");
        assert_eq!(copied.duplication.new_object_id, "rect-2");
        assert_eq!(copied.scene.objects.len(), 2);

        let renamed = object_rename(copied.scene, "rect-2", "Card B").expect("rename");
        assert_eq!(renamed.objects[1].base().name, "Card B");

        let deleted = object_delete(renamed, "rect-1").expect("delete");
        assert_eq!(deleted.deletion.removed_object_ids, vec!["rect-1"]);
        assert_eq!(deleted.scene.objects.len(), 1);
        assert_eq!(deleted.scene.objects[0].base().id, "rect-2");
    }

    #[test]
    fn the_object_menu_only_offers_kinds_the_contract_will_create() {
        // The menu is read from Rust so it cannot drift from what
        // `create_object` accepts — a kind that appears and then refuses is
        // the silent gap invariant 18 exists to prevent.
        let kinds = cmd_object_kinds();
        assert!(!kinds.is_empty());
        for kind in kinds {
            let scene = new_scene("probe", "Probe");
            // `text` is the one creatable kind with a scene-level
            // prerequisite; a blank scene carries no fonts.
            if kind == "text" {
                assert!(object_create(scene, kind, "T").is_err());
                continue;
            }
            assert!(
                object_create(scene, kind, "X").is_ok(),
                "menu offers {kind} but the contract refuses it"
            );
        }
    }

    #[test]
    fn a_refused_object_edit_returns_the_document_untouched() {
        let scene = new_scene("lower-third", "Lower Third");
        let created = object_create(scene, "rect", "Card").expect("create");
        let before = created.scene.clone();
        let refused = object_delete(created.scene, "nope");
        assert!(refused.is_err());
        // The document the caller still holds is the one it passed in.
        assert_eq!(before.objects.len(), 1);
        assert!(matches!(
            object_rename(before, "rect-1", "  "),
            Err(EditorError::AnimationRefused { .. })
        ));
    }

    #[test]
    fn a_scene_round_trips_through_the_shared_reader() {
        let directory = std::env::temp_dir().join(format!(
            "gx-editor-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let path = directory.join("scene.json");

        let authored = new_scene("demo", "Demo");
        save_scene(&path, &authored).expect("a new scene saves");
        let read_back = load_scene(&path).expect("what the Editor wrote, it can read");

        assert_eq!(read_back, authored);
        std::fs::remove_dir_all(&directory).expect("remove fixture");
    }

    #[test]
    fn an_unknown_field_refuses_by_name_rather_than_loading() {
        let directory = std::env::temp_dir().join(format!(
            "gx-editor-shell-unknown-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let path = directory.join("scene.json");

        let mut document =
            serde_json::to_value(new_scene("demo", "Demo")).expect("a scene serialises");
        document["notAField"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&document).expect("bytes"))
            .expect("write the hostile document");

        // The Editor must not accept what the engine will refuse: an unknown
        // field is named here, at authoring time, not at publish.
        let error = load_scene(&path).expect_err("an unknown field must refuse");
        assert!(
            matches!(&error, EditorError::InvalidScene { detail } if detail.contains("notAField")),
            "the refusal must name the field, got {error}"
        );
        std::fs::remove_dir_all(&directory).expect("remove fixture");
    }

    #[test]
    fn keyframe_commands_share_the_contracts_create_move_update_remove_rules() {
        let mut scene = new_scene("motion", "Motion");
        scene.timeline.duration_frames = 100;
        scene.objects.push(gx_contracts::scene::SceneObject::Rect(
            gx_contracts::scene::RectObject {
                base: gx_contracts::scene::ObjectBase::new("card", "Card"),
                radius: 0.0,
            },
        ));

        let scene = keyframe_create(
            scene,
            "card",
            "x",
            SceneKeyframe {
                frame: 10,
                value: 100.0,
                easing: gx_contracts::animation::SceneEasing::EaseIn,
                bezier: None,
            },
        )
        .expect("create");
        let scene = keyframe_update(
            scene,
            "card",
            "x",
            SceneKeyframe {
                frame: 10,
                value: 120.0,
                easing: gx_contracts::animation::SceneEasing::CustomBezier,
                bezier: Some(gx_contracts::animation::CubicBezier {
                    x1: 0.2,
                    y1: 0.8,
                    x2: 0.4,
                    y2: 1.0,
                }),
            },
        )
        .expect("update");
        let scene = keyframe_move(scene, "card", "x", 10, 80).expect("move");
        assert_eq!(scene.timeline.channels[0].keys[0].frame, 80);
        assert_eq!(scene.timeline.channels[0].keys[0].value, 120.0);
        assert_eq!(
            scene.timeline.channels[0].keys[0].easing,
            gx_contracts::animation::SceneEasing::CustomBezier
        );

        let scene = keyframe_remove(scene, "card", "x", 80).expect("remove");
        assert!(scene.timeline.channels.is_empty());
    }

    #[test]
    fn property_edit_honours_auto_key_off_and_on() {
        let mut scene = new_scene("motion", "Motion");
        scene.timeline.duration_frames = 100;
        scene.objects.push(gx_contracts::scene::SceneObject::Rect(
            gx_contracts::scene::RectObject {
                base: gx_contracts::scene::ObjectBase::new("card", "Card"),
                radius: 0.0,
            },
        ));

        // Off: base value only, no channel.
        let scene = property_edit(scene, "card", "opacity", 0.5, 10, false).expect("off edit");
        assert!(matches!(&scene.objects[0], gx_contracts::scene::SceneObject::Rect(o) if o.base.opacity == 0.5));
        assert!(scene.timeline.channels.is_empty());

        // On: base and one key together.
        let scene = property_edit(scene, "card", "x", 200.0, 20, true).expect("on edit");
        assert!(matches!(&scene.objects[0], gx_contracts::scene::SceneObject::Rect(o) if o.base.x == 200.0));
        assert_eq!(scene.timeline.channels[0].keys, vec![SceneKeyframe {
            frame: 20,
            value: 200.0,
            easing: gx_contracts::animation::SceneEasing::EaseInOut,
            bezier: None,
        }]);

        // A refused on-edit leaves the document untouched.
        let before = scene.clone();
        let error = property_edit(scene, "card", "x", 9.0, 250, true)
            .expect_err("a frame past the timeline refuses");
        assert!(matches!(error, EditorError::AnimationRefused { cause: Refusal::KeyframeOutOfRange { .. }, .. }));
        assert_eq!(before.objects.len(), 1);
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_before_any_socket_opens() {
        let error = publish("not-an-address", new_scene("demo", "Demo"))
            .expect_err("a malformed endpoint cannot be dialled");
        assert!(matches!(error, EditorError::InvalidEndpoint { .. }));
    }

    #[test]
    fn project_scene_commands_distinguish_create_update_and_delete() {
        let (root, store) = scratch_projects("scene-crud");
        project_create_in(&store, "news").expect("create project");
        let duplicate_project =
            project_create_in(&store, "news").expect_err("create must not reuse a project");
        assert!(duplicate_project.to_string().contains("already exists"));

        let mut scene = new_scene("lower-third", "Lower Third");
        let created = scene_create_in(&store, "news", &scene).expect("create scene");
        assert_eq!(created.project, "news");
        assert_eq!(created.scenes.len(), 1);
        assert_eq!(created.scenes[0].scene_id, "lower-third");

        let duplicate = scene_create_in(&store, "news", &scene)
            .expect_err("create must not overwrite an existing scene");
        assert!(duplicate.to_string().contains("already exists"));

        scene.name = "Lower Third Updated".into();
        let updated = scene_update_in(&store, "news", &scene).expect("update scene");
        assert_eq!(updated.scenes[0].name, "Lower Third Updated");
        assert_eq!(
            store
                .read_scene("news", "lower-third")
                .expect("read updated scene")
                .name,
            "Lower Third Updated"
        );

        let missing = scene_update_in(&store, "news", &new_scene("missing", "Missing"))
            .expect_err("update must not create a missing scene");
        assert!(missing.to_string().contains("create it first"));

        let deleted =
            scene_delete_in(&store, "news", "lower-third").expect("delete existing scene");
        assert!(deleted.scenes.is_empty());
        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn scene_catalog_names_unreadable_files_and_confines_ids() {
        let (root, store) = scratch_projects("scene-catalog");
        store.create_project("news").expect("create project");
        std::fs::write(root.join("news/scenes/bad.json"), b"{ not-json")
            .expect("write corrupt scene");

        let catalog = scene_catalog_from(&store, "news").expect("list scene catalog");
        assert_eq!(catalog.scenes.len(), 1);
        assert_eq!(catalog.scenes[0].scene_id, "bad");
        assert!(
            catalog.scenes[0]
                .unavailable_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("unreadable"))
        );

        let traversal = scene_create_in(&store, "news", &new_scene("../escape", "Escape"))
            .expect_err("scene ids are one filename, never a path");
        assert!(traversal.to_string().contains("not one canonical filename"));
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}

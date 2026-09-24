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
use std::collections::BTreeMap;
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
use gx_contracts::control::{
    apply_control_values, declare_control_field, fillable_properties, remove_control_field, ControlField,
    ControlFieldKind, ControlValue, TakePage,
};
use gx_contracts::text_style::{apply_text_style, TextStyle};
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
    /// A take-page fill violated the shared control contract.
    ControlRefused { detail: String, cause: Refusal },
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
            Self::ControlRefused { detail, .. } => write!(f, "take-page control refused: {detail}"),
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
        controls: Vec::new(),
        text_styles: Vec::new(),
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

fn control_refused(cause: Refusal) -> EditorError {
    EditorError::ControlRefused {
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

/// Set or move a named timeline phase (11.25). Every rule — span validity,
/// range, overlap — lives in `gx_contracts::phases`; the shell only carries
/// the refusal out.
pub fn phase_set(
    mut scene: SceneDocument,
    phase: gx_contracts::phases::TimelinePhase,
) -> Result<SceneDocument, EditorError> {
    gx_contracts::phases::set_phase(&mut scene.timeline, phase).map_err(animation_refused)?;
    Ok(scene)
}

pub fn phase_remove(
    mut scene: SceneDocument,
    address: &str,
) -> Result<SceneDocument, EditorError> {
    gx_contracts::phases::remove_phase(&mut scene.timeline, address)
        .map_err(animation_refused)?;
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

/// Resolve the project's confirmed design system when this document belongs to
/// a project. An unsaved scene has none; token-backed styles then refuse in
/// the shared resolver rather than receiving a made-up brand pack.
fn current_design_system(
    project: Option<&str>,
) -> Result<Option<gx_contracts::design_system::DesignSystem>, EditorError> {
    let Some(project) = project else {
        return Ok(None);
    };
    let design_system = projects()?.design_system(project).map_err(project_failed)?;
    design_system
        .current_version()
        .map_err(project_failed)?
        .map(|version| design_system.load(version).map_err(project_failed))
        .transpose()
}

/// Apply a named style after loading only the active project's confirmed
/// token set. The shared contract validates and writes atomically.
pub fn text_style_apply(
    mut scene: SceneDocument,
    object_id: &str,
    style_id: &str,
    project: Option<&str>,
) -> Result<SceneDocument, EditorError> {
    let tokens = current_design_system(project)?;
    apply_text_style(&mut scene, object_id, style_id, tokens.as_ref()).map_err(animation_refused)?;
    Ok(scene)
}

/// Store a newly authored style in the document. Applying remains the shared
/// contract operation because that is where design tokens resolve.
pub fn text_style_save(mut scene: SceneDocument, style: TextStyle) -> SceneDocument {
    scene.text_styles.push(style);
    scene
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

/// A take page as the project manager lists it.
///
/// The template id is carried visibly so an operator cannot reopen values
/// against a different scene by accident.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTakePage {
    pub page_id: String,
    pub name: String,
    pub scene_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// The saved take-page instances for one project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTakePageCatalog {
    pub project: String,
    pub pages: Vec<ListedTakePage>,
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

/// Preview operator values through Rust's one control-value application.
///
/// The returned document is a filled copy. The template passed in stays
/// untouched, so the browser cannot accidentally persist operator data into
/// the reusable scene.
pub fn take_page_preview(
    scene: &SceneDocument,
    values: &BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    apply_control_values(scene, values).map_err(control_refused)
}

fn take_page_catalog_from(
    store: &Projects,
    project: &str,
) -> Result<ProjectTakePageCatalog, EditorError> {
    require_component(project, "project")?;
    let ids = store.list_take_pages(project).map_err(project_failed)?;
    let mut pages = Vec::with_capacity(ids.len());
    for page_id in ids {
        match store.read_take_page(project, &page_id) {
            Ok(page) => pages.push(ListedTakePage {
                page_id,
                name: page.name,
                scene_id: page.scene_id,
                unavailable_reason: None,
            }),
            Err(error) => pages.push(ListedTakePage {
                name: page_id.clone(),
                scene_id: String::new(),
                page_id,
                unavailable_reason: Some(format!(
                    "take-page file is unreadable: {}",
                    describe_project_error(&error)
                )),
            }),
        }
    }
    Ok(ProjectTakePageCatalog {
        project: project.to_owned(),
        pages,
    })
}

/// List saved template instances in a project.
pub fn take_page_list(project: &str) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_catalog_from(&projects()?, project)
}

/// Save a filled template instance without rewriting its scene.
fn take_page_save_in(
    store: &Projects,
    project: &str,
    page: &TakePage,
) -> Result<ProjectTakePageCatalog, EditorError> {
    require_component(project, "project")?;
    require_component(&page.page_id, "take page id")?;
    require_component(&page.scene_id, "template scene id")?;
    if !scene_exists(store, project, &page.scene_id)? {
        return Err(project_condition(format!(
            "template scene id {:?} does not exist in project {:?}; create it first",
            page.scene_id, project
        )));
    }
    store.write_take_page(project, page).map_err(project_failed)?;
    take_page_catalog_from(store, project)
}

pub fn take_page_save(
    project: &str,
    page: &TakePage,
) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_save_in(&projects()?, project, page)
}

/// Reopen one saved instance exactly as its operator values were saved.
fn take_page_read_from(
    store: &Projects,
    project: &str,
    page_id: &str,
) -> Result<TakePage, EditorError> {
    require_component(project, "project")?;
    require_component(page_id, "take page id")?;
    store.read_take_page(project, page_id).map_err(project_failed)
}

pub fn take_page_read(project: &str, page_id: &str) -> Result<TakePage, EditorError> {
    take_page_read_from(&projects()?, project, page_id)
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
fn cmd_text_style_save(scene: SceneDocument, style: TextStyle) -> SceneDocument {
    text_style_save(scene, style)
}

#[tauri::command]
fn cmd_text_style_apply(
    scene: SceneDocument,
    object_id: String,
    style_id: String,
    project: Option<String>,
) -> Result<SceneDocument, EditorError> {
    text_style_apply(scene, &object_id, &style_id, project.as_deref())
}

/// Read the one Rust-owned property vocabulary an object kind may expose to an
/// operator. The web layer consumes this rather than maintaining a second list.
#[tauri::command]
fn cmd_control_properties(kind: String) -> Vec<(String, ControlFieldKind)> {
    fillable_properties(&kind)
        .iter()
        .map(|(property, kind)| ((*property).to_owned(), *kind))
        .collect()
}

/// Declare one operator-facing field after the shared contract validates it.
#[tauri::command]
fn cmd_control_declare(
    mut scene: SceneDocument,
    field: ControlField,
) -> Result<SceneDocument, EditorError> {
    declare_control_field(&mut scene, field).map_err(control_refused)?;
    Ok(scene)
}

/// Remove one declared operator-facing field by its stable id.
#[tauri::command]
fn cmd_control_remove(
    mut scene: SceneDocument,
    field_id: String,
) -> Result<SceneDocument, EditorError> {
    remove_control_field(&mut scene, &field_id).map_err(control_refused)?;
    Ok(scene)
}

/// Replace a field's label or default without creating a parallel update rule.
/// The shared remove/declaration operations validate a copy first, so refusal
/// returns the caller's original document unchanged.
#[tauri::command]
fn cmd_control_replace(
    scene: SceneDocument,
    field: ControlField,
) -> Result<SceneDocument, EditorError> {
    let mut updated = scene.clone();
    remove_control_field(&mut updated, &field.field_id).map_err(control_refused)?;
    declare_control_field(&mut updated, field).map_err(control_refused)?;
    Ok(updated)
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
fn cmd_phase_set(
    scene: SceneDocument,
    phase: gx_contracts::phases::TimelinePhase,
) -> Result<SceneDocument, EditorError> {
    phase_set(scene, phase)
}

#[tauri::command]
fn cmd_phase_remove(
    scene: SceneDocument,
    address: String,
) -> Result<SceneDocument, EditorError> {
    phase_remove(scene, &address)
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
fn cmd_take_page_preview(
    scene: SceneDocument,
    values: BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, EditorError> {
    take_page_preview(&scene, &values)
}

#[tauri::command]
fn cmd_take_page_list(project: String) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_list(&project)
}

#[tauri::command]
fn cmd_take_page_save(
    project: String,
    page: TakePage,
) -> Result<ProjectTakePageCatalog, EditorError> {
    take_page_save(&project, &page)
}

#[tauri::command]
fn cmd_take_page_read(project: String, page_id: String) -> Result<TakePage, EditorError> {
    take_page_read(&project, &page_id)
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
            cmd_text_style_save,
            cmd_text_style_apply,
            cmd_publish,
            cmd_animation_surface,
            cmd_default_endpoint,
            cmd_keyframe_create,
            cmd_keyframe_update,
            cmd_keyframe_move,
            cmd_keyframe_remove,
            cmd_phase_set,
            cmd_phase_remove,
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
            cmd_control_properties,
            cmd_control_declare,
            cmd_control_remove,
            cmd_control_replace,
            cmd_take_page_preview,
            cmd_take_page_list,
            cmd_take_page_save,
            cmd_take_page_read,
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
    fn phase_commands_carry_the_contract_refusal_rather_than_flattening_it() {
        use gx_contracts::phases::{PhaseKind, TimelinePhase};

        let span = |kind: PhaseKind, start_frame: u64, end_frame: u64| TimelinePhase {
            kind,
            name: None,
            start_frame,
            end_frame,
        };
        let mut scene = new_scene("phased", "Phased");
        scene.timeline.duration_frames = 100;

        let scene = phase_set(scene, span(PhaseKind::In, 0, 50)).expect("in lands");
        // Adjacency is legal: half-open spans share no frame.
        let scene = phase_set(scene, span(PhaseKind::Hold, 50, 80)).expect("adjacent hold lands");
        assert_eq!(scene.timeline.phases.len(), 2);

        let overlap = phase_set(scene.clone(), span(PhaseKind::Out, 49, 90))
            .expect_err("a span claiming frame 49 twice is refused");
        assert!(matches!(
            overlap,
            EditorError::AnimationRefused {
                cause: Refusal::TimelinePhaseOverlap { .. },
                ..
            }
        ));

        let absent = phase_remove(scene.clone(), "out")
            .expect_err("removing a phase that is not there is reported");
        assert!(matches!(
            absent,
            EditorError::AnimationRefused {
                cause: Refusal::TimelinePhaseUnknown { .. },
                ..
            }
        ));

        let scene = phase_remove(scene, "in").expect("in is removed");
        assert_eq!(scene.timeline.phases.len(), 1);
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

    /// The bindings of every object, by id, as the closed reader returns them.
    fn bindings_by_object(
        scene: &SceneDocument,
    ) -> BTreeMap<String, Option<serde_json::Map<String, serde_json::Value>>> {
        scene
            .objects
            .iter()
            .map(|object| (object.base().id.clone(), object.base().bindings.clone()))
            .collect()
    }

    fn binding_map(pairs: &[(&str, &str)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .map(|(property, path)| ((*property).to_owned(), serde_json::json!(path)))
            .collect()
    }

    /// The saved file as bytes on disk, parsed only as JSON — never through
    /// the schema, which would hide an explicit `null` or `{}` behind `None`.
    fn raw_scene_file(root: &std::path::Path, project: &str, scene_id: &str) -> serde_json::Value {
        let bytes = std::fs::read(root.join(project).join("scenes").join(format!("{scene_id}.json")))
            .expect("the saved scene file exists");
        serde_json::from_slice(&bytes).expect("the saved scene file is JSON")
    }

    fn bound_scene() -> SceneDocument {
        use gx_contracts::scene::{
            AssetKind, AssetLibraryItem, ImageObject, ObjectBase, RectObject, SceneObject,
        };

        let mut scene = new_scene("scorebug", "Scorebug");
        // A non-dyadic float: 48/255 has no exact binary representation, so a
        // reader that is merely ULP-accurate (rule 25) returns a different
        // number and the equality below fails.
        scene.data_context = serde_json::json!({
            "match": {
                "home": { "x": 120.5, "name": "Rovers", "logo": "home-logo" },
                "away": { "x": 1480.25, "name": "United" },
                "alpha": 48.0_f64 / 255.0,
            },
            "flags": [true, false],
            "live": true,
        })
        .as_object()
        .expect("the data context is an object")
        .clone();
        scene.assets.push(AssetLibraryItem {
            asset_id: "home-logo".into(),
            name: "Home logo".into(),
            kind: AssetKind::Image,
            path: "assets/home-logo.png".into(),
            checksum: None,
            mime_type: Some("image/png".into()),
            size_bytes: None,
            status: None,
        });

        let mut bar = ObjectBase::new("bar", "Bar");
        bar.width = 640.0;
        bar.height = 72.0;
        bar.bindings = Some(binding_map(&[("x", "match.home.x"), ("visible", "flags.0")]));
        scene.objects.push(SceneObject::Rect(RectObject { base: bar, radius: 4.0 }));

        let mut logo = ObjectBase::new("logo", "Logo");
        logo.width = 64.0;
        logo.height = 64.0;
        logo.bindings = Some(binding_map(&[("assetId", "match.home.logo")]));
        scene.objects.push(SceneObject::Image(ImageObject {
            base: logo,
            asset_id: "home-logo".into(),
            fit: Default::default(),
        }));
        scene
    }

    #[test]
    fn bindings_and_the_data_context_survive_save_and_reopen() {
        // 11.19: "preserve bindings through save/reopen". Every reopen below
        // goes through `store.read_scene`, which is `parse_scene_document` —
        // the closed reader the engine uses — not a plain serde read.
        let (root, store) = scratch_projects("binding-round-trip");
        project_create_in(&store, "news").expect("create project");

        // 1–2. Create, reopen, and compare the whole document.
        let mut scene = bound_scene();
        scene_create_in(&store, "news", &scene).expect("create bound scene");
        let reopened = store.read_scene("news", "scorebug").expect("reopen bound scene");
        assert_eq!(reopened, scene, "the whole bound document survives save/reopen");
        assert_eq!(
            bindings_by_object(&reopened),
            BTreeMap::from([
                (
                    "bar".to_owned(),
                    Some(binding_map(&[("x", "match.home.x"), ("visible", "flags.0")])),
                ),
                ("logo".to_owned(), Some(binding_map(&[("assetId", "match.home.logo")]))),
            ]),
            "each object's bindings map comes back exact, no more and no fewer"
        );
        let alpha = reopened.data_context["match"]["alpha"]
            .as_f64()
            .expect("the float stays a number");
        assert_eq!(
            alpha.to_bits(),
            (48.0_f64 / 255.0).to_bits(),
            "a non-dyadic data-context float reopens bit for bit"
        );
        assert_eq!(reopened.data_context["flags"], serde_json::json!([true, false]));
        assert_eq!(reopened.data_context["live"], serde_json::json!(true));
        assert_eq!(reopened.data_context["match"]["home"]["name"], "Rovers");

        // 3. Re-point one binding and remove another; update; reopen.
        let bar = scene.objects[0].base_mut();
        let bindings = bar.bindings.as_mut().expect("bar is bound");
        bindings.insert("x".into(), serde_json::json!("match.away.x"));
        bindings.remove("visible");
        scene_update_in(&store, "news", &scene).expect("update re-bound scene");
        let reopened = store.read_scene("news", "scorebug").expect("reopen re-bound scene");
        assert_eq!(reopened, scene, "an edited binding set survives save/reopen");
        assert_eq!(
            reopened.objects[0].base().bindings,
            Some(binding_map(&[("x", "match.away.x")])),
            "the re-pointed path is saved and the removed binding stays removed"
        );

        // 4. Remove every binding. Absent means absent: not `null`, not `{}`.
        for object in &mut scene.objects {
            object.base_mut().bindings = None;
        }
        scene_update_in(&store, "news", &scene).expect("update unbound scene");
        let reopened = store.read_scene("news", "scorebug").expect("reopen unbound scene");
        assert_eq!(reopened, scene);
        for object in &reopened.objects {
            assert_eq!(object.base().bindings, None, "{} has no bindings", object.base().id);
        }
        let raw = raw_scene_file(&root, "news", "scorebug");
        for object in raw["objects"].as_array().expect("objects on disk") {
            assert!(
                object.get("bindings").is_none(),
                "an unbound object carries no bindings key on disk: {object}"
            );
        }

        // 5. The shape `applyBindingEdit` hands `cmd_scene_update` over Tauri
        // IPC: JSON.stringify drops `bindings: undefined`, so an object whose
        // last binding was removed has no key, and a bound one has a plain
        // property -> path object. Deserialised with plain serde, as Tauri does.
        let from_ipc: SceneDocument = serde_json::from_value(serde_json::json!({
            "id": "scorebug",
            "name": "Scorebug",
            "version": 1,
            "canvas": { "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 } },
            "timeline": { "durationFrames": 0, "channels": [], "phases": [] },
            "dataContext": {
                "match": {
                    "home": { "x": 120.5, "name": "Rovers", "logo": "home-logo" },
                    "away": { "x": 1480.25, "name": "United" },
                    "alpha": 0.18823529411764706
                },
                "flags": [true, false],
                "live": true
            },
            "assets": [{
                "assetId": "home-logo",
                "name": "Home logo",
                "kind": "image",
                "path": "assets/home-logo.png",
                "mimeType": "image/png"
            }],
            "fonts": [],
            "materials": [],
            "controls": [],
            "textStyles": [],
            "objects": [
                {
                    "type": "rect", "id": "bar", "name": "Bar", "visible": true, "locked": false,
                    "opacity": 1, "x": 0, "y": 0, "zDepth": 0, "zIndex": 0, "layerId": "",
                    "width": 640, "height": 72, "rotation": 0, "rotationX": 0, "rotationY": 0,
                    "scaleX": 1, "scaleY": 1, "scaleZ": 1, "strokeWidth": 0, "radius": 4,
                    "bindings": { "x": "match.away.x", "visible": "flags.1" }
                },
                {
                    "type": "image", "id": "logo", "name": "Logo", "visible": true, "locked": false,
                    "opacity": 1, "x": 0, "y": 0, "zDepth": 0, "zIndex": 0, "layerId": "",
                    "width": 64, "height": 64, "rotation": 0, "rotationX": 0, "rotationY": 0,
                    "scaleX": 1, "scaleY": 1, "scaleZ": 1, "strokeWidth": 0,
                    "assetId": "home-logo", "fit": "contain"
                }
            ]
        }))
        .expect("the IPC shape deserialises as a SceneDocument");
        assert_eq!(
            from_ipc.data_context["match"]["alpha"].as_f64().map(f64::to_bits),
            Some((48.0_f64 / 255.0).to_bits()),
            "the shortest round-trip literal JS prints for 48/255 parses to the same bits"
        );
        scene_update_in(&store, "news", &from_ipc).expect("update from the IPC shape");
        let reopened = store.read_scene("news", "scorebug").expect("reopen IPC-saved scene");
        assert_eq!(reopened, from_ipc, "the IPC document survives save/reopen whole");
        assert_eq!(
            bindings_by_object(&reopened),
            BTreeMap::from([
                (
                    "bar".to_owned(),
                    Some(binding_map(&[("x", "match.away.x"), ("visible", "flags.1")])),
                ),
                ("logo".to_owned(), None),
            ])
        );
        let raw = raw_scene_file(&root, "news", "scorebug");
        assert_eq!(
            raw["objects"][0]["bindings"],
            serde_json::json!({ "x": "match.away.x", "visible": "flags.1" })
        );
        assert!(raw["objects"][1].get("bindings").is_none());
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

    fn take_page_template() -> SceneDocument {
        let created =
            object_create(new_scene("lower-third", "Lower Third"), "rect", "Background")
                .expect("create rect object");
        let mut template = created.scene;
        declare_control_field(
            &mut template,
            ControlField {
                field_id: "offset".into(),
                label: "Horizontal offset".into(),
                object_id: created.object_id,
                property: "x".into(),
                kind: ControlFieldKind::Number,
                default: Some(ControlValue::Number(0.0)),
            },
        )
        .expect("declare numeric control");
        template
    }

    #[test]
    fn take_page_preview_refuses_wrong_values_without_mutating_the_template() {
        let template = take_page_template();
        let original = template.clone();
        let error = take_page_preview(
            &template,
            &BTreeMap::from([("offset".into(), ControlValue::Text("not a number".into()))]),
        )
        .expect_err("text must not be coerced into a numeric control");

        assert!(
            error.to_string().contains("offset requires number, not text"),
            "the operator needs Rust's named type mismatch: {error}"
        );
        assert_eq!(template, original, "a refused fill must leave the template intact");

        let filled = take_page_preview(
            &template,
            &BTreeMap::from([("offset".into(), ControlValue::Number(42.0))]),
        )
        .expect("a matching value fills a copy");
        assert_ne!(filled, template, "the returned preview is the filled copy");
        assert_eq!(template, original, "even a successful preview cannot edit the template");
    }

    #[test]
    fn saved_take_page_reopens_with_its_values_and_its_template_unchanged() {
        let (root, store) = scratch_projects("take-page");
        store.create_project("news").expect("create project");
        let template = take_page_template();
        scene_create_in(&store, "news", &template).expect("save template");
        let page = TakePage {
            page_id: "headlines-at-six".into(),
            name: "Headlines at six".into(),
            scene_id: template.id.clone(),
            values: BTreeMap::from([("offset".into(), ControlValue::Number(6.0))]),
        };

        let catalog = take_page_save_in(&store, "news", &page).expect("save take page");
        assert_eq!(catalog.pages.len(), 1);
        assert_eq!(catalog.pages[0].page_id, page.page_id);
        assert_eq!(
            take_page_read_from(&store, "news", &page.page_id).expect("reopen saved page"),
            page
        );
        assert_eq!(
            store.read_scene("news", &template.id).expect("read template"),
            template,
            "saving a page must not overwrite its template"
        );
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}

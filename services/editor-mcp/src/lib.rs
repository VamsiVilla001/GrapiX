//! The Editor's MCP tool bodies (build plan 8.3, 8.4, 8.8).
//!
//! Each handler is a thin seam between a JSON argument and a function that
//! already exists in `gx_editor` or `gx_contracts`. The value of that thinness
//! is not laziness: the rules being enforced live in those crates, tested
//! there, and a handler that reimplemented them here would be a second copy
//! of the same rule waiting to disagree (invariant 27). What a handler adds
//! is parsing — turning the untyped wire value into the typed call — and
//! nothing more.
//!
//! The scope gate is upstream. By the time any of these run, the transport has
//! already established the caller holds `Scope::Author`; none of these check
//! again, because a handler that could be reached unauthorised and a handler
//! that re-checks are the same mistake at different depths.

#![forbid(unsafe_code)]

use gx_contracts::scene::{resolve_hierarchy, SceneDocument};
use gx_contracts::validate::preflight;
use gx_contracts::Refusal;
use gx_editor::Projects;
use gx_mcp_server::ToolHandler;
use serde::Deserialize;

/// Parse a tool argument into the type it names.
///
/// The wire is untyped, so this is where a malformed argument becomes a named
/// refusal rather than a transport error or a panic. A wrong-shaped argument
/// is `SceneParseFailed`-adjacent — it failed to be the thing it claimed to
/// be — and the refusal carries the detail rather than a bare "invalid".
fn parse<T: for<'de> Deserialize<'de>>(args: serde_json::Value) -> Result<T, Refusal> {
    serde_json::from_value(args).map_err(|error| Refusal::SceneParseFailed {
        detail: format!("arguments do not match the tool's input schema: {error}"),
    })
}

/// A `project` handle held by the handlers.
pub struct EditorTools {
    pub projects: Projects,
}

// --- project (8.3) ---------------------------------------------------------

/// `project.list`: the projects this store holds.
pub struct ProjectList(pub Projects);

impl ToolHandler for ProjectList {
    fn handle(&self, _args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let names = self.0.list_projects().map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })?;
        Ok(serde_json::json!({ "projects": names }))
    }
}

/// `project.create`: bring a project into being.
pub struct ProjectCreate(pub Projects);

#[derive(Deserialize)]
struct ProjectCreateArgs {
    name: String,
}

impl ToolHandler for ProjectCreate {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProjectCreateArgs = parse(args)?;
        // Refusing an existing project rather than succeeding again is the
        // same rule as 7.1's: a second create that "succeeded" would tell the
        // caller nothing about the project that was already there.
        if self.0.exists(&args.name) {
            return Err(Refusal::NotImplemented {
                what: format!("project {} already exists", args.name),
            });
        }
        self.0
            .create_project(&args.name)
            .map_err(|error| Refusal::TransportFailed {
                detail: error.to_string(),
            })?;
        Ok(serde_json::json!({ "project": args.name }))
    }
}

// --- scenes (8.3) ----------------------------------------------------------

/// `scenes.get`: one scene document, whole.
///
/// The whole document rather than a per-field API is how "full property
/// surface reachable" is made true: a per-field getter covers whatever fields
/// someone remembered, and a document covers all of them.
pub struct SceneGet(pub Projects);

#[derive(Deserialize)]
struct SceneRef {
    project: String,
    scene_id: String,
}

impl ToolHandler for SceneGet {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;
        serde_json::to_value(scene).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

/// `scenes.create`: write a scene into a project.
pub struct SceneCreate(pub Projects);

#[derive(Deserialize)]
struct SceneCreateArgs {
    project: String,
    scene: SceneDocument,
}

impl ToolHandler for SceneCreate {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneCreateArgs = parse(args)?;
        self.0
            .write_scene(&args.project, &args.scene)
            .map_err(Refusal::from)?;
        Ok(serde_json::json!({ "sceneId": args.scene.id }))
    }
}

/// `scenes.list`: the scenes in a project.
pub struct SceneList(pub Projects);

impl ToolHandler for SceneList {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        #[derive(Deserialize)]
        struct Args {
            project: String,
        }
        let args: Args = parse(args)?;
        let scenes = self
            .0
            .list_scenes(&args.project)
            .map_err(Refusal::from)?;
        Ok(serde_json::json!({ "scenes": scenes }))
    }
}

// --- objects (8.3) ----------------------------------------------------------

/// `objects.hierarchy`: the resolved transforms and refused edges.
///
/// The hierarchy is resolved by the same function the engine uses, so an
/// agent reading it sees the composition the renderer will produce rather
/// than a parallel interpretation (invariant 27).
pub struct ObjectsHierarchy(pub Projects);

impl ToolHandler for ObjectsHierarchy {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;
        let resolved = resolve_hierarchy(&scene.objects);
        serde_json::to_value(resolved).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

// --- validate (8.8) ----------------------------------------------------------

/// `validate.preflight`: the structured refusals, as JSON.
///
/// The result is the `PreflightReport` serialised directly. Re-shaping it here
/// would be a second contract for the same answer — the refusal envelope
/// already carries code, field, given, allowed and severity, and an agent
/// consuming it should not have to learn two shapes for one refusal.
pub struct ValidatePreflight(pub Projects);

impl ToolHandler for ValidatePreflight {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;
        // At authoring time the assets have not necessarily shipped yet, so
        // presence is not checked — the engine will refuse those at take,
        // and demanding them here would train an author to ignore preflight.
        let report = preflight(
            &scene,
            &gx_contracts::material::MaterialSupport::fixed_function(),
            &std::collections::HashSet::new(),
            false,
        );
        serde_json::to_value(report.refusals).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::{ObjectBase, RectObject, SceneCanvas, SceneObject, SceneTimeline};
    use gx_contracts::{RationalRate, Revision};

    fn scratch(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gx-editor-mcp-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("scratch directory");
        path
    }

    fn scene(id: &str) -> SceneDocument {
        SceneDocument {
            id: id.into(),
            name: id.into(),
            version: 1,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline { duration_frames: 1 },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            objects: Vec::new(),
        }
    }

    #[test]
    fn a_scene_create_then_get_round_trips_the_whole_document() {
        // 8.3's done-when: the full property surface is reachable. The test
        // is that the whole document comes back unchanged — not a sample of
        // fields, the document.
        let root = scratch("round-trip");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();

        let mut authored = scene("lower-third");
        let mut base = ObjectBase::new("bar", "Bar");
        base.x = 18.5;
        base.rotation = 12.25;
        base.opacity = 0.85;
        base.locked = true;
        authored.objects.push(SceneObject::Rect(RectObject { base, radius: 4.0 }));

        SceneCreate(projects.clone())
            .handle(serde_json::json!({
                "project": "news",
                "scene": serde_json::to_value(&authored).unwrap(),
            }))
            .expect("the scene writes");
        let read_back = SceneGet(projects)
            .handle(serde_json::json!({ "project": "news", "scene_id": "lower-third" }))
            .expect("and reads back");
        let read_back: SceneDocument = serde_json::from_value(read_back).unwrap();

        assert_eq!(read_back, authored, "every authored field survives the round trip");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_scene_create_into_a_missing_project_is_refused_by_name() {
        // The MCP surface inherits 7.1's rule: no write conjures a project.
        let root = scratch("missing-project");
        let projects = Projects::at_root(&root);

        let refusal = SceneCreate(projects)
            .handle(serde_json::json!({
                "project": "nope",
                "scene": serde_json::to_value(scene("s")).unwrap(),
            }))
            .expect_err("a write into a missing project refuses");
        assert!(matches!(refusal, Refusal::ProjectNotFound { .. }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preflight_returns_structured_refusals_not_prose() {
        // 8.8's done-when: machine-parseable. The test is that the answer
        // deserialises back into StructuredRefusal and its parts are readable.
        let root = scratch("preflight");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();

        let mut broken = scene("broken");
        broken.canvas.width = 0;
        projects.write_scene("news", &broken).unwrap();

        let value = ValidatePreflight(projects)
            .handle(serde_json::json!({ "project": "news", "scene_id": "broken" }))
            .expect("preflight answers");
        let refusals: Vec<gx_contracts::StructuredRefusal> =
            serde_json::from_value(value).expect("the answer is machine-parseable");

        let refusal = refusals
            .iter()
            .find(|r| matches!(r.code, Refusal::SceneParseFailed { .. }))
            .expect("the canvas fault is reported");
        assert_eq!(refusal.field.as_deref(), Some("canvas"));
        assert_eq!(refusal.severity, gx_contracts::RefusalSeverity::Error);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_arguments_refuse_by_name_rather_than_panicking() {
        let root = scratch("bad-args");
        let projects = Projects::at_root(&root);
        let refusal = SceneGet(projects)
            .handle(serde_json::json!({ "project": 42 }))
            .expect_err("a wrong-shaped argument refuses");
        assert!(matches!(refusal, Refusal::SceneParseFailed { .. }));
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! The Editor's MCP tool bodies (build plan 8.3, 8.4, 8.8, 11.36).
//!
//! Each handler is a thin seam between a JSON argument and a function that
//! already exists in `gx_editor` or `gx_contracts`. The value of that thinness
//! is not laziness: the rules being enforced live in those crates, tested
//! there, and a handler that reimplemented them here would be a second copy
//! of the same rule waiting to disagree (invariant 27). What a handler adds
//! is parsing — turning the untyped wire value into the typed call — and
//! nothing more.
//!
//! **Every write is one generic handler.** [`CommandTool`] parses its tool's
//! `EditorCommand` payload strictly and runs it through the same
//! `Workspace::execute` the Tauri shell uses (11.36, invariant 60). No write
//! here accepts a client-supplied scene document, and there is no second
//! write path for one to reach.
//!
//! The scope gate is upstream. By the time any of these run, the transport has
//! already established the caller holds the descriptor's scope; none of these
//! check again, because a handler that could be reached unauthorised and a
//! handler that re-checks are the same mistake at different depths.

#![forbid(unsafe_code)]

use std::marker::PhantomData;

use gx_contracts::command::{parse_strict, EditorCommand};
use gx_contracts::mcp::{ProjectRef as ProjectRefArgs, SceneRef};
use gx_contracts::scene::resolve_hierarchy;
use gx_contracts::validate::preflight;
use gx_contracts::Refusal;
use gx_editor::{CommandError, Projects, Workspace};
use gx_mcp_server::ToolHandler;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Parse a read tool's argument into the type it names.
///
/// The wire is untyped, so this is where a malformed argument becomes a named
/// refusal rather than a transport error or a panic. A wrong-shaped argument
/// is `SceneParseFailed`-adjacent — it failed to be the thing it claimed to
/// be — and the refusal carries the detail rather than a bare "invalid".
fn parse<T: DeserializeOwned + Serialize>(args: serde_json::Value) -> Result<T, Refusal> {
    parse_strict(args).map_err(|error| Refusal::SceneParseFailed {
        detail: format!("arguments do not match the tool's input schema: {error}"),
    })
}

fn to_value(value: impl Serialize) -> Result<serde_json::Value, Refusal> {
    serde_json::to_value(value).map_err(|error| Refusal::TransportFailed {
        detail: error.to_string(),
    })
}

/// A `project` handle held by the handlers.
pub struct EditorTools {
    pub projects: Projects,
}

/// The shipped author-only surface. It has no Program-control connection or
/// operator scopes. Every registered read and write uses the same store.
pub fn server(projects: Projects) -> gx_mcp_server::Server {
    use gx_contracts::command::{ConfirmDesignSystem, CreateProject, CreateScene, DeleteScene, EditScene};
    let mut server = gx_mcp_server::Server::new(vec![gx_contracts::auth::Scope::Author]);
    server.register("project.list", Box::new(ProjectList(projects.clone())));
    server.register("project.create", Box::new(CommandTool::<CreateProject>::new(projects.clone())));
    server.register("scenes.get", Box::new(SceneGet(projects.clone())));
    server.register("scenes.list", Box::new(SceneList(projects.clone())));
    server.register("scenes.create", Box::new(CommandTool::<CreateScene>::new(projects.clone())));
    server.register("scenes.delete", Box::new(CommandTool::<DeleteScene>::new(projects.clone())));
    server.register("scenes.edit", Box::new(CommandTool::<EditScene>::new(projects.clone())));
    server.register("objects.hierarchy", Box::new(ObjectsHierarchy(projects.clone())));
    server.register("materials.list", Box::new(MaterialsUsage(projects.clone())));
    server.register("bindings.schema", Box::new(BindingsSchema(projects.clone())));
    server.register("designsystem.get", Box::new(DesignSystemGet(projects.clone())));
    server.register("designsystem.list_versions", Box::new(DesignSystemListVersions(projects.clone())));
    server.register("designsystem.import", Box::new(DesignSystemImportTool(projects.clone())));
    server.register("designsystem.commit", Box::new(CommandTool::<ConfirmDesignSystem>::new(projects.clone())));
    server.register("validate.preflight", Box::new(ValidatePreflight {
        projects,
        material_support: gx_contracts::material::MaterialSupport::none(),
    }));
    server
}

// --- writes (11.36) ---------------------------------------------------------

/// The one write handler: `project.create`, `scenes.create`, `scenes.delete`,
/// `scenes.edit` and `designsystem.commit` are each this, over their own
/// payload type `P`.
///
/// `P` is the tool's descriptor input, so the shape an agent reads off the
/// capability surface is the shape parsed here (invariant 22). Parsing is
/// strict: a key the payload does not have — a smuggled `scene` document, a
/// hand-authored `keyframes` list on a preset — refuses by its path rather
/// than being dropped while the caller believes it was honoured.
///
/// Each call runs on a fresh workspace over the store, so it addresses stored
/// scenes only; a `Session` target refuses `SessionUnknown`.
pub struct CommandTool<P> {
    projects: Projects,
    payload: PhantomData<fn() -> P>,
}

impl<P> CommandTool<P> {
    pub fn new(projects: Projects) -> Self {
        Self {
            projects,
            payload: PhantomData,
        }
    }
}

impl<P> ToolHandler for CommandTool<P>
where
    P: DeserializeOwned + Serialize + Into<EditorCommand>,
{
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let command = parse_strict::<P>(args)?.into();
        let outcome = Workspace::new(Some(self.projects.clone()))
            .execute(command)
            .map_err(|error| match error {
                CommandError::Refused(refusal) => refusal,
                CommandError::Store(error) => Refusal::from(error),
            })?;
        to_value(outcome)
    }
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

// --- scenes (8.3) ----------------------------------------------------------

/// `scenes.get`: one scene document, whole.
///
/// The whole document rather than a per-field API is how "full property
/// surface reachable" is made true: a per-field getter covers whatever fields
/// someone remembered, and a document covers all of them. The document flows
/// out only; no write accepts one back.
pub struct SceneGet(pub Projects);

impl ToolHandler for SceneGet {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        to_value(self.0.read_scene(&args.project, &args.scene_id).map_err(Refusal::from)?)
    }
}

/// `scenes.list`: the scenes in a project.
pub struct SceneList(pub Projects);

impl ToolHandler for SceneList {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProjectRefArgs = parse(args)?;
        let scenes = self.0.list_scenes(&args.project).map_err(Refusal::from)?;
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
        let scene = self.0.read_scene(&args.project, &args.scene_id).map_err(Refusal::from)?;
        to_value(resolve_hierarchy(&scene.objects))
    }
}

// --- validate (8.8) ----------------------------------------------------------

/// `validate.preflight`: the structured refusals, as JSON.
///
/// The result is the `PreflightReport` serialised directly. Re-shaping it here
/// would be a second contract for the same answer — the refusal envelope
/// already carries code, field, given, allowed and severity, and an agent
/// consuming it should not have to learn two shapes for one refusal.
pub struct ValidatePreflight {
    pub projects: Projects,
    /// Supplied by the host from the peer's capability exchange. The Editor
    /// has no Program control client and never invents a support declaration.
    pub material_support: gx_contracts::material::MaterialSupport,
}

impl ToolHandler for ValidatePreflight {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self.projects.read_scene(&args.project, &args.scene_id).map_err(Refusal::from)?;
        // At authoring time the assets have not necessarily shipped yet, so
        // presence is not checked — the engine will refuse those at take,
        // and demanding them here would train an author to ignore preflight.
        let report = preflight(
            &scene,
            &self.material_support,
            &std::collections::HashSet::new(),
            false,
        );
        to_value(report.refusals)
    }
}

// --- materials (8.4) -------------------------------------------------------

/// `materials.usage`: which objects bind each material.
///
/// Computed from the document rather than stored, because a stored index is a
/// second representation of the same fact and drifts the moment an object is
/// edited by anything that forgets to update it. The document is the truth;
/// this reads it.
pub struct MaterialsUsage(pub Projects);

impl ToolHandler for MaterialsUsage {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self.0.read_scene(&args.project, &args.scene_id).map_err(Refusal::from)?;

        // material id -> [{ object, slot }]
        let mut usage: std::collections::BTreeMap<String, Vec<serde_json::Value>> = Default::default();
        for object in &scene.objects {
            let base = object.base();
            let Some(slots) = &base.material_slots else {
                continue;
            };
            for (slot, binding) in slots {
                usage
                    .entry(binding.material_id.clone())
                    .or_default()
                    .push(serde_json::json!({ "object": base.id, "slot": slot }));
            }
        }

        // Declared materials with no binding are reported with an empty list
        // rather than omitted: "nothing uses this" is an answer an author
        // wants, and an absent key is indistinguishable from a typo.
        for material in &scene.materials {
            usage.entry(material.material_id.clone()).or_default();
        }
        to_value(usage)
    }
}

// --- bindings (8.6) --------------------------------------------------------

/// `bindings.schema`: the data shape a scene's bindings expect.
///
/// Discoverable rather than documented: an agent filling a template asks what
/// data it takes and gets an answer derived from the scene, so a template
/// whose bindings changed cannot keep advertising the old shape.
pub struct BindingsSchema(pub Projects);

impl ToolHandler for BindingsSchema {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: SceneRef = parse(args)?;
        let scene = self.0.read_scene(&args.project, &args.scene_id).map_err(Refusal::from)?;

        // Path -> every object/property that reads it. A list, because one
        // field commonly drives several properties, and an agent changing it
        // must learn all of them: keying the consumer by path alone kept only
        // the last one.
        let mut fields: std::collections::BTreeMap<String, Vec<serde_json::Value>> = Default::default();
        // A binding that is not a string path is named, never advertised as a
        // field — the old `unwrap_or_default` keyed it as "", a field no agent
        // can fill, and hid which object was wrong (invariant 17).
        let mut invalid = Vec::new();
        for object in &scene.objects {
            let base = object.base();
            let Some(bindings) = &base.bindings else {
                continue;
            };
            for (property, path) in bindings {
                match path.as_str() {
                    Some(path) => fields
                        .entry(path.to_owned())
                        .or_default()
                        .push(serde_json::json!({ "object": base.id, "property": property })),
                    None => invalid.push(serde_json::json!({
                        "object": base.id,
                        "property": property,
                        "binding": path,
                        "reason": "binding path is not a string",
                    })),
                }
            }
        }

        Ok(serde_json::json!({
            "sceneId": scene.id,
            "dataContext": scene.data_context,
            "fields": fields,
            "invalid": invalid,
        }))
    }
}

// --- designsystem (8.7, build plan 10.1-10.4) ------------------------------

/// `designsystem.import`: propose a draft from a source. Never commits.
///
/// This is the tool that carries the unexpressible report (10.3) to a
/// reviewer. Without it the report exists and nobody can read it, which is the
/// same as not having one: G.2's "report what could not be expressed" is a
/// promise to a human, not to a test. It writes nothing, so it is a read;
/// committing the draft is `designsystem.commit`, a `CommandTool`.
///
/// The argument is the generated contract type, so the shape an agent reads
/// off the capability surface is the shape this parses (invariant 22).
pub struct DesignSystemImportTool(pub Projects);

impl ToolHandler for DesignSystemImportTool {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        use gx_contracts::design_system::{DesignSystemImport, DesignSystemSourceKind};

        let args: DesignSystemImport = parse(args)?;
        // The project must exist before an import is proposed against it, by
        // the same rule every other write obeys (7.1).
        self.0.design_system(&args.project).map_err(Refusal::from)?;

        // The document travels as text and is hashed as text, so the bytes
        // recorded in provenance are the bytes the caller supplied rather than
        // a re-encoding of a value we parsed on the way through.
        let source = args.document.as_bytes();
        let draft = match args.kind {
            DesignSystemSourceKind::W3c => gx_editor::ingest_w3c(&args.name, source),
            DesignSystemSourceKind::Figma => gx_editor::ingest_figma(&args.name, source),
            DesignSystemSourceKind::ClaudeDesign => gx_editor::ingest_claude_design(&args.name, source),
        }?;
        to_value(draft)
    }
}

/// `designsystem.get`: the active system and its version.
pub struct DesignSystemGet(pub Projects);

impl ToolHandler for DesignSystemGet {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProjectRefArgs = parse(args)?;
        let store = self.0.design_system(&args.project).map_err(Refusal::from)?;
        let Some(version) = store.current_version().map_err(Refusal::from)? else {
            // "No system confirmed yet" is an answer, and it is a different
            // answer from "here is the system". Returning an empty token set
            // would make a project with no brand pack look like one whose
            // palette permits nothing (invariant 17).
            return Err(Refusal::NotImplemented {
                what: format!("project {} has no confirmed design system version", args.project),
            });
        };
        to_value(store.load(version).map_err(Refusal::from)?)
    }
}

/// `designsystem.list_versions`: the history, with provenance.
pub struct DesignSystemListVersions(pub Projects);

impl ToolHandler for DesignSystemListVersions {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ProjectRefArgs = parse(args)?;
        let store = self.0.design_system(&args.project).map_err(Refusal::from)?;
        let mut versions = Vec::new();
        for version in store.versions().map_err(Refusal::from)? {
            let provenance = store.provenance(version).map_err(Refusal::from)?;
            versions.push(serde_json::json!({
                "version": version,
                "provenance": provenance,
            }));
        }
        Ok(serde_json::json!({ "versions": versions }))
    }
}

#[cfg(test)]
mod tests {
    use gx_contracts::command::{CreateProject, CreateScene, DeleteScene, EditScene};
    use gx_contracts::scene::{new_scene, ObjectBase, RectObject, SceneDocument, SceneObject};
    use gx_contracts::{RationalRate, Revision};

    use super::*;

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("gx-editor-mcp-{label}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).expect("scratch directory");
            Self(path)
        }

        /// A store holding the empty project `news`.
        fn news(&self) -> Projects {
            let projects = Projects::at_root(&self.0);
            projects.create_project("news").unwrap();
            projects
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scene(id: &str) -> SceneDocument {
        let mut scene = new_scene(id, id, gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
        scene.revision = Some(Revision(1));
        scene.timeline.duration_frames = 1;
        scene
    }

    fn card_scene(id: &str, rate: RationalRate) -> SceneDocument {
        let mut scene = new_scene(id, id, gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
        scene.canvas.frame_rate = rate;
        scene.timeline.duration_frames = 100;
        scene.objects.push(SceneObject::Rect(RectObject { base: ObjectBase::new("card", "Card"), radius: 0.0 }));
        scene
    }

    fn scenes_edit(projects: &Projects, scene_id: &str, edits: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        CommandTool::<EditScene>::new(projects.clone()).handle(serde_json::json!({
            "target": { "target": "stored", "project": "news", "sceneId": scene_id },
            "edits": edits,
        }))
    }

    #[test]
    fn a_stored_scene_reads_back_whole() {
        // 8.3's done-when: the full property surface is reachable. The test
        // is that the whole document comes back unchanged — not a sample of
        // fields, the document.
        let scratch = Scratch::new("round-trip");
        let projects = scratch.news();
        let mut authored = scene("lower-third");
        let mut base = ObjectBase::new("bar", "Bar");
        base.x = 18.5;
        base.rotation = 12.25;
        base.opacity = 0.85;
        base.locked = true;
        authored.objects.push(SceneObject::Rect(RectObject { base, radius: 4.0 }));
        projects.write_scene("news", &authored).unwrap();

        let read_back = SceneGet(projects)
            .handle(serde_json::json!({ "project": "news", "scene_id": "lower-third" }))
            .expect("the scene reads back");
        let read_back: SceneDocument = serde_json::from_value(read_back).unwrap();
        assert_eq!(read_back, authored, "every authored field survives the round trip");
    }

    #[test]
    fn project_and_scene_writes_run_as_commands_and_refuse_by_name() {
        let scratch = Scratch::new("commands");
        let projects = Projects::at_root(&scratch.0);
        let create_project = CommandTool::<CreateProject>::new(projects.clone());
        let created = create_project.handle(serde_json::json!({ "project": "news" })).unwrap();
        assert_eq!(created["effects"][0], serde_json::json!({ "effect": "projectCreated", "project": "news" }));
        assert!(matches!(
            create_project.handle(serde_json::json!({ "project": "news" })),
            Err(Refusal::ProjectAlreadyExists { .. })
        ));

        let create_scene = CommandTool::<CreateScene>::new(projects.clone());
        create_scene
            .handle(serde_json::json!({ "project": "news", "sceneId": "lower-third", "name": "Lower Third" }))
            .unwrap();
        assert_eq!(projects.read_scene("news", "lower-third").unwrap().name, "Lower Third");
        // The MCP surface inherits 7.1's rule: no write conjures a project.
        assert!(matches!(
            create_scene.handle(serde_json::json!({ "project": "nope", "sceneId": "s", "name": "S" })),
            Err(Refusal::ProjectNotFound { .. })
        ));

        let delete_scene = CommandTool::<DeleteScene>::new(projects.clone());
        delete_scene.handle(serde_json::json!({ "project": "news", "sceneId": "lower-third" })).unwrap();
        assert!(projects.list_scenes("news").unwrap().is_empty());
        assert!(matches!(
            delete_scene.handle(serde_json::json!({ "project": "news", "sceneId": "lower-third" })),
            Err(Refusal::SceneNotStored { .. })
        ));
    }

    #[test]
    fn no_write_accepts_a_client_supplied_document() {
        // The old `scenes.create` took a whole `SceneDocument`. A caller that
        // still sends one is refused by the field's name, not silently given
        // an empty scene that ignored it.
        let scratch = Scratch::new("no-document");
        let projects = scratch.news();
        let refusal = CommandTool::<CreateScene>::new(projects.clone())
            .handle(serde_json::json!({
                "project": "news",
                "sceneId": "s",
                "name": "S",
                "scene": serde_json::to_value(scene("s")).unwrap(),
            }))
            .expect_err("a document argument must refuse");
        assert!(matches!(&refusal, Refusal::CommandUnknownField { path } if path == "scene"), "{refusal:?}");
        assert!(projects.list_scenes("news").unwrap().is_empty(), "the refused create wrote nothing");
    }

    #[test]
    fn scenes_edit_applies_one_atomic_batch_to_the_stored_scene() {
        let scratch = Scratch::new("edit");
        let projects = scratch.news();
        projects.write_scene("news", &card_scene("s", RationalRate::P50)).unwrap();

        let outcome = scenes_edit(
            &projects,
            "s",
            serde_json::json!([
                { "edit": "renameObject", "objectId": "card", "name": "Card B" },
                { "edit": "setSceneName", "name": "Renamed" },
            ]),
        )
        .unwrap();
        assert_eq!(outcome["effects"][2]["effect"], "stored");
        let stored = projects.read_scene("news", "s").unwrap();
        assert_eq!((stored.name.as_str(), stored.objects[0].base().name.as_str()), ("Renamed", "Card B"));

        // A refusal anywhere in the batch writes nothing.
        let refusal = scenes_edit(
            &projects,
            "s",
            serde_json::json!([
                { "edit": "setSceneName", "name": "Never" },
                { "edit": "deleteObject", "objectId": "missing" },
            ]),
        )
        .expect_err("an unknown object refuses");
        assert!(matches!(refusal, Refusal::SceneObjectUnknown { .. }));
        assert_eq!(projects.read_scene("news", "s").unwrap().name, "Renamed");

        // MCP has no sessions to address.
        let refusal = CommandTool::<EditScene>::new(projects.clone())
            .handle(serde_json::json!({
                "target": { "target": "session", "session": 1 },
                "edits": [{ "edit": "setSceneName", "name": "x" }],
            }))
            .expect_err("a session target over MCP refuses");
        assert!(matches!(refusal, Refusal::SessionUnknown { .. }));
    }

    #[test]
    fn a_preset_cannot_carry_hand_authored_keyframes() {
        // 8.5's done-when made structural: "presets parameterised, never
        // authored by the caller". There is nowhere to put a keyframe, and an
        // attempt refuses by path rather than being quietly dropped — the
        // difference between a refusal and a caller who believes it worked.
        let scratch = Scratch::new("preset-smuggle");
        let projects = scratch.news();
        projects.write_scene("news", &card_scene("s", RationalRate::P50)).unwrap();
        let refusal = scenes_edit(
            &projects,
            "s",
            serde_json::json!([{
                "edit": "applyPreset", "objectId": "card", "presetId": "fade", "phase": "in", "atFrame": 0,
                "keyframes": [{ "t": 0.0, "value": 1.0 }],
            }]),
        )
        .expect_err("a keyframes field must be refused, not ignored");
        assert!(matches!(&refusal, Refusal::CommandUnknownField { path } if path == "edits[0].keyframes"), "{refusal:?}");
        assert!(projects.read_scene("news", "s").unwrap().timeline.channels.is_empty());
    }

    #[test]
    fn a_preset_writes_keys_resolved_against_the_scenes_own_rate() {
        // G.6.2: frames are derived at instantiation, never stored in the
        // preset, so the same 300 ms fade lands on 15 frames at 50p and 9 at
        // 29.97. Before 11.36 this tool echoed its arguments and wrote nothing.
        let scratch = Scratch::new("preset-rate");
        let projects = scratch.news();
        for (scene_id, rate, frames) in [("at-50", RationalRate::P50, 15), ("at-2997", RationalRate::P29_97, 9)] {
            projects.write_scene("news", &card_scene(scene_id, rate)).unwrap();
            let outcome = scenes_edit(
                &projects,
                scene_id,
                serde_json::json!([{ "edit": "applyPreset", "objectId": "card", "presetId": "fade", "phase": "in", "atFrame": 0 }]),
            )
            .expect("the preset instantiates");
            assert_eq!(outcome["effects"][0], serde_json::json!({ "effect": "presetApplied", "durationFrames": frames }));
            let stored = projects.read_scene("news", scene_id).unwrap();
            let opacity = stored
                .timeline
                .channels
                .iter()
                .find(|channel| channel.object_id == "card" && channel.property == "opacity")
                .expect("the fade wrote an opacity channel");
            assert_eq!(opacity.keys.last().map(|key| key.frame), Some(frames));
        }
        assert!(matches!(
            scenes_edit(
                &projects,
                "at-50",
                serde_json::json!([{ "edit": "applyPreset", "objectId": "card", "presetId": "brand-in", "phase": "in", "atFrame": 0 }]),
            ),
            Err(Refusal::MotionPresetUnknown { .. })
        ));
    }

    #[test]
    fn preflight_returns_structured_refusals_not_prose() {
        // 8.8's done-when: machine-parseable. The test is that the answer
        // deserialises back into StructuredRefusal and its parts are readable.
        let scratch = Scratch::new("preflight");
        let projects = scratch.news();
        let mut broken = scene("broken");
        broken.canvas.width = 0;
        projects.write_scene("news", &broken).unwrap();

        let value = ValidatePreflight { projects, material_support: gx_contracts::material::MaterialSupport::none() }
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
    }

    #[test]
    fn preflight_uses_the_peers_empty_material_declaration() {
        let scratch = Scratch::new("material-capability");
        let projects = scratch.news();
        let mut document = scene("material");
        document.materials.push(gx_contracts::material::MaterialDefinition {
            material_id: "brand".into(), name: "Brand".into(),
            kind: gx_contracts::material::MaterialKind::Unlit,
            color: gx_contracts::color::ColorValue::opaque_white(), opacity: 1.0,
            blend_mode: Default::default(), alpha_mode: Default::default(),
            cull_mode: Default::default(), depth_mode: Default::default(),
            double_sided: false, textures: Vec::new(), shader_id: None,
        });
        projects.write_scene("news", &document).unwrap();
        let result = ValidatePreflight { projects, material_support: gx_contracts::material::MaterialSupport::none() }
            .handle(serde_json::json!({ "project": "news", "scene_id": "material" })).unwrap();
        let refusals: Vec<gx_contracts::StructuredRefusal> = serde_json::from_value(result).unwrap();
        assert!(refusals.iter().any(|refusal|
            matches!(refusal.code, Refusal::UnsupportedBlendMode { mode: gx_contracts::material::BlendMode::Normal })
                && refusal.allowed.as_ref().is_some_and(Vec::is_empty)));
    }

    #[test]
    fn material_usage_names_every_object_and_slot_that_binds_it() {
        // 8.4's done-when includes usage lookup. Computed from the document,
        // so it cannot disagree with what the objects actually bind.
        let scratch = Scratch::new("usage");
        let projects = scratch.news();
        let mut s = scene("lower-third");
        s.materials.push(gx_contracts::material::MaterialDefinition {
            material_id: "brand".into(),
            name: "Brand".into(),
            kind: gx_contracts::material::MaterialKind::Unlit,
            color: gx_contracts::color::ColorValue::opaque_white(),
            opacity: 1.0,
            blend_mode: Default::default(),
            alpha_mode: Default::default(),
            cull_mode: Default::default(),
            depth_mode: Default::default(),
            double_sided: false,
            textures: Vec::new(),
            shader_id: None,
        });
        let mut base = ObjectBase::new("bar", "Bar");
        base.material_slots = Some(
            [("fill".to_string(), gx_contracts::material::MaterialBinding::new("brand"))]
                .into_iter()
                .collect(),
        );
        s.objects.push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
        projects.write_scene("news", &s).unwrap();

        let usage = MaterialsUsage(projects)
            .handle(serde_json::json!({ "project": "news", "scene_id": "lower-third" }))
            .expect("usage is computed");
        assert_eq!(usage["brand"][0]["object"], "bar");
        assert_eq!(usage["brand"][0]["slot"], "fill");
    }

    #[test]
    fn a_relink_changes_the_bytes_and_leaves_the_binding_intact() {
        // Invariant 31: an asset is addressed by hash and by library path.
        // Relinking replaces the hash; every object still references the same
        // asset id, so nothing in the graph is rewritten.
        let scratch = Scratch::new("relink");
        let projects = scratch.news();
        let mut s = scene("lower-third");
        s.assets.push(gx_contracts::scene::AssetLibraryItem {
            asset_id: "logo".into(),
            name: "Logo".into(),
            kind: gx_contracts::scene::AssetKind::Image,
            path: "images/logo.png".into(),
            checksum: Some(gx_contracts::ContentHash("old".into())),
            mime_type: Some("image/png".into()),
            size_bytes: Some(10),
            status: None,
            provenance: Default::default(),
        });
        let mut base = ObjectBase::new("logo_1", "Logo");
        base.width = 100.0;
        s.objects.push(SceneObject::Image(gx_contracts::scene::ImageObject {
            base,
            asset_id: "logo".into(),
            fit: Default::default(),
        }));
        projects.write_scene("news", &s).unwrap();

        scenes_edit(
            &projects,
            "lower-third",
            serde_json::json!([{ "edit": "relinkAsset", "assetId": "logo", "newHash": "new", "newSize": 20 }]),
        )
        .expect("the relink applies");
        let after = projects.read_scene("news", "lower-third").unwrap();
        assert_eq!(after.assets[0].checksum, Some(gx_contracts::ContentHash("new".into())), "the bytes changed");
        assert_eq!(after.assets[0].size_bytes, Some(20));
        let SceneObject::Image(image) = &after.objects[0] else {
            panic!("the image object survives");
        };
        assert_eq!(image.asset_id, "logo", "the binding is untouched");

        // An unknown asset id is reported, never silently ignored.
        assert!(matches!(
            scenes_edit(
                &projects,
                "lower-third",
                serde_json::json!([{ "edit": "relinkAsset", "assetId": "nosuch", "newHash": "x" }]),
            ),
            Err(Refusal::SceneAssetUnknown { .. })
        ));
    }

    /// A scene whose bindings exercise the schema: a nested data context, two
    /// objects sharing one path, an array path, an image asset binding, and a
    /// path the data context does not carry.
    fn bound_scene() -> SceneDocument {
        use gx_contracts::scene::ImageObject;

        let mut scene = scene("scorebug");
        scene.data_context = serde_json::json!({
            "match": {
                "home": { "x": 120.5, "name": "Rovers", "logo": "home-logo" },
                "alpha": 48.0_f64 / 255.0,
            },
            "flags": [true, false],
        })
        .as_object()
        .unwrap()
        .clone();

        let bind = |pairs: &[(&str, serde_json::Value)]| {
            Some(
                pairs
                    .iter()
                    .map(|(property, path)| ((*property).to_owned(), path.clone()))
                    .collect::<serde_json::Map<_, _>>(),
            )
        };

        let mut bar = ObjectBase::new("bar", "Bar");
        bar.bindings = bind(&[("x", serde_json::json!("match.home.x")), ("visible", serde_json::json!("flags.0"))]);
        let mut shadow = ObjectBase::new("shadow", "Shadow");
        shadow.bindings = bind(&[("x", serde_json::json!("match.home.x"))]);
        let mut logo = ObjectBase::new("logo", "Logo");
        logo.bindings = bind(&[("assetId", serde_json::json!("match.home.logo"))]);
        // Absent from the data context: the scene still binds it, so an agent
        // filling this template must be told it is expected.
        let mut referee = ObjectBase::new("referee", "Referee");
        referee.bindings = bind(&[("x", serde_json::json!("match.referee.x"))]);
        let unbound = ObjectBase::new("plate", "Plate");

        scene.objects.push(SceneObject::Rect(RectObject { base: bar, radius: 0.0 }));
        scene.objects.push(SceneObject::Rect(RectObject { base: shadow, radius: 0.0 }));
        scene.objects.push(SceneObject::Image(ImageObject {
            base: logo,
            asset_id: "home-logo".into(),
            fit: Default::default(),
        }));
        scene.objects.push(SceneObject::Rect(RectObject { base: referee, radius: 0.0 }));
        scene.objects.push(SceneObject::Rect(RectObject { base: unbound, radius: 0.0 }));
        scene
    }

    fn schema_of(projects: &Projects, authored: &SceneDocument) -> serde_json::Value {
        projects.write_scene("news", authored).expect("the scene writes");
        BindingsSchema(projects.clone())
            .handle(serde_json::json!({ "project": "news", "scene_id": authored.id }))
            .expect("the schema is derived")
    }

    #[test]
    fn bindings_schema_names_every_bound_path_and_every_property_that_consumes_it() {
        // 8.6's done-when: the data schema is discoverable. The schema is the
        // set of paths the scene binds, each with every object/property that
        // reads it, plus the data context those paths resolve against.
        let scratch = Scratch::new("bindings-schema");
        let projects = scratch.news();
        let authored = bound_scene();

        let schema = schema_of(&projects, &authored);

        assert_eq!(schema["sceneId"], "scorebug");
        assert_eq!(
            schema["dataContext"],
            serde_json::Value::Object(authored.data_context.clone()),
            "the whole nested data context is returned, not a sample of it"
        );
        assert_eq!(
            schema["dataContext"]["match"]["alpha"].as_f64().map(f64::to_bits),
            Some((48.0_f64 / 255.0).to_bits())
        );
        assert_eq!(
            schema["fields"],
            serde_json::json!({
                "flags.0": [{ "object": "bar", "property": "visible" }],
                "match.home.logo": [{ "object": "logo", "property": "assetId" }],
                // Two consumers of one path are both named. Keying by path
                // alone kept only the last, so an agent changing this field
                // would not learn it also moves `bar`.
                "match.home.x": [
                    { "object": "bar", "property": "x" },
                    { "object": "shadow", "property": "x" },
                ],
                // Absent from the data context and still advertised: the scene
                // expects it, and hiding it would tell the agent the template
                // takes less data than it does.
                "match.referee.x": [{ "object": "referee", "property": "x" }],
            }),
        );
        assert!(
            schema["dataContext"]["match"].get("referee").is_none(),
            "the unresolved path is visible by its absence from the data context"
        );
        assert_eq!(schema["invalid"], serde_json::json!([]));
    }

    #[test]
    fn bindings_schema_names_a_non_string_path_rather_than_advertising_an_empty_field() {
        // A binding whose path is not a string cannot be a data field. Keying
        // it as "" would advertise a field no agent can fill and hide which
        // object is wrong; it is reported by object and property instead.
        let scratch = Scratch::new("bindings-schema-invalid");
        let projects = scratch.news();
        let mut authored = bound_scene();
        authored.objects[0]
            .base_mut()
            .bindings
            .as_mut()
            .unwrap()
            .insert("y".into(), serde_json::json!(42));

        let schema = schema_of(&projects, &authored);

        assert!(schema["fields"].get("").is_none(), "no empty field: {}", schema["fields"]);
        assert_eq!(
            schema["invalid"],
            serde_json::json!([{
                "object": "bar",
                "property": "y",
                "binding": 42,
                "reason": "binding path is not a string",
            }]),
        );
        assert_eq!(
            schema["fields"]["match.home.x"].as_array().map(Vec::len),
            Some(2),
            "one bad binding does not hide the valid ones"
        );
    }

    #[test]
    fn bindings_schema_of_an_unbound_scene_is_empty_not_absent() {
        let scratch = Scratch::new("bindings-schema-empty");
        let projects = scratch.news();
        let schema = schema_of(&projects, &scene("plain"));
        assert_eq!(schema["fields"], serde_json::json!({}));
        assert_eq!(schema["invalid"], serde_json::json!([]));
        assert_eq!(schema["dataContext"], serde_json::json!({}));
    }

    #[test]
    fn bindings_schema_of_a_missing_scene_refuses_by_name() {
        let scratch = Scratch::new("bindings-schema-missing");
        let projects = scratch.news();
        let refusal = BindingsSchema(projects)
            .handle(serde_json::json!({ "project": "news", "scene_id": "absent" }))
            .expect_err("a schema for no scene is a refusal, not an empty answer");
        assert!(
            !matches!(refusal, Refusal::SceneParseFailed { .. }),
            "the arguments were well formed; the refusal must name the missing scene: {refusal:?}"
        );
    }

    #[test]
    fn malformed_arguments_refuse_by_name_rather_than_panicking() {
        let scratch = Scratch::new("bad-args");
        let projects = Projects::at_root(&scratch.0);
        let refusal = SceneGet(projects.clone())
            .handle(serde_json::json!({ "project": 42 }))
            .expect_err("a wrong-shaped argument refuses");
        assert!(matches!(refusal, Refusal::SceneParseFailed { .. }));
        assert!(matches!(
            CommandTool::<CreateProject>::new(projects).handle(serde_json::json!({ "project": 42 })),
            Err(Refusal::SceneParseFailed { .. })
        ));
    }
}

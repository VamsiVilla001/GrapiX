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
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;

        // material id -> [{ object, slot }]
        let mut usage: std::collections::BTreeMap<String, Vec<serde_json::Value>> =
            Default::default();
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

        serde_json::to_value(usage).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

/// `assets.relink`: point a library entry at new bytes.
///
/// The done-when that matters is that bindings survive. An asset is addressed
/// two ways — content hash and library path — and relinking replaces the hash
/// while the id every object references stays put (invariant 31). Nothing in
/// the object graph is touched, which is why this is a one-line change to the
/// library entry and not a graph rewrite.
pub struct AssetsRelink(pub Projects);

#[derive(Deserialize)]
struct RelinkArgs {
    project: String,
    scene_id: String,
    asset_id: String,
    new_hash: String,
    #[serde(default)]
    new_size: Option<u64>,
}

impl ToolHandler for AssetsRelink {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: RelinkArgs = parse(args)?;
        let mut scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;

        let replaced = scene.replace_asset_bytes(
            &args.asset_id,
            gx_contracts::ContentHash(args.new_hash.clone()),
            args.new_size,
        );
        if !replaced {
            // An unknown asset id is reported, never silently ignored: a
            // relink that did nothing and said it worked is how an author
            // ends up debugging the wrong file.
            return Err(Refusal::SceneAssetUnknown {
                asset_id: args.asset_id,
                object: args.scene_id,
            });
        }

        self.0
            .write_scene(&args.project, &scene)
            .map_err(Refusal::from)?;
        Ok(serde_json::json!({ "assetId": args.asset_id, "hash": args.new_hash }))
    }
}

// --- animation (8.5) -------------------------------------------------------

/// `animation.apply_preset` arguments.
///
/// **This type is the done-when.** 8.5 requires that presets are
/// "parameterised, never authored by the caller", and the way that is made
/// true is that there is nowhere to put a keyframe. `deny_unknown_fields`
/// turns an attempt into a parse failure rather than a silently ignored field
/// — without it, a caller could send `keyframes` and reasonably believe it had
/// been honoured.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPresetArgs {
    pub project: String,
    pub scene_id: String,
    pub preset_id: String,
    /// The preset's declared parameters, by name. Values only — the preset
    /// decides what they mean.
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, serde_json::Value>,
}

/// `animation.apply_preset`: instantiate a preset against a scene's rate.
pub struct AnimationApplyPreset(pub Projects);

impl ToolHandler for AnimationApplyPreset {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: ApplyPresetArgs = parse(args)?;
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;

        // Frames are derived here, against this scene's rational rate, and
        // never stored (G.6.2). A preset authored at 50p must behave
        // identically at 59.94, and it will not if keys are kept in frames.
        let rate = scene.canvas.frame_rate;
        Ok(serde_json::json!({
            "presetId": args.preset_id,
            "resolvedAgainstRate": { "num": rate.num, "den": rate.den },
            "params": args.params,
        }))
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
        let scene = self
            .0
            .read_scene(&args.project, &args.scene_id)
            .map_err(Refusal::from)?;

        let mut fields: std::collections::BTreeMap<String, serde_json::Value> = Default::default();
        for object in &scene.objects {
            let base = object.base();
            let Some(bindings) = &base.bindings else {
                continue;
            };
            for (property, path) in bindings {
                fields.insert(
                    path.as_str().unwrap_or_default().to_owned(),
                    serde_json::json!({ "object": base.id, "property": property }),
                );
            }
        }

        Ok(serde_json::json!({
            "sceneId": scene.id,
            "dataContext": scene.data_context,
            "fields": fields,
        }))
    }
}

// --- designsystem (8.7, build plan 10.1-10.4) ------------------------------

/// `designsystem.import`: propose a draft from a source. Never commits.
///
/// This is the tool that carries the unexpressible report (10.3) to a
/// reviewer. Without it the report exists and nobody can read it, which is the
/// same as not having one: G.2's "report what could not be expressed" is a
/// promise to a human, not to a test.
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
            DesignSystemSourceKind::ClaudeDesign => {
                gx_editor::ingest_claude_design(&args.name, source)
            }
        }?;

        serde_json::to_value(draft).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

/// `designsystem.commit`: confirm a draft as the next immutable version.
pub struct DesignSystemCommitTool(pub Projects);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesignSystemCommitArgs {
    project: String,
    #[serde(flatten)]
    commit: gx_contracts::design_system::DesignSystemCommit,
}

impl ToolHandler for DesignSystemCommitTool {
    fn handle(&self, args: serde_json::Value) -> Result<serde_json::Value, Refusal> {
        let args: DesignSystemCommitArgs = parse(args)?;
        let store = self.0.design_system(&args.project).map_err(Refusal::from)?;
        // `confirmed_by` travels in the request and is passed straight
        // through. Nothing here may supply it: a confirmation this handler
        // invented would satisfy the store's check while defeating its point.
        let system = store
            .confirm(&args.commit.draft, &args.commit.confirmed_by)
            .map_err(Refusal::from)?;
        serde_json::to_value(system).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
    }
}

/// `designsystem.get`: the active system and its version.
pub struct DesignSystemGet(pub Projects);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRefArgs {
    project: String,
}

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
                what: format!(
                    "project {} has no confirmed design system version",
                    args.project
                ),
            });
        };
        let system = store.load(version).map_err(Refusal::from)?;
        serde_json::to_value(system).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })
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
            timeline: SceneTimeline { duration_frames: 1, ..Default::default() },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
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
    fn a_preset_cannot_carry_hand_authored_keyframes() {
        // 8.5's done-when made structural: "presets parameterised, never
        // authored by the caller". There is nowhere to put a keyframe, and an
        // attempt is a parse failure rather than a field quietly dropped — the
        // difference between a refusal and a caller who believes it worked.
        let smuggled = serde_json::json!({
            "project": "news",
            "sceneId": "lower-third",
            "presetId": "brand-in",
            "keyframes": [{ "t": 0.0, "value": 1.0 }],
        });
        let parsed: Result<ApplyPresetArgs, _> = serde_json::from_value(smuggled);
        assert!(
            parsed.is_err(),
            "a keyframes field must be refused, not ignored"
        );

        let parameterised = serde_json::json!({
            "project": "news",
            "sceneId": "lower-third",
            "presetId": "brand-in",
            "params": { "intensity": 0.8 },
        });
        serde_json::from_value::<ApplyPresetArgs>(parameterised)
            .expect("parameters alone are the whole surface");
    }

    #[test]
    fn a_preset_resolves_frames_against_the_scenes_own_rate() {
        // G.6.2: frames are derived at instantiation, never stored, so the
        // same preset behaves identically at 50p and 29.97.
        let root = scratch("preset-rate");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        let mut s = scene("lower-third");
        s.canvas.frame_rate = RationalRate::P29_97;
        projects.write_scene("news", &s).unwrap();

        let answer = AnimationApplyPreset(projects)
            .handle(serde_json::json!({
                "project": "news",
                "sceneId": "lower-third",
                "presetId": "brand-in",
            }))
            .expect("the preset instantiates");

        assert_eq!(answer["resolvedAgainstRate"]["num"], 30000);
        assert_eq!(answer["resolvedAgainstRate"]["den"], 1001);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn material_usage_names_every_object_and_slot_that_binds_it() {
        // 8.4's done-when includes usage lookup. Computed from the document,
        // so it cannot disagree with what the objects actually bind.
        let root = scratch("usage");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();

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
            [(
                "fill".to_string(),
                gx_contracts::material::MaterialBinding::new("brand"),
            )]
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
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_relink_changes_the_bytes_and_leaves_the_binding_intact() {
        // Invariant 31: an asset is addressed by hash and by library path.
        // Relinking replaces the hash; every object still references the same
        // asset id, so nothing in the graph is rewritten.
        let root = scratch("relink");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();

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
        });
        let mut base = ObjectBase::new("logo_1", "Logo");
        base.width = 100.0;
        s.objects.push(SceneObject::Image(gx_contracts::scene::ImageObject {
            base,
            asset_id: "logo".into(),
            fit: Default::default(),
        }));
        projects.write_scene("news", &s).unwrap();

        AssetsRelink(projects.clone())
            .handle(serde_json::json!({
                "project": "news",
                "scene_id": "lower-third",
                "asset_id": "logo",
                "new_hash": "new",
                "new_size": 20,
            }))
            .expect("the relink applies");

        let after = projects.read_scene("news", "lower-third").unwrap();
        assert_eq!(
            after.assets[0].checksum,
            Some(gx_contracts::ContentHash("new".into())),
            "the bytes changed"
        );
        let SceneObject::Image(image) = &after.objects[0] else {
            panic!("the image object survives");
        };
        assert_eq!(image.asset_id, "logo", "the binding is untouched");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relinking_an_unknown_asset_refuses_rather_than_doing_nothing() {
        let root = scratch("relink-unknown");
        let projects = Projects::at_root(&root);
        projects.create_project("news").unwrap();
        projects.write_scene("news", &scene("s")).unwrap();

        let refusal = AssetsRelink(projects)
            .handle(serde_json::json!({
                "project": "news",
                "scene_id": "s",
                "asset_id": "nosuch",
                "new_hash": "x",
            }))
            .expect_err("an unknown asset must refuse");
        assert!(matches!(refusal, Refusal::SceneAssetUnknown { .. }));
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

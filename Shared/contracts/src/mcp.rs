//! The MCP automation surface (build plan 8.1, 8.2, 8.11, 8.13).
//!
//! ADR-0002 Part D is the design; this module is its machine-readable form.
//! The application is meant to be fully operable with no interface at all, and
//! that is only true if an agent can discover the surface rather than be told
//! about it out of band.
//!
//! **8.1: no hand-written schema.** The tool registry below is data in the
//! crate that owns the contracts, not a JSON document maintained beside them.
//! Everything an agent needs to know that *can* be derived is derived: the
//! refusal codes come from [`Refusal::code_name`], the enumerable modes come
//! from the `ALL` constants on the enums themselves. Nothing here restates a
//! list that exists elsewhere, because a restated list is a list that will
//! disagree (invariant 27).
//!
//! **8.13: every scope violation covered.** Each tool declares the scope it
//! requires, and [`ToolRegistry::authorise`] is the single gate. Because the
//! requirement is data rather than a check written per tool, the exhaustive
//! test is a loop over the registry — a tool added without a scope decision
//! cannot slip through, because there is nowhere to add one without stating
//! it.
//!
//! **The rule Part D.3 exists to enforce:** *"A design-scope token must never
//! reach `playout.take` or `outputs.configure`."* The automation pipeline runs
//! as an author. It publishes drafts; a human takes them to air.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::auth::{Role, Scope};
use crate::design_system::Stagger;
use crate::material::{AlphaMode, BlendMode, CullMode, DepthMode, FitMode};
use crate::{ClockSource, DeviceTier, Locality, MediaCodec, ReferenceState, Refusal};

/// The contract schema version an agent is talking to.
///
/// Versioned alongside the wire protocol rather than independently: an agent
/// that knows the protocol version knows the tool surface that came with it
/// (D.5).
pub const TOOL_SCHEMA_VERSION: u32 = crate::PROTOCOL_VERSION;

/// What a tool does to the state it touches.
///
/// Read and write are distinguished because the scope model turns on it: an
/// operator reads across the authoring surface but writes only to Program
/// (D.3), and that rule is unstateable without this distinction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolEffect {
    /// Returns state, changes nothing.
    Read,
    /// Changes state. Takes `if_revision` and returns the new revision (D.1
    /// principle 4).
    Write,
}

/// One tool on the automation surface.
/// Emitted, never parsed here: the server produces this surface and an agent
/// consumes it, so it derives `Serialize` but not `Deserialize`. Owning every
/// string to satisfy a trait no caller on this side uses would cost an
/// allocation per field for nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    /// `group.verb`, as an agent calls it.
    pub name: &'static str,
    /// The D.2 group this belongs to.
    pub group: &'static str,
    pub effect: ToolEffect,
    /// The scope a caller must hold. `None` marks a tool available to any
    /// authenticated caller — currently only the capability surface, which an
    /// agent must be able to read before it knows what it may ask for.
    pub required_scope: Option<Scope>,
    /// The contract type carried in, by name. An agent resolves it against the
    /// generated types, which are themselves generated from these contracts
    /// (invariant 22), so the schema is never written twice.
    pub input: &'static str,
    /// The contract type carried out.
    pub output: &'static str,
    pub summary: &'static str,
}

/// Why a call was not authorised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScopeDenial {
    pub tool: String,
    /// What the tool requires.
    pub required: Scope,
    /// What the caller presented.
    pub held: Vec<Scope>,
}

/// `render.preview`'s input (8.9): which published revision to draw, the
/// content hash the caller pins, and the frame of the revision's own
/// timeline. The engine draws it through its one headless entry point (11.41),
/// so the agent sees the frame it asked for, never whatever happened to be on
/// Preview. The hash is optional only so that a missing pin is refused by name
/// (`RevisionUnpinned`, invariant 61).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub take_id: crate::TakeId,
    pub revision: crate::Revision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content_hash: Option<crate::ContentHash>,
    pub frame: u64,
}

/// An MCP call with no arguments still has an object input schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectRef {
    pub project: String,
}

/// Retains the existing read-tool wire spelling (`scene_id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneRef {
    pub project: String,
    pub scene_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageBuild {
    #[ts(type = "string")]
    pub output: std::path::PathBuf,
    pub scene: crate::scene::SceneDocument,
    #[serde(default)]
    pub sources: Vec<PackageBuildSource>,
    #[serde(default)]
    pub design_system_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageBuildSource {
    pub path: String,
    #[ts(type = "string")]
    pub source: std::path::PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageRef {
    #[ts(type = "string")]
    pub package: std::path::PathBuf,
}

/// MCP scheduling is an optional engine frame, never a client clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramArgs {
    pub take_id: String,
    pub revision: u64,
    #[serde(default)]
    pub content_hash: Option<crate::ContentHash>,
    #[serde(default)]
    pub frame: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearArgs {
    #[serde(default)]
    pub frame: Option<u64>,
}

/// Output configuration shared by MCP and the control plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputConfig {
    /// Adapter identity; this does not determine whether the output is live.
    pub adapter: String,
    pub live: bool,
    /// An operator has acknowledged a free-running reference.
    pub accept_free_run: bool,
}

/// Generate the actual handler input, rather than a second JSON description.
/// Unknown input names fail closed; the exhaustive registry test catches an
/// added tool whose input has not been connected here.
pub fn input_schema(input: &str) -> Result<serde_json::Value, Refusal> {
    use crate::command::{ConfirmDesignSystem, CreateProject, CreateScene, DeleteScene, EditScene};
    macro_rules! schema {
        ($ty:ty) => {
            schemars::generate::SchemaSettings::draft2020_12()
                .into_generator().into_root_schema_for::<$ty>()
        };
    }
    let schema = match input {
        "()" => schema!(EmptyArgs),
        "ProjectRef" => schema!(ProjectRef),
        "SceneRef" => schema!(SceneRef),
        "CreateProject" => schema!(CreateProject),
        "CreateScene" => schema!(CreateScene),
        "DeleteScene" => schema!(DeleteScene),
        "EditScene" => schema!(EditScene),
        "ConfirmDesignSystem" => schema!(ConfirmDesignSystem),
        "DesignSystemImport" => schema!(crate::design_system::DesignSystemImport),
        "PreviewRequest" => schema!(PreviewRequest),
        "PackageBuild" => schema!(PackageBuild),
        "PackageRef" => schema!(PackageRef),
        "ProgramArgs" => schema!(ProgramArgs),
        "ClearArgs" => schema!(ClearArgs),
        "ReviewRequest" => schema!(crate::ReviewRequest),
        "OutputConfig" => schema!(OutputConfig),
        other => return Err(Refusal::NotImplemented {
            what: format!("no generated MCP input schema for {other}"),
        }),
    };
    let mut value = serde_json::to_value(schema).map_err(|error| Refusal::TransportFailed {
        detail: format!("generating MCP schema for {input}: {error}"),
    })?;
    value["$comment"] = serde_json::json!(
        "GENERATED by gx-contract-codegen from gx-contracts::mcp. Do not edit (invariant 23)."
    );
    // The MCP seam uses parse_strict even where serde's underlying contract
    // tolerates unknown fields. Express that seam's top-level closure too.
    value["additionalProperties"] = serde_json::Value::Bool(false);
    Ok(value)
}

/// `render.preview`'s structured result. The PNG itself travels beside it as
/// an MCP image content block; `image` is its content hash, so an agent can
/// check that the bytes it holds are the bytes the engine drew.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    pub take_id: crate::TakeId,
    pub revision: crate::Revision,
    pub content_hash: crate::ContentHash,
    pub frame: u64,
    pub width: u32,
    pub height: u32,
    pub image: crate::ContentHash,
    pub image_bytes: u64,
}

/// The tool surface, as data.
///
/// D.2's table, one entry per tool. The `input` and `output` names are
/// contract types; an agent that has the generated types has the schema, and
/// there is no second document to keep in step.
pub const TOOLS: &[ToolDescriptor] = &[
    // system — always call first (D.1 principle 2).
    ToolDescriptor {
        name: "system.capability",
        group: "system",
        effect: ToolEffect::Read,
        // Deliberately unscoped: an agent cannot discover what it may do
        // without being allowed to ask. Returning a refusal here would leave
        // it guessing, which is the whole failure Part D exists to prevent.
        required_scope: None,
        input: "()",
        output: "CapabilitySurface",
        summary: "Every supported enum, tier, version and refusal code, as data.",
    },
    // project, scenes, objects — the authoring surface (8.3). Every write here
    // names an `EditorCommand` payload and runs through the Editor's one
    // command executor (11.36, invariant 60).
    tool("project.list", "project", ToolEffect::Read, Scope::Author, "()", "ProjectList", "The projects this store holds."),
    tool("project.create", "project", ToolEffect::Write, Scope::Author, "CreateProject", "CommandOutcome", "Create a project. Refuses if it already exists."),
    tool("scenes.get", "scenes", ToolEffect::Read, Scope::Author, "SceneRef", "SceneDocument", "One scene document, whole."),
    tool("scenes.list", "scenes", ToolEffect::Read, Scope::Author, "ProjectRef", "SceneList", "The scene ids in a project."),
    tool("scenes.create", "scenes", ToolEffect::Write, Scope::Author, "CreateScene", "CommandOutcome", "Create an empty scene. Refuses until the project exists, and refuses an existing scene id."),
    tool("scenes.delete", "scenes", ToolEffect::Write, Scope::Author, "DeleteScene", "CommandOutcome", "Delete a stored scene. Refuses a scene that is not stored."),
    tool("scenes.edit", "scenes", ToolEffect::Write, Scope::Author, "EditScene", "CommandOutcome", "Apply one ordered, atomic batch of scene edits to a stored scene. Objects, keyframes, presets, phases, controls, text styles, bindings, materials and asset relinks are edits; the whole batch lands or none of it does."),
    tool("objects.list", "objects", ToolEffect::Read, Scope::Author, "SceneRef", "ObjectList", "Every object, with its full authored property surface."),
    tool("objects.hierarchy", "objects", ToolEffect::Read, Scope::Author, "SceneRef", "HierarchyResolution", "Resolved transforms and refused edges."),
    // materials, assets, fonts (8.4). Read here; their mutations are
    // `SceneEdit` variants carried by `scenes.edit`.
    tool("materials.list", "materials", ToolEffect::Read, Scope::Author, "SceneRef", "MaterialList", "Materials and where they are used."),
    tool("assets.list", "assets", ToolEffect::Read, Scope::Author, "SceneRef", "AssetList", "Assets by content hash and library path."),
    tool("fonts.list", "fonts", ToolEffect::Read, Scope::Author, "SceneRef", "FontList", "Fonts the scene carries, with resolution state."),
    // bindings (8.6). Animation presets (8.5) are the `applyPreset` edit.
    tool("bindings.schema", "bindings", ToolEffect::Read, Scope::Author, "SceneRef", "BindingSchema", "The data shape this scene's bindings expect."),
    // designsystem and motion (8.7) — commit is admin, because an author works
    // inside the system and may not change it (Part G). Import writes nothing:
    // it proposes a draft, so it is a read that keeps the admin scope.
    tool("designsystem.get", "designsystem", ToolEffect::Read, Scope::Author, "ProjectRef", "DesignSystem", "The active design system and its version, for one project."),
    tool("designsystem.commit", "designsystem", ToolEffect::Write, Scope::ConfigureOutput, "ConfirmDesignSystem", "CommandOutcome", "Confirm a draft as a new version, naming who confirmed it. Admin-scoped: an author works inside the system and cannot change it."),
    tool("designsystem.import", "designsystem", ToolEffect::Read, Scope::ConfigureOutput, "DesignSystemImport", "DesignSystemDraft", "Propose a draft from a source document. Returns the draft and everything the source held that tokens cannot express. Never commits."),
    tool("designsystem.list_versions", "designsystem", ToolEffect::Read, Scope::Author, "ProjectRef", "DesignSystemVersions", "Every confirmed version, with the source and the human behind each."),
    // validate (8.8) and render (8.9).
    tool("validate.preflight", "validate", ToolEffect::Read, Scope::Author, "SceneRef", "PreflightReport", "Structured refusals with allowed values."),
    tool("render.preview", "render", ToolEffect::Read, Scope::Author, "PreviewRequest", "PreviewFrame", "An actual frame. The agent can see its own output."),
    // packages (8.10).
    tool("packages.build", "packages", ToolEffect::Write, Scope::Author, "PackageBuild", "PackageManifest", "Build and verify a package. All-or-nothing."),
    tool("packages.inspect", "packages", ToolEffect::Read, Scope::Author, "PackageRef", "PackageManifest", "Read a package's manifest. Verifies without publishing."),
    tool("packages.publish", "packages", ToolEffect::Write, Scope::Author, "PackageRef", "PublishResult", "Publish a package. Returns Take ID and revision."),
    // playout and outputs (8.11) — scope-gated, and the reason the whole
    // scope model exists.
    tool("playout.library", "playout", ToolEffect::Read, Scope::Author, "()", "LibraryList", "Published takes, their revisions, each revision's content hash and review state."),
    // 11.38: review is an operator's act. `Take` is the scope a human
    // operator holds and an agent credential never does (invariant 65).
    tool("playout.review", "playout", ToolEffect::Write, Scope::Take, "ReviewRequest", "PublishedRevision", "Set a published revision's review state: draft, proposed or approved. The content does not change."),
    tool("playout.cue", "playout", ToolEffect::Write, Scope::Cue, "ProgramArgs", "TakeCommitted", "Cue a published revision."),
    tool("playout.take", "playout", ToolEffect::Write, Scope::Take, "ProgramArgs", "TakeCommitted", "Take a published revision to Program."),
    tool("playout.clear", "playout", ToolEffect::Write, Scope::Clear, "ClearArgs", "TakeCommitted", "Clear Program."),
    tool("outputs.list", "outputs", ToolEffect::Read, Scope::Author, "()", "OutputList", "Adapters, status and reference lock."),
    tool("outputs.configure", "outputs", ToolEffect::Write, Scope::ConfigureOutput, "OutputConfig", "OutputState", "Configure an output. is_live applies."),
];

/// Build a descriptor. Exists so the table above reads as a table.
const fn tool(
    name: &'static str,
    group: &'static str,
    effect: ToolEffect,
    required_scope: Scope,
    input: &'static str,
    output: &'static str,
    summary: &'static str,
) -> ToolDescriptor {
    ToolDescriptor {
        name,
        group,
        effect,
        required_scope: Some(required_scope),
        input,
        output,
        summary,
    }
}

/// Look up and authorise tools.
pub struct ToolRegistry;

impl ToolRegistry {
    pub fn all() -> &'static [ToolDescriptor] {
        TOOLS
    }

    pub fn get(name: &str) -> Option<&'static ToolDescriptor> {
        TOOLS.iter().find(|tool| tool.name == name)
    }

    /// The single authorisation gate.
    ///
    /// Every call goes through here, so a tool cannot be reached by a caller
    /// that does not hold its scope — and because the requirement is declared
    /// on the descriptor rather than checked inside each handler, a new tool
    /// cannot be added without a scope decision being made.
    pub fn authorise(name: &str, held: &[Scope]) -> Result<&'static ToolDescriptor, Refusal> {
        let tool = Self::get(name).ok_or_else(|| Refusal::NotImplemented {
            what: format!("no MCP tool named {name}"),
        })?;
        match tool.required_scope {
            None => Ok(tool),
            Some(required) if held.contains(&required) => Ok(tool),
            Some(_) => Err(Refusal::Unauthenticated),
        }
    }

    /// The tools a role may reach, given a token carrying its full authority.
    ///
    /// Used by the exhaustive scope test and by an agent asking what it can do
    /// before it tries.
    pub fn reachable_by(role: Role) -> Vec<&'static ToolDescriptor> {
        let held: Vec<Scope> = ALL_SCOPES
            .iter()
            .copied()
            .filter(|scope| role.permits(*scope))
            .collect();
        TOOLS
            .iter()
            .filter(|tool| Self::authorise(tool.name, &held).is_ok())
            .collect()
    }
}

/// Every scope, so a caller can be built from a role without a hand list.
pub const ALL_SCOPES: &[Scope] = &[
    Scope::Author,
    Scope::Cue,
    Scope::Take,
    Scope::Clear,
    Scope::ConfigureOutput,
    Scope::Report,
];

/// The operator phases a motion preset may describe (G.6.3).
///
/// `MotionPhases` is a struct, so these are field names rather than enum
/// variants and cannot be derived the way the other vocabularies are. The test
/// below serialises a preset and asserts these are exactly its keys, so the
/// list cannot fall out of step with the type it describes.
pub const MOTION_PHASES: &[&str] = &["in", "out", "hold", "continue", "update"];

/// One enumerable value a tool accepts.
/// Emitted, never parsed here: the server produces this surface and an agent
/// consumes it, so it derives `Serialize` but not `Deserialize`. Owning every
/// string to satisfy a trait no caller on this side uses would cost an
/// allocation per field for nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnumSurface {
    /// The contract type's name.
    pub name: &'static str,
    /// Its values, as they appear on the wire.
    pub values: Vec<String>,
}

/// Everything an agent needs so it never has to guess (8.2, D.1 principle 2).
/// Emitted, never parsed here: the server produces this surface and an agent
/// consumes it, so it derives `Serialize` but not `Deserialize`. Owning every
/// string to satisfy a trait no caller on this side uses would cost an
/// allocation per field for nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySurface {
    pub schema_version: u32,
    pub protocol_version: u32,
    /// Every enumerable the tool surface accepts, derived from the enums
    /// themselves rather than restated.
    pub enums: Vec<EnumSurface>,
    /// Every refusal an agent may receive, by wire code. From
    /// [`Refusal::code_name`], so a new refusal appears here without anyone
    /// maintaining a list.
    pub refusals: Vec<&'static str>,
    pub tools: &'static [ToolDescriptor],
}

/// Serialise a unit enum value to its wire form.
///
/// Going through serde rather than formatting the variant name means the
/// surface reports exactly what the wire carries, including every
/// `rename_all` the type applies. A hand-written lowercase conversion would
/// be right until the first type that renames differently.
fn wire_names<T: Serialize>(values: &[T]) -> Vec<String> {
    values
        .iter()
        .map(|value| {
            serde_json::to_value(value)
                .ok()
                .and_then(|json| json.as_str().map(str::to_owned))
                .expect("a unit enum serialises to a string")
        })
        .collect()
}

/// The `tag` values of an internally-tagged enum.
///
/// `Stagger` and friends serialise to an object carrying a discriminator, not
/// to a bare string, so [`wire_names`] cannot read them. Pulling the tag out
/// of the serialised form keeps the same property: the surface reports what
/// the wire actually carries.
///
/// This is not a hypothetical precaution. `schema-mcp` previously advertised
/// the stagger modes by hand as `cap-total`, while the contract renames to
/// camelCase and emits `capTotal`. An agent that trusted the surface would
/// have sent a value the contract refuses — the exact failure build-plan 8.1
/// exists to prevent, found by deriving the list instead of restating it.
fn tag_names<T: Serialize>(values: &[T], tag: &str) -> Vec<String> {
    values
        .iter()
        .map(|value| {
            serde_json::to_value(value)
                .ok()
                .and_then(|json| json.get(tag)?.as_str().map(str::to_owned))
                .expect("an internally-tagged enum carries its discriminator")
        })
        .collect()
}

/// Build the capability surface.
pub fn capability_surface() -> CapabilitySurface {
    CapabilitySurface {
        schema_version: TOOL_SCHEMA_VERSION,
        protocol_version: crate::PROTOCOL_VERSION,
        enums: vec![
            EnumSurface {
                name: "BlendMode",
                values: wire_names(&BlendMode::ALL),
            },
            EnumSurface {
                name: "FitMode",
                values: wire_names(&FitMode::ALL),
            },
            EnumSurface {
                name: "CullMode",
                values: wire_names(&CullMode::ALL),
            },
            EnumSurface {
                name: "AlphaMode",
                values: wire_names(&AlphaMode::ALL),
            },
            EnumSurface {
                name: "DepthMode",
                values: wire_names(&DepthMode::ALL),
            },
            EnumSurface {
                name: "DeviceTier",
                values: wire_names(&[
                    DeviceTier::T0,
                    DeviceTier::T1,
                    DeviceTier::T2,
                    DeviceTier::T3,
                ]),
            },
            EnumSurface {
                name: "Locality",
                values: wire_names(&[Locality::CoLocated, Locality::Lan]),
            },
            EnumSurface {
                name: "ClockSource",
                values: wire_names(&[
                    ClockSource::Genlocked,
                    ClockSource::Ptp,
                    ClockSource::FreeRun,
                ]),
            },
            EnumSurface {
                name: "ReferenceState",
                values: wire_names(&[
                    ReferenceState::Locked,
                    ReferenceState::Unlocked,
                    ReferenceState::NotPresent,
                ]),
            },
            EnumSurface {
                name: "MediaCodec",
                values: wire_names(&[
                    MediaCodec::RawShared,
                    MediaCodec::Jpeg,
                    MediaCodec::H264,
                    MediaCodec::Hevc,
                ]),
            },
            EnumSurface {
                name: "Scope",
                values: wire_names(ALL_SCOPES),
            },
            EnumSurface {
                name: "Stagger",
                values: tag_names(
                    &[
                        Stagger::Fixed,
                        Stagger::CapTotal { max_total: 0.0 },
                        Stagger::Overlap,
                    ],
                    "mode",
                ),
            },
            EnumSurface {
                name: "MotionPhase",
                // G.6.3's operator phases. These are the field names of
                // `MotionPhases` rather than an enum, so they are stated here
                // — the one list in this module that is not derived, and it is
                // pinned by a test against the struct's own serialisation so
                // it cannot drift from it silently.
                values: MOTION_PHASES.iter().map(|s| (*s).to_owned()).collect(),
            },
        ],
        refusals: Refusal::all_variants()
            .iter()
            .map(Refusal::code_name)
            .collect(),
        tools: TOOLS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

#[test]
    fn the_motion_phase_list_matches_the_struct_it_describes() {
        // MOTION_PHASES is the one vocabulary here that is stated rather than
        // derived, because `MotionPhases` is a struct and its phases are field
        // names. Pinning it against the struct's own serialisation keeps it
        // honest: a phase added or renamed on the type fails here rather than
        // leaving the surface advertising a phase that does not exist.
        use crate::design_system::{DurationSpec, MotionPhase, MotionPhases};

        let phase = MotionPhase {
            duration: DurationSpec::Ms(0.0),
            channels: Vec::new(),
        };
        let phases = MotionPhases {
            r#in: phase.clone(),
            out: phase.clone(),
            hold: None,
            r#continue: Vec::new(),
            update: None,
        };

        let json = serde_json::to_value(&phases).expect("phases serialise");
        let keys: std::collections::BTreeSet<&str> =
            json.as_object().expect("an object").keys().map(String::as_str).collect();
        let declared: std::collections::BTreeSet<&str> = MOTION_PHASES.iter().copied().collect();

        assert_eq!(
            declared, keys,
            "MOTION_PHASES must name exactly the phases MotionPhases carries"
        );
    }

    #[test]
    fn the_stagger_modes_are_the_tags_the_wire_carries() {
        // The regression this pins: schema-mcp advertised `cap-total` by hand
        // while the contract emits `capTotal`, so an agent trusting the
        // surface sent a value the contract refuses.
        let surface = capability_surface();
        let stagger = surface
            .enums
            .iter()
            .find(|e| e.name == "Stagger")
            .expect("stagger modes are enumerable");
        assert!(stagger.values.contains(&"capTotal".to_string()));
        assert!(
            !stagger.values.contains(&"cap-total".to_string()),
            "the surface must report the wire tag, not a plausible spelling of it"
        );
    }

    #[test]
    fn every_tool_has_a_scope_decision() {
        // 8.13 depends on this: a tool whose scope was never decided would be
        // reachable by whoever happened to call it. Only the capability
        // surface is deliberately unscoped, because an agent must be able to
        // ask what it may do.
        for tool in TOOLS {
            if tool.required_scope.is_none() {
                assert_eq!(
                    tool.name, "system.capability",
                    "{} is unscoped; only capability discovery may be",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn an_author_token_can_never_reach_program_or_outputs() {
        // Part D.3's rule, stated as a test: "A design-scope token must never
        // reach playout.take or outputs.configure." The automation pipeline
        // runs as an author; a human takes things to air.
        let author = [Scope::Author];
        for forbidden in [
            "playout.cue",
            "playout.take",
            "playout.clear",
            "outputs.configure",
        ] {
            assert!(
                matches!(
                    ToolRegistry::authorise(forbidden, &author),
                    Err(Refusal::Unauthenticated)
                ),
                "{forbidden} must be unreachable with an author scope"
            );
        }
    }

    #[test]
    fn every_scope_violation_is_covered() {
        // 8.13's done-when, exhaustively rather than by sampling: every tool
        // against every scope it does not require. The loop is only possible
        // because the requirement is data.
        for tool in TOOLS {
            let Some(required) = tool.required_scope else {
                continue;
            };
            for held in ALL_SCOPES {
                let outcome = ToolRegistry::authorise(tool.name, std::slice::from_ref(held));
                if *held == required {
                    assert!(
                        outcome.is_ok(),
                        "{} must accept its own scope {held:?}",
                        tool.name
                    );
                } else {
                    assert!(
                        matches!(outcome, Err(Refusal::Unauthenticated)),
                        "{} accepted {held:?} but requires {required:?}",
                        tool.name
                    );
                }
            }
        }
    }

    #[test]
    fn an_editor_role_reaches_authoring_and_nothing_that_touches_program() {
        let reachable: Vec<_> = ToolRegistry::reachable_by(Role::Editor)
            .iter()
            .map(|tool| tool.name)
            .collect();

        assert!(reachable.contains(&"scenes.create"));
        assert!(reachable.contains(&"packages.publish"));
        assert!(
            !reachable.contains(&"playout.take"),
            "invariant 4: the Editor cannot change Program"
        );
        assert!(
            !reachable.contains(&"outputs.configure"),
            "invariant 4: the Editor cannot change outputs"
        );
    }

    #[test]
    fn a_playout_role_reaches_program_but_authors_nothing() {
        let reachable: Vec<_> = ToolRegistry::reachable_by(Role::Playout)
            .iter()
            .map(|tool| tool.name)
            .collect();

        assert!(reachable.contains(&"playout.take"));
        assert!(reachable.contains(&"outputs.configure"));
        assert!(
            !reachable.contains(&"scenes.create"),
            "invariant 5: Playout owns published operations, not authoring"
        );
    }

    #[test]
    fn capability_discovery_needs_no_scope_because_guessing_is_the_failure() {
        assert!(ToolRegistry::authorise("system.capability", &[]).is_ok());
    }

    #[test]
    fn an_unknown_tool_is_refused_by_name_rather_than_ignored() {
        assert!(matches!(
            ToolRegistry::authorise("scenes.obliterate", &[Scope::Author]),
            Err(Refusal::NotImplemented { .. })
        ));
    }

    #[test]
    fn the_capability_surface_reports_wire_values_not_variant_names() {
        // The surface must report what the wire carries. `BlendMode` renames
        // to kebab-case, so a hand-written lowercase conversion would be
        // wrong for `alpha-mask` and right for everything else — the worst
        // kind of nearly-correct.
        let surface = capability_surface();
        let blend = surface
            .enums
            .iter()
            .find(|e| e.name == "BlendMode")
            .expect("blend modes are enumerable");
        assert!(blend.values.contains(&"alpha-mask".to_string()));
        assert!(blend.values.contains(&"normal".to_string()));
    }

    #[test]
    fn the_capability_surface_lists_every_refusal_an_agent_could_receive() {
        let surface = capability_surface();
        assert_eq!(surface.refusals.len(), Refusal::all_variants().len());
        assert!(surface.refusals.contains(&"revisionMismatch"));
        assert!(surface.refusals.contains(&"projectNotFound"));
    }

    #[test]
    fn tool_names_are_unique_and_grouped_consistently() {
        let mut seen = std::collections::BTreeSet::new();
        for tool in TOOLS {
            assert!(seen.insert(tool.name), "{} is declared twice", tool.name);
            assert!(
                tool.name.starts_with(&format!("{}.", tool.group)),
                "{} does not belong to group {}",
                tool.name,
                tool.group
            );
        }
    }

    /// Write tools that are not authoring mutations, each with the reason it
    /// is allowed to name a non-`EditorCommand` input (11.36 guard R5).
    const R5_EXEMPT: &[(&str, &str)] = &[
        (
            "packages.build",
            "builds an immutable package artifact from a document and mutates no authoring content; \
             pointing it at the Editor store would make Playout read Editor projects",
        ),
        (
            "packages.publish",
            "publishes an already-built immutable package as a new revision; it changes no authoring \
             content, and publication is the Editor's whole authority over Program (invariant 7)",
        ),
    ];

    /// The groups whose writes are authoring content (D.2).
    const AUTHORING_GROUPS: &[&str] = &[
        "project",
        "scenes",
        "objects",
        "materials",
        "assets",
        "fonts",
        "animation",
        "bindings",
        "designsystem",
    ];

    #[test]
    fn every_authoring_write_tool_takes_an_editor_command_payload() {
        // R5 (11.36, invariant 60): an MCP write that changes authoring
        // content names an `EditorCommand` payload as its input, so it can
        // only reach the store through the one command executor. A write in
        // an authoring group, or any author-scoped write, counts; the only
        // exceptions are named above with their reasons.
        use crate::command::EditorCommand;

        for tool in TOOLS {
            if tool.effect != ToolEffect::Write {
                continue;
            }
            let authoring = AUTHORING_GROUPS.contains(&tool.group)
                || tool.required_scope == Some(Scope::Author);
            if !authoring || R5_EXEMPT.iter().any(|(name, _)| *name == tool.name) {
                continue;
            }
            assert!(
                EditorCommand::PAYLOAD_NAMES.contains(&tool.input),
                "{} writes authoring content but takes {}, which is not an EditorCommand payload",
                tool.name,
                tool.input
            );
        }
    }

    #[test]
    fn every_r5_exemption_names_a_declared_non_authoring_write() {
        // An exemption outliving its tool, or covering a tool in an authoring
        // group, would be a silent hole in R5.
        for (name, reason) in R5_EXEMPT {
            let tool = TOOLS
                .iter()
                .find(|tool| tool.name == *name)
                .unwrap_or_else(|| panic!("R5 exempts {name}, which is not declared"));
            assert_eq!(tool.effect, ToolEffect::Write, "{name} is exempt but not a write");
            assert!(
                !AUTHORING_GROUPS.contains(&tool.group),
                "{name} sits in authoring group {} and cannot be exempt",
                tool.group
            );
            assert!(!reason.trim().is_empty(), "{name} is exempt without a reason");
        }
    }

    #[test]
    fn the_editor_command_rows_keep_their_scopes() {
        // Invariant 65: moving writes onto command payloads must not move
        // them between scopes. Scene edits are an author's act; confirming a
        // brand pack is not (Part G).
        let scope_of = |name: &str| {
            TOOLS
                .iter()
                .find(|tool| tool.name == name)
                .unwrap_or_else(|| panic!("{name} is declared"))
                .required_scope
        };
        for name in ["project.create", "scenes.create", "scenes.delete", "scenes.edit"] {
            assert_eq!(scope_of(name), Some(Scope::Author), "{name}");
        }
        assert_eq!(scope_of("designsystem.commit"), Some(Scope::ConfigureOutput));
        assert_eq!(scope_of("designsystem.import"), Some(Scope::ConfigureOutput));
    }
}

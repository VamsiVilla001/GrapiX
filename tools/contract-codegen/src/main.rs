//! Generates `Shared/generated-ts` from the Rust contracts (invariant 22).
//!
//! This binary is what makes "Rust is the source of truth" operative rather
//! than aspirational. ADR-003 records hand-mirrored TypeScript and Rust types
//! as a known source of drift; the fix is that one side is generated and the
//! generated side is never edited (invariant 23).

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use gx_asset_plane::fonts::ingest::{FontDisposition, PreparedFontBatch, PreparedFontSource};
use gx_asset_plane::import::{AssetDisposition, AssetImportRefusal, PreparedAssetBatch, PreparedAssetSource};
use gx_contracts::provenance::{AssetApproval, AssetOrigin, AssetProvenance, LicenseClass, ProvenanceTool};
use gx_asset_plane::{AssetRef, PreflightRequest, PreflightResponse, TransferState};
use gx_contracts::animation::{
    ease_at, easing_control_points, AnimationSurface, CubicBezier, KeyRef, KeyframeChannel, SceneEasing,
    SceneKeyframe,
};
use gx_contracts::auth::{Role, Scope};
use gx_contracts::control::{ControlField, ControlFieldKind, ControlValue, TakePage};
use gx_contracts::color::{
    rec709_decode, rec709_encode, srgb_decode, srgb_encode, ColorValue, GradientCoordinateMode,
    GradientSpread, GradientStop, OutputTransform, Rgba, SourceColorSpace, WorkingColorSpace,
};
use gx_contracts::design_system::{
    DesignSystem, DesignSystemCommit, DesignSystemDraft, DesignSystemImport, DesignSystemSource,
    DesignSystemSourceKind, DesignSystemVersion, DesignSystemVersions, DraftVisualTokens,
    DriftEntry, DriftReport, DurationSpec, MotionChannel, MotionKey, MotionPhase, MotionPhases,
    MotionPreset, MotionTokens, NamedEasing, PresetParam, Provenance, Stagger, StampedTemplate,
    TokenMapping, TokenRef, UnexpressibleToken, VisualTokens,
};
use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
    FontStyle,
};
use gx_contracts::material::{
    AlphaMode, BlendMode, CullMode, DepthMode, FitMode, MaterialBinding, MaterialDefinition,
    MaterialKind, MaterialSupport, MaterialTextureSlot, TextureFiltering, TextureWrapMode,
};
use gx_contracts::mcp::{
    CapabilitySurface, EnumSurface, PreviewFrame, PreviewRequest, ScopeDenial, ToolDescriptor, ToolEffect,
    EmptyArgs, ProjectRef, SceneRef, PackageBuild, PackageBuildSource, PackageRef, ProgramArgs, ClearArgs,
};
use gx_contracts::import::{ImportEntry, ImportReport, ImportTier, Substitution};
use gx_contracts::package::{PackageFileEntry, PackageManifest};
use gx_contracts::authoring::{ObjectDeletion, ObjectDuplication};
use gx_contracts::text_style::{StyleColor, StyleNumber, TextStyle};
use gx_contracts::scene::{
    AssetAvailability, AssetKind, AssetLibraryItem, BezierPath, BrushBlendMode, BrushPoint,
    CameraKind, CameraObject, EllipseObject, FillRule, GroupObject, HierarchyChildren,
    HierarchyDiagnostic, HierarchyDiagnosticCode, HierarchyEdge, HierarchyResolution, ImageObject,
    LayerKind, LayerObject, LightKind, LightObject, LineObject, MarkerKind, MarkerObject,
    MeshObject, MeshPrimitiveKind, ObjectBase, PaintObject, PaintStroke, RectObject,
    ResolvedObject, SceneCanvas, SceneDocument, SceneObject, SceneTimeline, ShapeObject, SlabBevel,
    SlabProperties, TextAlign, TextAutoFit, TextCase, TextDecoration, TextDirection, TextLayout,
    TextObject, TextOverflow, Vec2, Vec3, VerticalAlign, WritingMode,
};
use gx_contracts::bindings::BindingIssue;
use gx_contracts::command::{
    ApplyPreset, ApplyTextStyle, CloseScene, CommandOutcome, ConfirmDesignSystem, CreateKeyframe,
    CreateObject, CreateProject, CreateScene, DeclareControl, DeleteMaterial, DeleteObject,
    DeleteScene, DuplicateObject, DuplicateScene, EditEffect, EditProperty, EditScene,
    EditorCommand, HistoryDirection, MoveKeyframe, OpenScene, PresetPhase, Redo, RemoveControl, RemoveKeyframe, RemovePhase,
    ReplaceControl, ReplaceDataContext, RelinkAsset, RelinkMaterial, RenameObject, SaveScene,
    SaveMotionPreset, SaveTakePage, SaveTarget, SaveTextStyle, SceneEdit, SceneOrigin, SceneSource, SceneTarget, SessionKey,
    SessionView, SetBinding, SetObjectField, SetObjectLocked, SetObjectVisible, SetPhase,
    SetSceneId, SetSceneName, Undo, UpdateKeyframe,
};
use gx_contracts::object_edit::ObjectField;
use gx_contracts::{
    ClockSource, ContentHash, DeviceTier, Epoch, Locality, MediaCodec, PublishedRevision,
    RationalRate, ReferenceState, Refusal, RefusalSeverity, ReviewRequest, ReviewState, Revision,
    StructuredRefusal, TakeId,
};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::sequence::{MessageId, MessageKind, Sequence};
use gx_control_plane::status::{
    ClockSummary, Degradation, EngineStatus, ProgramState, ReferenceTransition, Severity,
};
use gx_control_plane::{
    ClearRequest, CueRequest, EngineCapability, TakeAt, TakeCommitted, TakeRequest,
};
use gx_media_plane::{ConsumerRole, DropCounters, MediaProfile};
use ts_rs::TS;

/// Every root type that crosses a plane boundary. Adding a contract type
/// without adding it here means TypeScript never sees it, so this list is the
/// one place to look when a type is missing downstream.
macro_rules! export_all {
    ($dir:expr, $($ty:ty),+ $(,)?) => {{
        let mut count = 0usize;
        $(
            <$ty as TS>::export_all_to($dir)?;
            count += 1;
        )+
        count
    }};
}

const GENERATED_SCHEMA_COMMENT: &str =
    "GENERATED by gx-contract-codegen from gx-contracts::command. Do not edit (invariant 23).";

const DRAFT_2020_12_URI: &str = "https://json-schema.org/draft/2020-12/schema";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = workspace_root().join("Shared/generated-ts/src");
    std::fs::create_dir_all(&out)?;

    let count = export_all!(
        &out,
        // gx-contracts
        // gx-contracts: authorization (2.9)
        Role,
        Scope,
        TakeId,
        ContentHash,
        Revision,
        // published revisions and review (11.38)
        ReviewState,
        ReviewRequest,
        PublishedRevision,
        RationalRate,
        Locality,
        DeviceTier,
        ClockSource,
        ReferenceState,
        Refusal,
        RefusalSeverity,
        StructuredRefusal,
        Epoch,
        // gx-contracts: package manifest (1.8)
        PackageFileEntry,
        PackageManifest,
        // gx-contracts: fonts (A.4 port)
        FontFormat,
        EmbeddingPolicy,
        FontLoadStatus,
        FontSource,
        FontStyle,
        FontFaceDefinition,
        FontDefinition,
        // gx-contracts: colour (1.4)
        WorkingColorSpace,
        SourceColorSpace,
        OutputTransform,
        Rgba,
        GradientStop,
        GradientSpread,
        GradientCoordinateMode,
        ColorValue,
        // gx-contracts: materials, fit and blend (1.3)
        BlendMode,
        FitMode,
        CullMode,
        AlphaMode,
        DepthMode,
        TextureWrapMode,
        TextureFiltering,
        MaterialKind,
        MaterialTextureSlot,
        MaterialDefinition,
        MaterialBinding,
        MaterialSupport,
        // gx-contracts: scene document (1.1), object catalogue (1.2) and
        // asset library (1.7)
        AssetKind,
        AssetAvailability,
        AssetLibraryItem,
        // asset provenance (11.39)
        AssetProvenance,
        AssetOrigin,
        LicenseClass,
        ProvenanceTool,
        AssetApproval,
        SceneCanvas,
        SceneTimeline,
        // gx-contracts: editable scene animation (11.20)
        SceneEasing,
        AnimationSurface,
        CubicBezier,
        SceneKeyframe,
        KeyframeChannel,
        Vec2,
        Vec3,
        ObjectBase,
        ObjectDeletion,
        ObjectDuplication,
        TextLayout,
        TextAutoFit,
        WritingMode,
        VerticalAlign,
        TextDirection,
        TextCase,
        TextOverflow,
        TextAlign,
        TextDecoration,
        TextObject,
        RectObject,
        EllipseObject,
        ImageObject,
        LineObject,
        BezierPath,
        FillRule,
        ShapeObject,
        BrushPoint,
        BrushBlendMode,
        PaintStroke,
        PaintObject,
        MeshPrimitiveKind,
        SlabBevel,
        SlabProperties,
        MeshObject,
        LightKind,
        LightObject,
        CameraKind,
        CameraObject,
        LayerKind,
        LayerObject,
        MarkerKind,
        MarkerObject,
        GroupObject,
        SceneObject,
        SceneDocument,
        // gx-contracts: import pipeline report (7.2)
        ImportTier,
        Substitution,
        ImportEntry,
        ImportReport,
        // gx-contracts: typed Editor command model (11.36)
        SessionKey,
        SceneOrigin,
        SceneTarget,
        SceneSource,
        SaveTarget,
        PresetPhase,
        HistoryDirection,
        ObjectField,
        BindingIssue,
        EditorCommand,
        SceneEdit,
        OpenScene,
        CloseScene,
        EditScene,
        Undo,
        Redo,
        SaveScene,
        CreateProject,
        CreateScene,
        DuplicateScene,
        DeleteScene,
        SaveTakePage,
        ConfirmDesignSystem,
        SaveMotionPreset,
        KeyRef,
        CreateObject,
        DeleteObject,
        DuplicateObject,
        RenameObject,
        SetObjectField,
        SetObjectVisible,
        SetObjectLocked,
        EditProperty,
        CreateKeyframe,
        UpdateKeyframe,
        MoveKeyframe,
        RemoveKeyframe,
        ApplyPreset,
        SetPhase,
        RemovePhase,
        DeclareControl,
        RemoveControl,
        ReplaceControl,
        SaveTextStyle,
        ApplyTextStyle,
        SetBinding,
        ReplaceDataContext,
        RelinkMaterial,
        DeleteMaterial,
        RelinkAsset,
        SetSceneName,
        SetSceneId,
        EditEffect,
        SessionView,
        CommandOutcome,
        // gx-contracts: declared template controls (11.26)
        ControlFieldKind,
        ControlValue,
        ControlField,
        TakePage,
        // gx-contracts: named text styles (11.28)
        StyleNumber,
        StyleColor,
        TextStyle,
        // gx-contracts: hierarchy resolution (1.2)
        HierarchyDiagnosticCode,
        HierarchyDiagnostic,
        HierarchyEdge,
        HierarchyChildren,
        ResolvedObject,
        HierarchyResolution,
        // gx-contracts: the MCP automation surface (8.1). Generated like
        // everything else, so the tool schema an agent reads is the one the
        // server declares rather than a document maintained beside it.
        ToolEffect,
        ToolDescriptor,
        EnumSurface,
        CapabilitySurface,
        ScopeDenial,
        PreviewRequest,
        PreviewFrame,
        // gx-control-plane: intent
        TakeAt,
        TakeRequest,
        CueRequest,
        ClearRequest,
        TakeCommitted,
        EngineCapability,
        MediaCodec,
        // gx-control-plane: messages and delivery
        ClientRequest,
        EngineReply,
        EngineEvent,
        OutputConfig,
        MessageId,
        MessageKind,
        Sequence,
        // gx-control-plane: status
        EngineStatus,
        ProgramState,
        Degradation,
        Severity,
        ClockSummary,
        ReferenceTransition,
        // gx-asset-plane
        AssetRef,
        PreflightRequest,
        PreflightResponse,
        TransferState,
        // gx-asset-plane: font ingest (11.13)
        PreparedFontBatch,
        PreparedFontSource,
        FontDisposition,
        // gx-asset-plane: asset manager import (11.39)
        PreparedAssetBatch,
        PreparedAssetSource,
        AssetDisposition,
        AssetImportRefusal,
        // gx-media-plane
        ConsumerRole,
        MediaProfile,
        DropCounters,
        // gx-contracts: design system and motion (Part G)
        TokenRef,
        MotionTokens,
        NamedEasing,
        MotionPhases,
        MotionPhase,
        DurationSpec,
        MotionChannel,
        MotionKey,
        Stagger,
        MotionPreset,
        PresetParam,
        // Design-system ingest and review (Part G.2, build plan 10.1–10.3)
        DesignSystemSourceKind,
        DesignSystemSource,
        TokenMapping,
        UnexpressibleToken,
        DraftVisualTokens,
        DesignSystemDraft,
        // The active system itself. `designsystem.get` declares `DesignSystem`
        // as its output, so omitting these leaves the capability surface
        // naming a type no agent can resolve — which is the hand-mirrored
        // type invariant 22 forbids.
        VisualTokens,
        DesignSystem,
        DesignSystemCommit,
        DesignSystemImport,
        Provenance,
        DesignSystemVersion,
        DesignSystemVersions,
        StampedTemplate,
        DriftEntry,
        DriftReport,
    );

    write_command_schemas(&workspace_root())?;
    let mcp_schemas = workspace_root().join("Shared/generated-ts/schemas/mcp");
    std::fs::create_dir_all(&mcp_schemas)?;
    for tool in gx_contracts::mcp::ToolRegistry::all() {
        let schema = gx_contracts::mcp::input_schema(tool.input)?;
        let mut fields = vec![("$comment".to_owned(), schema["$comment"].clone())];
        fields.extend(schema.as_object().unwrap().iter()
            .filter(|(name, _)| name.as_str() != "$comment")
            .map(|(name, value)| (name.clone(), value.clone())));
        std::fs::write(mcp_schemas.join(format!("{}.schema.json", tool.name)),
            format_schema_document(fields)?)?;
    }
    export_all!(&out, EmptyArgs, ProjectRef, SceneRef, PackageBuild, PackageBuildSource, PackageRef, ProgramArgs, ClearArgs);
    write_capability_surface(&out)?;
    write_barrel(&out)?;
    write_transfer_reference(&workspace_root())?;
    write_easing_reference(&workspace_root())?;
    normalize_typescript_whitespace(&out)?;
    check_advertised_types_resolve(&out)?;
    println!("generated {count} contract types into {}", out.display());
    Ok(())
}

// ts-rs emits trailing spaces before inline field documentation. Keep the
// generated files reproducible and suitable for the repository's diff check.
fn normalize_typescript_whitespace(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            normalize_typescript_whitespace(&path)?;
        } else if path.extension().is_some_and(|ext| ext == "ts") {
            let text = std::fs::read_to_string(&path)?;
            let normalized = text
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n") + "\n";
            if text != normalized {
                std::fs::write(&path, normalized)?;
            }
        }
    }
    Ok(())
}

/// Emit the JSON Schemas for the editor command model (11.36, invariant 60).
///
/// The umbrella `EditorCommand` and `SceneEdit` schemas, plus one file per
/// named payload under `commands/` and `edits/`. A bare payload schema is not
/// the command on the wire: it lacks the tag, so the tag is injected as a
/// `const`, made required, and the root closed with `additionalProperties:
/// false`. The directory is deleted and rewritten on every run, so a schema
/// whose command was removed disappears and codegen:check reports it.
fn write_command_schemas(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let schemas = root.join("Shared/generated-ts/schemas");
    if schemas.exists() {
        std::fs::remove_dir_all(&schemas)?;
    }
    let commands = schemas.join("commands");
    let edits = schemas.join("edits");
    std::fs::create_dir_all(&commands)?;
    std::fs::create_dir_all(&edits)?;

    write_schema(
        &schemas.join("EditorCommand.schema.json"),
        command_schema::<EditorCommand>(),
        "urn:grapix:schema:EditorCommand",
        "EditorCommand",
        None,
    )?;
    write_schema(
        &schemas.join("SceneEdit.schema.json"),
        command_schema::<SceneEdit>(),
        "urn:grapix:schema:SceneEdit",
        "SceneEdit",
        None,
    )?;
    // 3.22: the typed effect registry, so a validator outside Rust reads the
    // same effect vocabulary and parameter types the engine draws.
    write_schema(
        &schemas.join("EffectInstance.schema.json"),
        command_schema::<gx_contracts::effect::EffectInstance>(),
        "urn:grapix:schema:EffectInstance",
        "EffectInstance",
        None,
    )?;

    write_payload_schemas(
        &commands,
        "commands",
        EditorCommand::PAYLOAD_NAMES,
        |write| EditorCommand::for_each_payload_schema(write),
        "command",
    )?;
    write_payload_schemas(
        &edits,
        "edits",
        SceneEdit::PAYLOAD_NAMES,
        |write| SceneEdit::for_each_payload_schema(write),
        "edit",
    )?;
    Ok(())
}

fn command_schema<T: schemars::JsonSchema>() -> schemars::Schema {
    schemars::generate::SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>()
}

fn write_payload_schemas(
    dir: &Path,
    category: &str,
    expected_names: &[&str],
    emit: impl FnOnce(&mut dyn FnMut(&'static str, &'static str, schemars::Schema)),
    tag_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut emitted = Vec::new();
    let mut result = Ok(());
    let mut write = |payload: &'static str, tag: &'static str, schema: schemars::Schema| {
        emitted.push(payload.to_owned());
        if result.is_ok() {
            result = write_schema(
                &dir.join(format!("{payload}.schema.json")),
                schema,
                &format!("urn:grapix:schema:{category}:{payload}"),
                payload,
                Some((tag_name, tag)),
            );
        }
    };
    emit(&mut write);
    result?;

    let mut expected: Vec<_> = expected_names.iter().map(|name| (*name).to_owned()).collect();
    expected.sort_unstable();
    emitted.sort_unstable();
    if emitted != expected {
        return Err(format!(
            "{category} schema payload names differ from the command contract: expected {expected:?}, emitted {emitted:?}"
        )
        .into());
    }
    Ok(())
}

fn write_schema(
    path: &Path,
    schema: schemars::Schema,
    id: &str,
    title: &str,
    tag: Option<(&str, &str)>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut document = serde_json::to_value(schema)?;
    let object = match document.as_object_mut() {
        Some(object) => object,
        None => return Err(format!("schema for {title} is not a JSON object").into()),
    };

    if let Some((tag_name, tag_value)) = tag {
        let properties = match object
            .entry("properties")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            .as_object_mut()
        {
            Some(properties) => properties,
            None => return Err(format!("payload schema for {title} has non-object properties").into()),
        };
        properties.insert(
            tag_name.to_owned(),
            serde_json::json!({ "const": tag_value }),
        );

        let required = match object
            .entry("required")
            .or_insert_with(|| serde_json::Value::Array(Vec::new()))
            .as_array_mut()
        {
            Some(required) => required,
            None => return Err(format!("payload schema for {title} has non-array required").into()),
        };
        if !required
            .iter()
            .any(|value| value.as_str() == Some(tag_name))
        {
            required.push(serde_json::Value::String(tag_name.to_owned()));
        }
        object.insert("additionalProperties".to_owned(), serde_json::Value::Bool(false));
    }

    object.remove("$schema");
    object.remove("$id");
    let schema = serde_json::Value::String(DRAFT_2020_12_URI.to_owned());
    let title = object
        .remove("title")
        .unwrap_or_else(|| serde_json::Value::String(title.to_owned()));

    let mut fields = vec![
        ("$comment".to_owned(), serde_json::Value::String(GENERATED_SCHEMA_COMMENT.to_owned())),
        ("$schema".to_owned(), schema),
        ("$id".to_owned(), serde_json::Value::String(id.to_owned())),
        ("title".to_owned(), title),
    ];
    fields.extend(std::mem::take(object));
    std::fs::write(path, format_schema_document(fields)?)?;
    Ok(())
}

fn format_schema_document(
    fields: Vec<(String, serde_json::Value)>,
) -> Result<String, serde_json::Error> {
    let field_count = fields.len();
    let mut document = String::from("{\n");
    for (index, (key, value)) in fields.into_iter().enumerate() {
        let rendered = serde_json::to_string_pretty(&value)?.replace('\n', "\n  ");
        document.push_str("  ");
        document.push_str(&serde_json::to_string(&key)?);
        document.push_str(": ");
        document.push_str(&rendered);
        if index + 1 < field_count {
            document.push(',');
        }
        document.push('\n');
    }
    document.push_str("}\n");
    Ok(document)
}

/// Every type name the tool registry advertises must be a type an agent can
/// actually resolve.
///
/// `mcp.rs` promises that a tool's `input`/`output` names resolve against the
/// generated types, so the schema is never written twice (invariant 22). That
/// promise is only true if the name exists: `designsystem.get` advertised
/// `DesignSystem` while the export list omitted it, so the one consumer that
/// trusted the surface had no type to import and would have hand-written one.
///
/// The staleness gate could not catch it — it compares generated output against
/// the export list, never the export list against what the registry claims. So
/// the check belongs here, where both sides are in scope, and it fails the
/// build rather than reporting a warning nobody reads.
fn check_advertised_types_resolve(dir: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    // Shapes that are not contract types: the unit input, and the primitives a
    // tool may name directly.
    const NOT_A_CONTRACT_TYPE: &[&str] = &["()", "String", "bool", "u32", "u64", "f64"];

    // Names the registry already advertised without a contract type behind
    // them, recorded when this gate was added. Each is an argument or result
    // shape that exists only as a local struct inside a handler crate, so
    // there is nothing for the export list to export yet: moving them into
    // `Shared/contracts` is Phase 8's work, not this gate's.
    //
    // This list may only shrink. It is a ratchet, not an exemption: a *new*
    // unresolved name fails the build, which is what stops the next tool from
    // advertising a type no agent can resolve. Deleting an entry here after
    // moving its type into contracts is the intended direction of travel.
    const KNOWN_UNBACKED: &[&str] = &[
        "AssetList",
        "BindingSchema",
        "FontList",
        "LibraryList",
        "MaterialList",
        "ObjectList",
        "OutputList",
        "OutputState",
        "PreflightReport",
        "ProjectList",
        "PublishResult",
        "SceneList",
    ];

    let mut missing: Vec<String> = Vec::new();
    let mut resolved_debt: Vec<&str> = Vec::new();
    for tool in gx_contracts::mcp::ToolRegistry::all() {
        for advertised in [tool.input, tool.output] {
            if NOT_A_CONTRACT_TYPE.contains(&advertised) {
                continue;
            }
            let exists = dir.join(format!("{advertised}.ts")).exists();
            let known = KNOWN_UNBACKED.contains(&advertised);
            if exists && known {
                resolved_debt.push(advertised);
            } else if !exists && !known {
                missing.push(format!("{} advertises {advertised}", tool.name));
            }
        }
    }

    if !resolved_debt.is_empty() {
        // The ratchet only tightens. A name that now resolves must leave the
        // list, or the list stops describing the debt it claims to track.
        resolved_debt.sort_unstable();
        resolved_debt.dedup();
        return Err(format!(
            "{} advertised type(s) now resolve and must be removed from \
             KNOWN_UNBACKED in this file: {}",
            resolved_debt.len(),
            resolved_debt.join(", ")
        )
        .into());
    }

    if missing.is_empty() {
        return Ok(());
    }
    missing.sort();
    missing.dedup();
    Err(format!(
        "the tool registry advertises {} type name(s) with no generated type. \
         Add the type to the export list in this file, or move it into \
         `Shared/contracts` first:\n  {}",
        missing.len(),
        missing.join("\n  ")
    )
    .into())
}

/// Generate the cross-language colour-transfer reference from the Rust
/// implementation that owns the curves (11.4, invariant 27).
///
/// Keeping this in the normal codegen binary matters: a one-shot helper made
/// `cargo run -p gx-contract-codegen` ambiguous and broke the repository gate.
/// The checked-in TypeScript table now changes whenever normal codegen runs.
fn write_transfer_reference(root: &std::path::Path) -> std::io::Result<()> {
    const STEPS: &[f64] = &[
        0.0,
        0.001,
        0.003_130_8,
        0.005,
        0.018,
        0.040_449_936_474_468_28,
        0.081,
        0.1,
        0.18,
        0.25,
        0.5,
        0.75,
        0.9,
        0.99,
        1.0,
    ];

    let mut body = String::from(
        "// GENERATED from gx-contracts::color by gx-contract-codegen.\n\
         // Do not edit. Regenerate with `npm run codegen` (11.4, invariant 27).\n\
         export const TRANSFER_REFERENCE = [\n",
    );
    for &value in STEPS {
        body.push_str(&format!(
            "  {{ x: {value:?}, srgbEncode: {:?}, srgbDecode: {:?}, \
             rec709Encode: {:?}, rec709Decode: {:?} }},\n",
            srgb_encode(value),
            srgb_decode(value),
            rec709_encode(value),
            rec709_decode(value),
        ));
    }
    body.push_str("] as const;\n");
    std::fs::write(root.join("Editor/src/transfer-reference.ts"), body)
}

/// Generate the cross-language easing reference from the Rust evaluator that
/// owns the curves (11.11, invariant 27).
///
/// Same argument as the colour transfer table above, for the same reason: the
/// speed graph has to draw the curve the engine will render, and a browser
/// cannot call Rust once per pixel. So the solve is mirrored in TypeScript and
/// pinned here — an easing changed on one side and not the other fails the
/// gate in the same run rather than shipping a preview that lies about what
/// goes to air.
fn write_easing_reference(root: &std::path::Path) -> std::io::Result<()> {
    const STEPS: &[f64] = &[
        0.0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1.0,
    ];
    /// An overshooting curve, deliberately: y outside 0–1 is legal and the
    /// mirror must reproduce it rather than clamping.
    const CUSTOM: CubicBezier = CubicBezier {
        x1: 0.34,
        y1: 1.56,
        x2: 0.64,
        y2: 1.0,
    };

    // Wire names through serde rather than formatting the variant, so the
    // table reports exactly what the contract renames them to.
    let wire = |easing: SceneEasing| -> String {
        serde_json::to_value(easing)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .expect("SceneEasing serialises to a string")
    };

    let mut body = String::from(
        "// GENERATED from gx-contracts::animation by gx-contract-codegen.\n\
         // Do not edit. Regenerate with `npm run codegen` (11.11, invariant 27).\n\
         export const EASING_REFERENCE = [\n",
    );
    for easing in SceneEasing::ALL {
        if *easing == SceneEasing::CustomBezier {
            continue;
        }
        for &t in STEPS {
            body.push_str(&format!(
                "  {{ easing: {:?}, t: {t:?}, y: {:?} }},\n",
                wire(*easing),
                ease_at(*easing, None, t).expect("a named easing always has a curve"),
            ));
        }
    }
    body.push_str("] as const;\n\nexport const CUSTOM_BEZIER_REFERENCE = {\n");
    body.push_str(&format!(
        "  points: {{ x1: {:?}, y1: {:?}, x2: {:?}, y2: {:?} }},\n  samples: [\n",
        CUSTOM.x1, CUSTOM.y1, CUSTOM.x2, CUSTOM.y2
    ));
    for &t in STEPS {
        body.push_str(&format!(
            "    {{ t: {t:?}, y: {:?} }},\n",
            ease_at(SceneEasing::CustomBezier, Some(CUSTOM), t)
                .expect("a custom easing with points always has a curve"),
        ));
    }
    body.push_str("  ],\n} as const;\n\nexport const NAMED_EASING_POINTS = {\n");
    for easing in SceneEasing::ALL {
        if *easing == SceneEasing::CustomBezier {
            continue;
        }
        let points = easing_control_points(*easing);
        body.push_str(&format!(
            "  {:?}: {{ x1: {:?}, y1: {:?}, x2: {:?}, y2: {:?} }},\n",
            wire(*easing),
            points.x1,
            points.y1,
            points.x2,
            points.y2
        ));
    }
    body.push_str("} as const;\n");
    std::fs::write(root.join("Editor/src/easing-reference.ts"), body)
}

/// Emit the capability surface as *data*, not just as a type.
///
/// This is what makes 8.1's "no hand-written schema" true rather than nearly
/// true. Generating the types alone still left every consumer to write out the
/// runtime values — `schema-mcp` kept four such lists, each guarded by a
/// compile-time assertion, which is a good guard against a problem that should
/// not exist. The values come from the contracts here, so there is nothing to
/// keep in step.
fn write_capability_surface(dir: &std::path::Path) -> std::io::Result<()> {
    let surface = gx_contracts::mcp::capability_surface();
    let json = serde_json::to_string_pretty(&surface).map_err(std::io::Error::other)?;
    let body = format!(
        "// GENERATED by gx-contract-codegen. Do not edit (invariant 23).\n\
         // Regenerate with `npm run codegen`.\n\
         //\n\
         // The capability surface as data (build plan 8.1, 8.2). An agent reads\n\
         // this to learn every supported enum, refusal code and tool before it\n\
         // asks for anything, so it never has to guess (ADR-0002 D.1).\n\n\
         import type {{ CapabilitySurface }} from \"./CapabilitySurface.js\";\n\n\
         export const CAPABILITY_SURFACE: CapabilitySurface = {json} as const;\n"
    );
    std::fs::write(dir.join("capability-surface.ts"), body)
}

/// Writes `index.ts` re-exporting every generated declaration, so consumers
/// import from one place and a renamed type breaks the build loudly.
fn write_barrel(dir: &std::path::Path) -> std::io::Result<()> {
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".ts")?.to_string();
            (stem != "index").then_some(stem)
        })
        .collect();
    names.sort();

    let mut body = String::from(
        "// GENERATED by gx-contract-codegen. Do not edit (invariant 23).\n\
         // Regenerate with `npm run codegen`.\n\n",
    );
    for name in &names {
        // `.js` rather than extensionless: TypeScript resolves the specifier
        // back to the `.ts` source, while Node's ESM loader requires the
        // extension on the compiled output. Emitting it keeps one barrel
        // usable from both the typechecker and the runtime.
        body.push_str(&format!("export * from \"./{name}.js\";\n"));
    }
    std::fs::write(dir.join("index.ts"), body)
}

/// The workspace root, derived from this crate's manifest directory rather
/// than from the current working directory, so the output lands in the same
/// place however the binary is invoked.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate lives two levels below the workspace root")
        .to_path_buf()
}

#[cfg(test)]
mod schema_tests {
    #[test]
    fn every_mcp_tool_has_a_valid_object_schema() {
        for tool in gx_contracts::mcp::ToolRegistry::all() {
            let schema = gx_contracts::mcp::input_schema(tool.input).unwrap();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            let validator = jsonschema::validator_for(&schema).unwrap();
            assert!(!validator.is_valid(&serde_json::json!([])), "{}", tool.name);
            assert!(!validator.is_valid(&serde_json::json!({"unexpected": true})), "{}", tool.name);
        }
    }

    #[test]
    fn package_build_schema_accepts_the_real_scene_contract_and_rejects_a_broken_scene() {
        let schema = gx_contracts::mcp::input_schema("PackageBuild").unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let args = gx_contracts::mcp::PackageBuild {
            output: "news.gpxpkg".into(),
            scene: gx_contracts::scene::new_scene("score", "Score", gx_contracts::color::WorkingColorSpace::NEW_PROJECT),
            sources: Vec::new(),
            design_system_version: None,
        };
        let mut value = serde_json::to_value(args).unwrap();
        assert!(validator.is_valid(&value));
        value["scene"]["canvas"]["width"] = serde_json::json!("wide");
        assert!(!validator.is_valid(&value));
    }

    use std::collections::BTreeSet;

    use super::*;

    fn validator(path: &Path) -> jsonschema::Validator {
        let text = std::fs::read_to_string(path).unwrap();
        // The generated header must land inside the 200-character window the
        // boundary guard reads (R7), whatever serde_json's key order is.
        assert!(
            text.starts_with(&format!("{{\n  \"$comment\": \"{GENERATED_SCHEMA_COMMENT}\"")),
            "{} does not open with its generated $comment",
            path.display()
        );
        let schema = serde_json::from_str(&text).unwrap();
        jsonschema::validator_for(&schema).unwrap()
    }

    fn payload_name(names: &[&'static str], payloads: &[&'static str], name: &str) -> &'static str {
        let index = names.iter().position(|candidate| *candidate == name).unwrap();
        payloads[index]
    }

    fn with_unexpected_key(value: &serde_json::Value) -> serde_json::Value {
        let mut unexpected = value.clone();
        unexpected
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
        unexpected
    }

    #[test]
    fn every_witness_matches_its_schemas_and_an_unknown_key_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "gx-contract-codegen-schema-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        write_command_schemas(&root).unwrap();
        let schemas = root.join("Shared/generated-ts/schemas");
        let command_umbrella = validator(&schemas.join("EditorCommand.schema.json"));
        let edit_umbrella = validator(&schemas.join("SceneEdit.schema.json"));
        let mut commands_seen = BTreeSet::new();
        let mut edits_seen = BTreeSet::new();

        for command in gx_contracts::command::witness::every_command(&root.join("witness")) {
            let value = serde_json::to_value(&command).unwrap();
            assert!(command_umbrella.is_valid(&value), "EditorCommand rejected {}", command.name());
            let payload = payload_name(EditorCommand::NAMES, EditorCommand::PAYLOAD_NAMES, command.name());
            let schema = validator(&schemas.join("commands").join(format!("{payload}.schema.json")));
            assert!(schema.is_valid(&value), "commands/{payload} rejected its witness");
            assert!(
                !schema.is_valid(&with_unexpected_key(&value)),
                "commands/{payload} accepted an unknown top-level key"
            );
            commands_seen.insert(payload);

            if let EditorCommand::EditScene(edit) = command {
                for scene_edit in edit.edits {
                    let value = serde_json::to_value(&scene_edit).unwrap();
                    assert!(edit_umbrella.is_valid(&value), "SceneEdit rejected {}", scene_edit.name());
                    let payload = payload_name(SceneEdit::NAMES, SceneEdit::PAYLOAD_NAMES, scene_edit.name());
                    let schema = validator(&schemas.join("edits").join(format!("{payload}.schema.json")));
                    assert!(schema.is_valid(&value), "edits/{payload} rejected its witness");
                    assert!(
                        !schema.is_valid(&with_unexpected_key(&value)),
                        "edits/{payload} accepted an unknown top-level key"
                    );
                    edits_seen.insert(payload);
                }
            }
        }

        // Every emitted per-command file was exercised by a witness.
        assert_eq!(commands_seen, EditorCommand::PAYLOAD_NAMES.iter().copied().collect());
        assert_eq!(edits_seen, SceneEdit::PAYLOAD_NAMES.iter().copied().collect());
        std::fs::remove_dir_all(root).unwrap();
    }
}

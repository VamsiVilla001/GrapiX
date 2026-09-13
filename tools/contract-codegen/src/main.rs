//! Generates `Shared/generated-ts` from the Rust contracts (invariant 22).
//!
//! This binary is what makes "Rust is the source of truth" operative rather
//! than aspirational. ADR-003 records hand-mirrored TypeScript and Rust types
//! as a known source of drift; the fix is that one side is generated and the
//! generated side is never edited (invariant 23).

#![forbid(unsafe_code)]

use std::path::PathBuf;

use gx_asset_plane::{AssetRef, PreflightRequest, PreflightResponse, TransferState};
use gx_contracts::animation::{
    ease_at, easing_control_points, AnimationSurface, CubicBezier, KeyframeChannel, SceneEasing,
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
use gx_contracts::mcp::{CapabilitySurface, EnumSurface, ScopeDenial, ToolDescriptor, ToolEffect};
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
use gx_contracts::{
    ClockSource, ContentHash, DeviceTier, Epoch, Locality, MediaCodec, RationalRate,
    ReferenceState, Refusal, RefusalSeverity, Revision, StructuredRefusal, TakeId,
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

    write_capability_surface(&out)?;
    write_barrel(&out)?;
    write_transfer_reference(&workspace_root())?;
    write_easing_reference(&workspace_root())?;
    check_advertised_types_resolve(&out)?;
    println!("generated {count} contract types into {}", out.display());
    Ok(())
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
        "ApplyPreset",
        "AssetList",
        "AssetRelink",
        "BindingSchema",
        "FontList",
        "LibraryList",
        "MaterialAssign",
        "MaterialList",
        "ObjectList",
        "ObjectUpdate",
        "OutputList",
        "OutputState",
        "PackageBuild",
        "PackagePublish",
        "PackageRef",
        "PreflightReport",
        "PreviewFrame",
        "PreviewRequest",
        "ProjectCreate",
        "ProjectList",
        "ProjectRef",
        "PublishResult",
        "SceneCreate",
        "SceneList",
        "SceneRef",
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
                ease_at(*easing, None, t),
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
            ease_at(SceneEasing::CustomBezier, Some(CUSTOM), t),
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

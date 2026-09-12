//! Generates `Shared/generated-ts` from the Rust contracts (invariant 22).
//!
//! This binary is what makes "Rust is the source of truth" operative rather
//! than aspirational. ADR-003 records hand-mirrored TypeScript and Rust types
//! as a known source of drift; the fix is that one side is generated and the
//! generated side is never edited (invariant 23).

#![forbid(unsafe_code)]

use std::path::PathBuf;

use gx_asset_plane::{AssetRef, PreflightRequest, PreflightResponse, TransferState};
use gx_contracts::auth::{Role, Scope};
use gx_contracts::color::{
    ColorValue, GradientCoordinateMode, GradientSpread, GradientStop, OutputTransform, Rgba,
    SourceColorSpace, WorkingColorSpace,
};
use gx_contracts::design_system::{
    DurationSpec, MotionChannel, MotionKey, MotionPhase, MotionPhases, MotionPreset, MotionTokens,
    NamedEasing, PresetParam, Stagger, TokenRef,
};
use gx_contracts::font::{
    EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource,
    FontStyle,
};
use gx_contracts::material::{
    AlphaMode, BlendMode, CullMode, DepthMode, FitMode, MaterialBinding, MaterialDefinition,
    MaterialKind, MaterialSupport, MaterialTextureSlot, TextureFiltering, TextureWrapMode,
};
use gx_contracts::package::{PackageFileEntry, PackageManifest};
use gx_contracts::mcp::{CapabilitySurface, EnumSurface, ScopeDenial, ToolDescriptor, ToolEffect};
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
        Vec2,
        Vec3,
        ObjectBase,
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
    );

    write_capability_surface(&out)?;
    write_barrel(&out)?;
    println!("generated {count} contract types into {}", out.display());
    Ok(())
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

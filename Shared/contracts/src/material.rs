//! The material model, and the fit and blend vocabularies (build plan 1.3).
//!
//! 1.3 exists because 1.x had these words written down more than once. Fit was
//! `ImageSceneObject.objectFit` (`cover | contain | stretch`) *and*
//! `TextureFitMode` (`stretch | fit | fill | crop | tile | original |
//! pixel-perfect | nine-slice`), with `fit` and `contain` naming the same
//! behaviour and `fill` and `cover` naming another. Blend was a list in the
//! shared types, a mapping table in each renderer, and a bare string on the
//! wire. Two vocabularies for one idea is how `overlay` came to alias
//! `screen` in a live product: one side had a mode the other had never heard
//! of, and the nearest match won silently. That is the recorded example
//! behind invariant 18, and this module is the fix — **one enum per idea, and
//! the string form is gone from the refusal too.**
//!
//! What is *supported* is deliberately not a constant here. A mode either is
//! or is not expressible as fixed-function GPU blending — a fact about the
//! mode's mathematics, recorded on the enum — but whether a given engine can
//! actually draw it is a property of that engine, declared in its capability
//! exchange and never inferred from a build flag (invariant 21). So the three
//! consumers 1.3 names all read the same enum from here: the engine declares
//! the subset it supports, the validator refuses anything outside that subset
//! by name and with the allowed list, and the UI maps exactly the subset it
//! can draw.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::{ColorValue, Rgba, SourceColorSpace};
use crate::scene::{AssetKind, AssetLibraryItem, SceneDocument};
use crate::{Refusal, StructuredRefusal};

/// Every blend mode the authoring vocabulary contains, supported or not.
///
/// Carried across from 1.x `MATERIAL_BLEND_MODES` unchanged, because a scene
/// authored there must mean the same thing here.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    #[default]
    Normal,
    Add,
    Multiply,
    Screen,
    /// The recorded live fault: 1.x's browser renderer had no `overlay`, so
    /// it drew `screen` instead and nobody was told. It is in the vocabulary
    /// because authors use it; it is not fixed-function, so an engine without
    /// a shader compositing path must refuse it (invariant 18).
    Overlay,
    Darken,
    Lighten,
    Subtract,
    AlphaMask,
    InverseAlphaMask,
}

impl BlendMode {
    /// The whole authoring vocabulary, in declaration order.
    ///
    /// A constant rather than a hand-written list at each call site: a mode
    /// added to the enum appears here, and in every capability declaration
    /// and validator built from it, without anyone remembering a second list.
    pub const ALL: [BlendMode; 10] = [
        BlendMode::Normal,
        BlendMode::Add,
        BlendMode::Multiply,
        BlendMode::Screen,
        BlendMode::Overlay,
        BlendMode::Darken,
        BlendMode::Lighten,
        BlendMode::Subtract,
        BlendMode::AlphaMask,
        BlendMode::InverseAlphaMask,
    ];

    /// Whether this mode is expressible with fixed-function GPU blend
    /// factors.
    ///
    /// A property of the mode's mathematics, not of any renderer: these six
    /// are a source/destination factor pair, and the other four must read the
    /// destination in a shader. Recorded here so a capability declaration has
    /// something to be checked against, and so "we support overlay" cannot be
    /// claimed by a backend that only has fixed-function blending.
    pub const fn is_fixed_function(self) -> bool {
        matches!(
            self,
            BlendMode::Normal
                | BlendMode::Add
                | BlendMode::Multiply
                | BlendMode::Screen
                | BlendMode::Darken
                | BlendMode::Lighten
        )
    }
}

/// How texture content is mapped into the box it is drawn in.
///
/// One vocabulary, merged from 1.x's two: `contain` is the mode its texture
/// enum called `fit`, and `cover` is the one it called `fill`. The names kept
/// are CSS's, because that is the vocabulary designers hand work over in.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "kebab-case")]
pub enum FitMode {
    /// Fill the box exactly, changing the aspect ratio.
    Stretch,
    /// Fit inside the box, preserving aspect ratio; may letterbox.
    #[default]
    Contain,
    /// Cover the box, preserving aspect ratio; may crop.
    Cover,
    /// Draw at native size, cropped to the box.
    Crop,
    /// Repeat to fill the box.
    Tile,
    /// Draw at native size, uncropped, overflowing if it does not fit.
    Original,
    /// One texel to one output pixel, unfiltered.
    PixelPerfect,
    /// Nine-slice scaling: corners fixed, edges and centre stretched.
    NineSlice,
}

impl FitMode {
    pub const ALL: [FitMode; 8] = [
        FitMode::Stretch,
        FitMode::Contain,
        FitMode::Cover,
        FitMode::Crop,
        FitMode::Tile,
        FitMode::Original,
        FitMode::PixelPerfect,
        FitMode::NineSlice,
    ];

    /// Whether the mode is a plain UV transform on a quad, needing no extra
    /// geometry and no sampler change. Nine-slice needs geometry;
    /// pixel-perfect needs a nearest sampler and a snap to the pixel grid.
    pub const fn is_uv_transform(self) -> bool {
        matches!(
            self,
            FitMode::Stretch
                | FitMode::Contain
                | FitMode::Cover
                | FitMode::Crop
                | FitMode::Tile
                | FitMode::Original
        )
    }
}

/// Which faces are drawn. Carried from 1.x `MaterialCullMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CullMode {
    None,
    Front,
    #[default]
    Back,
}

impl CullMode {
    pub const ALL: [CullMode; 3] = [CullMode::None, CullMode::Front, CullMode::Back];
}

/// How alpha is interpreted. Straight and premultiplied are different images,
/// and guessing between them is a visible halo on every soft edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AlphaMode {
    Opaque,
    #[default]
    Straight,
    Premultiplied,
    AlphaTest,
}

impl AlphaMode {
    pub const ALL: [AlphaMode; 4] = [
        AlphaMode::Opaque,
        AlphaMode::Straight,
        AlphaMode::Premultiplied,
        AlphaMode::AlphaTest,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DepthMode {
    Disabled,
    Read,
    #[default]
    ReadWrite,
}

impl DepthMode {
    pub const ALL: [DepthMode; 3] = [DepthMode::Disabled, DepthMode::Read, DepthMode::ReadWrite];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TextureWrapMode {
    #[default]
    Clamp,
    Repeat,
    MirrorRepeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TextureFiltering {
    Nearest,
    #[default]
    Linear,
}

/// What a material fundamentally is.
///
/// 1.x carried fifteen values here, ten of which its loader rewrote to `pbr`
/// on the way in — load-only compatibility aliases for a format 2.0 does not
/// read. Only the kinds that behave differently are carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MaterialKind {
    /// A flat colour or gradient, unlit.
    SolidColor,
    /// A still image.
    Image,
    /// A moving image; the frame is chosen by the timeline, not by the
    /// material.
    Video,
    /// Physically based, lit by the scene's lights.
    #[default]
    Pbr,
    /// Unlit textured — what a lower third's background actually wants.
    Unlit,
    /// A custom shader, identified by id.
    Shader,
}

/// Whether a material shades with the scene's lights.
///
/// This is the split every broadcast authoring tool puts in front of the
/// author first — a "2D material" and a "3D material" are different things to
/// pick, not different values of one slider — and it is **derived from the
/// kind, never stored beside it**. A stored dimension would be a second
/// representation of a fact the kind already carries, and the two would
/// disagree the first time one was edited without the other: a material
/// labelled 2D in the library and lit by the engine is the silent
/// substitution invariant 18 exists to stop.
///
/// The engine already draws this line at exactly this place. `prepare_meshes`
/// refuses a mesh bound to a `Pbr` material when the scene has no light
/// (`MeshMaterialRequiresLight`), and refuses a light with no `Pbr` material
/// to respond to it. So "lit" is not a new idea introduced by the UI; it is
/// the one the renderer already enforces, given a name the author can see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum MaterialDimension {
    /// Flat: colour and textures, unaffected by scene lights.
    TwoD,
    /// Lit: responds to the scene's lights and carries surface response.
    ThreeD,
}

impl MaterialKind {
    /// The whole vocabulary, in the order a "new material" menu should offer
    /// it. A constant for the same reason `BlendMode::ALL` is one: a kind
    /// added to the enum reaches every menu and every validator without
    /// anyone remembering a second list.
    pub const ALL: [MaterialKind; 6] = [
        MaterialKind::SolidColor,
        MaterialKind::Image,
        MaterialKind::Video,
        MaterialKind::Unlit,
        MaterialKind::Pbr,
        MaterialKind::Shader,
    ];

    /// Whether this kind reads the scene's lights.
    ///
    /// Only `Pbr` does, and that is not a choice made here — it is what
    /// `services/render-engine/worker/src/mesh.rs` already requires a light
    /// for. Repeating the rule with a different answer would be the two
    /// vocabularies this whole module exists to collapse into one.
    pub const fn is_lit(self) -> bool {
        matches!(self, MaterialKind::Pbr)
    }

    /// Which half of the library this kind belongs in, or `None` when only
    /// the material itself can say.
    ///
    /// `Shader` is the honest `None`: a custom shader decides its own
    /// lighting, so filing it under 2D or 3D here would be this module
    /// guessing about code it cannot see. A caller shows it in its own group
    /// rather than being handed a plausible answer (invariant 18).
    pub const fn dimension(self) -> Option<MaterialDimension> {
        match self {
            MaterialKind::Pbr => Some(MaterialDimension::ThreeD),
            MaterialKind::SolidColor
            | MaterialKind::Image
            | MaterialKind::Video
            | MaterialKind::Unlit => Some(MaterialDimension::TwoD),
            MaterialKind::Shader => None,
        }
    }

    /// The material's wire name, for a refusal or a label.
    pub const fn wire_name(self) -> &'static str {
        match self {
            MaterialKind::SolidColor => "solid-color",
            MaterialKind::Image => "image",
            MaterialKind::Video => "video",
            MaterialKind::Pbr => "pbr",
            MaterialKind::Unlit => "unlit",
            MaterialKind::Shader => "shader",
        }
    }
}

/// How a lit surface responds to light.
///
/// Metallic-roughness rather than a second invented parameter set: it is what
/// glTF 2.0's core material is, what the imported models of 3.7 arrive
/// carrying, and what a physically based renderer already consumes. Inventing
/// an ambient/diffuse/specular triple beside it would give the same surface
/// two descriptions, which is 1.3's whole complaint.
///
/// Held separately from [`MaterialDefinition`] and `Option`al there, so an
/// unlit material has no lighting block rather than a block that is ignored.
/// A field that is silently not read is indistinguishable, to the author who
/// set it, from one that is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLighting {
    /// 0 = dielectric, 1 = metal. glTF's `metallicFactor`.
    #[serde(default)]
    pub metallic: f64,
    /// 0 = mirror, 1 = fully diffuse. glTF's `roughnessFactor`.
    #[serde(default = "default_roughness")]
    pub roughness: f64,
    /// Light the surface emits on its own, before any scene light reaches it.
    #[serde(default = "black")]
    pub emissive: Rgba,
    /// Multiplier on `emissive`. Separate from the colour so a glow can be
    /// pushed past 1 without leaving the colour unrepresentable.
    #[serde(default = "one")]
    pub emissive_intensity: f64,
}

fn default_roughness() -> f64 {
    0.5
}

fn black() -> Rgba {
    Rgba::srgb(0.0, 0.0, 0.0, 1.0)
}

impl Default for MaterialLighting {
    /// A dielectric, half-rough, non-emissive surface.
    ///
    /// Not glTF's own defaults (metallic 1, roughness 1), because those
    /// describe a fully rough metal — a created material would land looking
    /// like unpolished lead, and an author's first act would be to undo the
    /// default. Half-rough plastic is the surface a broadcast graphic
    /// actually starts from, and it reads as a solid object under the
    /// viewport's key light rather than as a black silhouette.
    fn default() -> Self {
        Self {
            metallic: 0.0,
            roughness: default_roughness(),
            emissive: black(),
            emissive_intensity: 1.0,
        }
    }
}

/// The texture inputs a material that is not a custom shader may declare.
///
/// The freehand `slot` string is what a shader needs — its inputs are named
/// by code this crate cannot read — but for every other kind it is exactly
/// the drift 1.3 exists to stop: the UI would offer `base-color`, the engine
/// would look for `baseColor`, and the texture would silently not arrive.
/// These are glTF's names, because that is what an imported model brings.
pub const STANDARD_TEXTURE_SLOTS: [&str; 6] = [
    "baseColor",
    "normal",
    "roughness",
    "metallic",
    "emissive",
    "occlusion",
];

/// One texture input of a material.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTextureSlot {
    /// The slot's name in the shader or the primitive: `baseColor`,
    /// `normal`, `front`, and so on.
    pub slot: String,
    /// References `AssetLibraryItem::asset_id` in the scene's library.
    pub asset_id: String,
    #[serde(default)]
    pub fit: FitMode,
    #[serde(default)]
    pub wrap: TextureWrapMode,
    #[serde(default)]
    pub filtering: TextureFiltering,
    /// The texture's source space. Required, because B.1 forbids inferring
    /// it: an untagged texture is a defect, not an sRGB one.
    pub color_space: SourceColorSpace,
}

/// A material as the library holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDefinition {
    pub material_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: MaterialKind,
    /// The base paint. A gradient is a colour value rather than a separate
    /// material kind, so a fill can become a gradient without the material
    /// changing type underneath every object that uses it.
    #[serde(default = "ColorValue::opaque_white")]
    pub color: ColorValue,
    /// 0–1, multiplied with the object's own opacity.
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub alpha_mode: AlphaMode,
    #[serde(default)]
    pub cull_mode: CullMode,
    #[serde(default)]
    pub depth_mode: DepthMode,
    #[serde(default)]
    pub double_sided: bool,
    #[serde(default)]
    pub textures: Vec<MaterialTextureSlot>,
    /// How the surface responds to light. Present only on a lit kind, and
    /// refused on the others rather than ignored — see [`MaterialLighting`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lighting: Option<MaterialLighting>,
    /// Set only for `MaterialKind::Shader`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shader_id: Option<String>,
}

fn one() -> f64 {
    1.0
}

/// What an object's material slot points at.
///
/// 1.x allowed either a bare material id string *or* an object with
/// overrides in the same field. An untagged union like that deserialises by
/// trial, and a shape that nearly matches the wrong arm is accepted silently,
/// so only the object form is carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MaterialBinding {
    pub material_id: String,
    /// An instance of the material carrying its own parameter overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instance_id: Option<String>,
}

impl MaterialBinding {
    pub fn new(material_id: impl Into<String>) -> Self {
        Self {
            material_id: material_id.into(),
            instance_id: None,
        }
    }
}

/// The blend, fit, cull, alpha and depth modes a peer declares it can
/// actually draw.
///
/// Held as data and exchanged in the capability handshake, never derived from
/// a feature flag (invariant 21): "this build has shader compositing compiled
/// in" is not the same claim as "this device draws overlay correctly".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MaterialSupport {
    pub blend_modes: Vec<BlendMode>,
    pub fit_modes: Vec<FitMode>,
    pub cull_modes: Vec<CullMode>,
    pub alpha_modes: Vec<AlphaMode>,
    pub depth_modes: Vec<DepthMode>,
}

impl MaterialSupport {
    /// What a renderer with fixed-function blending and a textured quad can
    /// do. A renderer declares this only once it has measured it.
    pub fn fixed_function() -> Self {
        Self {
            blend_modes: BlendMode::ALL
                .into_iter()
                .filter(|mode| mode.is_fixed_function())
                .collect(),
            fit_modes: FitMode::ALL
                .into_iter()
                .filter(|mode| mode.is_uv_transform())
                .collect(),
            cull_modes: CullMode::ALL.to_vec(),
            alpha_modes: AlphaMode::ALL.to_vec(),
            depth_modes: DepthMode::ALL.to_vec(),
        }
    }

    /// Every mode in the authoring vocabulary.
    ///
    /// **This is not a capability declaration and must never be sent as one.**
    /// It exists for the authoring surface, which is not the thing that draws.
    /// The Editor validating a material against `fixed_function()` would stop
    /// an author expressing `overlay` because *the Editor's own preview*
    /// cannot composite it — inferring one peer's capability from another's,
    /// which is exactly what invariant 21 forbids. So the authoring surface
    /// refuses what is wrong in every engine (ranges, lighting on an unlit
    /// kind, a texture that resolves to a font) and leaves "can this device
    /// draw it" to the device that measured it. The preview separately names
    /// what it cannot draw, which is a statement about the viewport.
    pub fn authoring_vocabulary() -> Self {
        Self {
            blend_modes: BlendMode::ALL.to_vec(),
            fit_modes: FitMode::ALL.to_vec(),
            cull_modes: CullMode::ALL.to_vec(),
            alpha_modes: AlphaMode::ALL.to_vec(),
            depth_modes: DepthMode::ALL.to_vec(),
        }
    }

    /// A peer that draws nothing yet. The honest declaration for an engine
    /// with no rasteriser: every mode then refuses by name, which is the
    /// correct answer rather than a degraded one.
    pub fn none() -> Self {
        Self {
            blend_modes: Vec::new(),
            fit_modes: Vec::new(),
            cull_modes: Vec::new(),
            alpha_modes: Vec::new(),
            depth_modes: Vec::new(),
        }
    }
}

/// Refuse a material a peer cannot draw exactly, naming the mode and the
/// modes it could have used instead.
///
/// This is 1.3's "consumed by validator": the refusal carries the enum, so an
/// unsupported mode cannot be reported as a freehand string, and `allowed`
/// carries the peer's real list, so the caller — a person or an agent — can
/// correct it in one step instead of guessing again (0.6's argument).
pub fn validate_material(
    material: &MaterialDefinition,
    support: &MaterialSupport,
) -> Result<(), StructuredRefusal> {
    validate_material_shape(material)?;
    if !support.blend_modes.contains(&material.blend_mode) {
        return Err(StructuredRefusal::error(Refusal::UnsupportedBlendMode {
            mode: material.blend_mode,
        })
        .at(
            format!("materials[{}].blendMode", material.material_id),
            as_json(material.blend_mode),
        )
        .allowing(support.blend_modes.iter().copied().map(as_json).collect()));
    }
    if !support.cull_modes.contains(&material.cull_mode) {
        return Err(StructuredRefusal::error(Refusal::UnsupportedCullMode {
            mode: material.cull_mode,
        })
        .at(
            format!("materials[{}].cullMode", material.material_id),
            as_json(material.cull_mode),
        )
        .allowing(support.cull_modes.iter().copied().map(as_json).collect()));
    }
    if !support.alpha_modes.contains(&material.alpha_mode) {
        return Err(StructuredRefusal::error(Refusal::UnsupportedAlphaMode {
            mode: material.alpha_mode,
        })
        .at(
            format!("materials[{}].alphaMode", material.material_id),
            as_json(material.alpha_mode),
        )
        .allowing(support.alpha_modes.iter().copied().map(as_json).collect()));
    }
    if !support.depth_modes.contains(&material.depth_mode) {
        return Err(StructuredRefusal::error(Refusal::UnsupportedDepthMode {
            mode: material.depth_mode,
        })
        .at(
            format!("materials[{}].depthMode", material.material_id),
            as_json(material.depth_mode),
        )
        .allowing(support.depth_modes.iter().copied().map(as_json).collect()));
    }
    for texture in &material.textures {
        if !support.fit_modes.contains(&texture.fit) {
            return Err(StructuredRefusal::error(Refusal::UnsupportedFitMode {
                mode: texture.fit,
            })
            .at(
                format!(
                    "materials[{}].textures.{}.fit",
                    material.material_id, texture.slot
                ),
                as_json(texture.fit),
            )
            .allowing(support.fit_modes.iter().copied().map(as_json).collect()));
        }
    }
    Ok(())
}

/// The checks that need only the material itself: parameter ranges, whether
/// lighting belongs on this kind, and whether the texture slots are named in
/// the vocabulary the renderer looks them up by.
///
/// Run before the capability checks, because these are defects in the material
/// rather than disagreements with a peer: an opacity of 1.4 is wrong on every
/// engine, and reporting it as "this engine cannot do that" would send the
/// author looking at the wrong thing.
fn validate_material_shape(material: &MaterialDefinition) -> Result<(), StructuredRefusal> {
    // Unit ranges, refused rather than clamped. Clamping answers a question
    // the author did not ask and never shows them the value they typed.
    let mut ranges: Vec<(&str, f64, f64, f64)> = vec![("opacity", material.opacity, 0.0, 1.0)];
    if let Some(lighting) = &material.lighting {
        ranges.push(("lighting.metallic", lighting.metallic, 0.0, 1.0));
        ranges.push(("lighting.roughness", lighting.roughness, 0.0, 1.0));
        ranges.push((
            "lighting.emissiveIntensity",
            lighting.emissive_intensity,
            0.0,
            f64::INFINITY,
        ));
    }
    for (field, given, min, max) in ranges {
        if !(given >= min && given <= max) {
            return Err(StructuredRefusal::error(
                Refusal::MaterialParameterOutOfRange {
                    material_id: material.material_id.clone(),
                    field: field.to_owned(),
                },
            )
            .at(
                format!("materials[{}].{field}", material.material_id),
                as_json(given),
            ));
        }
    }

    // A lighting block a renderer will never read is authored intent that
    // silently does nothing — the failure mode this whole module is about.
    if material.lighting.is_some() && !material.kind.is_lit() {
        return Err(StructuredRefusal::error(
            Refusal::MaterialLightingOnUnlitKind {
                material_id: material.material_id.clone(),
                kind: material.kind,
            },
        )
        .at(
            format!("materials[{}].kind", material.material_id),
            as_json(material.kind),
        )
        .allowing(
            MaterialKind::ALL
                .into_iter()
                .filter(|kind| kind.is_lit())
                .map(as_json)
                .collect(),
        ));
    }

    // A shader names its own inputs; nothing else may, or the panel and the
    // renderer end up looking for different strings.
    if material.kind != MaterialKind::Shader {
        for texture in &material.textures {
            if !STANDARD_TEXTURE_SLOTS.contains(&texture.slot.as_str()) {
                return Err(StructuredRefusal::error(
                    Refusal::MaterialUnknownTextureSlot {
                        material_id: material.material_id.clone(),
                        slot: texture.slot.clone(),
                    },
                )
                .at(
                    format!("materials[{}].textures", material.material_id),
                    serde_json::Value::String(texture.slot.clone()),
                )
                .allowing(
                    STANDARD_TEXTURE_SLOTS
                        .into_iter()
                        .map(|slot| serde_json::Value::String(slot.to_owned()))
                        .collect(),
                ));
            }
        }
    }
    Ok(())
}

/// A mode's wire name as JSON. These are unit enums, so serialisation cannot
/// fail; returning `Null` on error would put a lie in the refusal.
fn as_json<T: Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).expect("a unit enum always serialises")
}

// ---------------------------------------------------------------------------
// The scene-aware half of validation: textures resolve against the library.
// ---------------------------------------------------------------------------

/// The asset kinds that can be sampled as a texture at all.
///
/// A font, a model or a script has no texels. Binding one to a texture slot
/// is not a material a renderer can draw badly — it is one it cannot draw,
/// and saying so at authoring time is cheaper than at air time.
const SAMPLEABLE_ASSET_KINDS: [AssetKind; 6] = [
    AssetKind::Image,
    AssetKind::Svg,
    AssetKind::Video,
    AssetKind::ImageSequence,
    AssetKind::RenderTexture,
    AssetKind::Live,
];

/// The asset kinds that carry a moving picture.
const MOVING_ASSET_KINDS: [AssetKind; 3] = [
    AssetKind::Video,
    AssetKind::ImageSequence,
    AssetKind::Live,
];

/// Whether an asset kind can serve as this material kind's base colour.
///
/// The check exists because the two mistakes it catches are invisible until
/// the frame is on air: a `video` material pointed at a still shows a frozen
/// picture where motion was authored, and an `image` material pointed at a
/// clip shows whichever frame the decoder happened to hand over. Both look
/// like a working graphic to everything except the person watching.
fn base_color_asset_fits(kind: MaterialKind, asset: AssetKind) -> bool {
    match kind {
        MaterialKind::Video => MOVING_ASSET_KINDS.contains(&asset),
        MaterialKind::Image => !MOVING_ASSET_KINDS.contains(&asset),
        // Solid colour, unlit, PBR and shader materials take whatever texture
        // the author binds: a lit 3D surface with a video base colour is a
        // video wall, not a mistake.
        _ => true,
    }
}

/// Validate a material against the scene that holds it.
///
/// [`validate_material`] answers "is this material well formed, and can this
/// peer draw it"; only the scene can answer "do the assets it names exist,
/// and are they the kind of thing it says they are". Kept as a second
/// function rather than folded into the first because the engine validates
/// materials it has already resolved assets for, and would otherwise have to
/// synthesise a document to call it.
pub fn validate_material_in_scene(
    scene: &SceneDocument,
    material: &MaterialDefinition,
    support: &MaterialSupport,
) -> Result<(), StructuredRefusal> {
    validate_material(material, support)?;
    validate_material_textures(material, &scene.assets)
}

/// Resolve every texture slot against an asset library.
pub fn validate_material_textures(
    material: &MaterialDefinition,
    assets: &[AssetLibraryItem],
) -> Result<(), StructuredRefusal> {
    for texture in &material.textures {
        let field = format!(
            "materials[{}].textures.{}.assetId",
            material.material_id, texture.slot
        );
        let Some(asset) = assets.iter().find(|a| a.asset_id == texture.asset_id) else {
            return Err(
                StructuredRefusal::error(Refusal::MaterialTextureAssetUnknown {
                    material_id: material.material_id.clone(),
                    slot: texture.slot.clone(),
                    asset_id: texture.asset_id.clone(),
                })
                .at(field, serde_json::Value::String(texture.asset_id.clone()))
                .allowing(
                    assets
                        .iter()
                        .filter(|a| SAMPLEABLE_ASSET_KINDS.contains(&a.kind))
                        .map(|a| serde_json::Value::String(a.asset_id.clone()))
                        .collect(),
                ),
            );
        };

        let sampleable = SAMPLEABLE_ASSET_KINDS.contains(&asset.kind);
        let fits_base =
            texture.slot != "baseColor" || base_color_asset_fits(material.kind, asset.kind);
        if !sampleable || !fits_base {
            return Err(StructuredRefusal::error(
                Refusal::MaterialTextureAssetWrongKind {
                    material_id: material.material_id.clone(),
                    slot: texture.slot.clone(),
                    asset_id: texture.asset_id.clone(),
                    actual: asset.kind,
                },
            )
            .at(field, as_json(asset.kind))
            .allowing(
                assets
                    .iter()
                    .filter(|a| {
                        SAMPLEABLE_ASSET_KINDS.contains(&a.kind)
                            && (texture.slot != "baseColor"
                                || base_color_asset_fits(material.kind, a.kind))
                    })
                    .map(|a| serde_json::Value::String(a.asset_id.clone()))
                    .collect(),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The material library: the edits that author it (11.12).
//
// These are here, beside the model, for the reason `authoring.rs` gives for
// object lifecycle: the rules are the document's, not the UI's. Every peer
// that edits a material library has to refuse deleting a material in use the
// same way, and a second implementation in the Editor shell would be a second
// answer waiting to disagree.
//
// **A refused edit changes nothing.** Each function validates before it
// writes, so a scene that refused an edit is the scene that was passed in.
// ---------------------------------------------------------------------------

/// The object ids bound to a material, in document order.
///
/// **Computed, never stored.** A usage index is a second representation of a
/// fact the document already holds, and it goes stale the moment an object is
/// edited by anything that forgets to update it. An author deletes a material
/// the stale index called unused, and a graphic loses its fill on air.
pub fn material_users(scene: &SceneDocument, material_id: &str) -> Vec<String> {
    scene
        .objects
        .iter()
        .filter(|object| {
            object
                .base()
                .material_slots
                .as_ref()
                .is_some_and(|slots| slots.values().any(|b| b.material_id == material_id))
        })
        .map(|object| object.base().id.clone())
        .collect()
}

/// The smallest `material-n` no material in the scene already uses.
///
/// Deterministic rather than random, so a created id is reproducible in a test
/// and readable in a diff — the argument `next_object_id` makes in
/// `authoring.rs`.
fn next_material_id(scene: &SceneDocument) -> String {
    let taken: BTreeSet<&str> = scene
        .materials
        .iter()
        .map(|m| m.material_id.as_str())
        .collect();
    (1..)
        .map(|n| format!("material-{n}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .expect("an unbounded sequence always contains a free id")
}

/// What a kind needs before it can be created, beyond a name.
///
/// `None` means the kind can be completed from nothing. An image or video
/// material with no texture is not a material an author can see the effect
/// of — it renders as its base colour, which is indistinguishable from a
/// solid-colour material and tells them nothing about whether the binding
/// worked.
pub fn material_prerequisite(kind: MaterialKind) -> Option<&'static str> {
    match kind {
        MaterialKind::Image => Some("a still image asset in the scene's asset library"),
        MaterialKind::Video => Some("a video asset in the scene's asset library"),
        MaterialKind::Shader => {
            Some("a WGSL shader asset; shader materials are not authored in this panel")
        }
        MaterialKind::SolidColor | MaterialKind::Unlit | MaterialKind::Pbr => None,
    }
}

/// Create a material and return its id.
///
/// `asset_id` supplies the base-colour texture for the kinds that need one.
/// A created material is deliberately **visible**: opaque white base colour
/// rather than transparent black, so an author who binds it to an object sees
/// that something happened. An invisible new material is indistinguishable
/// from a create that failed.
pub fn create_material(
    scene: &mut SceneDocument,
    kind: MaterialKind,
    name: &str,
    asset_id: Option<&str>,
) -> Result<String, Refusal> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Refusal::MaterialKindNeedsPrerequisite {
            kind,
            needs: "a name".to_owned(),
        });
    }
    if let (Some(needs), None) = (material_prerequisite(kind), asset_id) {
        return Err(Refusal::MaterialKindNeedsPrerequisite {
            kind,
            needs: needs.to_owned(),
        });
    }

    let material_id = next_material_id(scene);
    let mut textures = Vec::new();
    if let Some(asset_id) = asset_id {
        let asset = scene
            .assets
            .iter()
            .find(|a| a.asset_id == asset_id)
            .ok_or_else(|| Refusal::MaterialTextureAssetUnknown {
                material_id: material_id.clone(),
                slot: "baseColor".to_owned(),
                asset_id: asset_id.to_owned(),
            })?;
        if !SAMPLEABLE_ASSET_KINDS.contains(&asset.kind) || !base_color_asset_fits(kind, asset.kind)
        {
            return Err(Refusal::MaterialTextureAssetWrongKind {
                material_id,
                slot: "baseColor".to_owned(),
                asset_id: asset_id.to_owned(),
                actual: asset.kind,
            });
        }
        textures.push(MaterialTextureSlot {
            slot: "baseColor".to_owned(),
            asset_id: asset_id.to_owned(),
            fit: FitMode::default(),
            wrap: TextureWrapMode::default(),
            filtering: TextureFiltering::default(),
            // B.1 forbids inferring a source space, and this is not an
            // inference: it is the space the authoring surface tags a new
            // binding with, visible in the panel and changeable in one field.
            // What B.1 forbids is leaving it untagged and letting each
            // renderer decide for itself.
            color_space: SourceColorSpace::Srgb,
        });
    }

    scene.materials.push(MaterialDefinition {
        material_id: material_id.clone(),
        name: name.to_owned(),
        kind,
        color: ColorValue::opaque_white(),
        opacity: 1.0,
        blend_mode: BlendMode::default(),
        alpha_mode: AlphaMode::default(),
        cull_mode: CullMode::default(),
        depth_mode: DepthMode::default(),
        double_sided: false,
        textures,
        // A lit kind gets a real lighting block rather than `None`, so the
        // author sees the numbers that are actually in force instead of an
        // empty panel governed by defaults they cannot read.
        lighting: kind.is_lit().then(MaterialLighting::default),
        shader_id: None,
    });
    Ok(material_id)
}

/// Replace a material in place, validating it first.
///
/// Takes the whole definition rather than a field and a value: a material is
/// edited as a unit in the panel, and a per-field write would need one refusal
/// path per field while still being unable to check the combinations — a kind
/// change that invalidates a texture is only visible when both are seen
/// together.
pub fn update_material(
    scene: &mut SceneDocument,
    material: MaterialDefinition,
    support: &MaterialSupport,
) -> Result<(), StructuredRefusal> {
    let Some(index) = scene
        .materials
        .iter()
        .position(|m| m.material_id == material.material_id)
    else {
        return Err(StructuredRefusal::error(Refusal::MaterialUnknown {
            material_id: material.material_id.clone(),
        })
        .at(
            "materialId",
            serde_json::Value::String(material.material_id.clone()),
        ));
    };
    validate_material_in_scene(scene, &material, support)?;
    scene.materials[index] = material;
    Ok(())
}

/// Delete a material, refusing while objects still bind it.
///
/// The alternative — deleting it and clearing every binding — is a single
/// gesture that silently restyles an unknown number of objects. Refusing with
/// the count lets the author relink first and see what they are about to
/// change, which is the argument [`relink_material`] is built on.
pub fn delete_material(scene: &mut SceneDocument, material_id: &str) -> Result<(), Refusal> {
    let Some(index) = scene
        .materials
        .iter()
        .position(|m| m.material_id == material_id)
    else {
        return Err(Refusal::MaterialUnknown {
            material_id: material_id.to_owned(),
        });
    };
    let users = material_users(scene, material_id);
    if !users.is_empty() {
        return Err(Refusal::MaterialInUse {
            material_id: material_id.to_owned(),
            user_count: users.len(),
        });
    }
    scene.materials.remove(index);
    Ok(())
}

/// Copy a material under a new id, and return that id.
///
/// The operation that makes a shared material safe to diverge from: an author
/// who wants one object to differ duplicates rather than edits, and every
/// other object keeps the material it had.
pub fn duplicate_material(scene: &mut SceneDocument, material_id: &str) -> Result<String, Refusal> {
    let source = scene
        .materials
        .iter()
        .find(|m| m.material_id == material_id)
        .ok_or_else(|| Refusal::MaterialUnknown {
            material_id: material_id.to_owned(),
        })?;
    let new_id = next_material_id(scene);
    let copy = MaterialDefinition {
        material_id: new_id.clone(),
        name: format!("{} copy", source.name),
        ..source.clone()
    };
    scene.materials.push(copy);
    Ok(new_id)
}

/// Repoint every binding from one material to another, and report the objects
/// that changed.
///
/// Returns the ids rather than a count so the caller can name them. A relink
/// that reports "14 objects changed" leaves the author to find out which;
/// naming them is what makes the edit reviewable.
pub fn relink_material(
    scene: &mut SceneDocument,
    from_material_id: &str,
    to_material_id: &str,
) -> Result<Vec<String>, Refusal> {
    for id in [from_material_id, to_material_id] {
        if !scene.materials.iter().any(|m| m.material_id == id) {
            return Err(Refusal::MaterialUnknown {
                material_id: id.to_owned(),
            });
        }
    }
    if from_material_id == to_material_id {
        return Ok(Vec::new());
    }

    let mut changed = Vec::new();
    for object in &mut scene.objects {
        let id = object.base().id.clone();
        let Some(slots) = object.base_mut().material_slots.as_mut() else {
            continue;
        };
        let mut touched = false;
        for binding in slots.values_mut() {
            if binding.material_id == from_material_id {
                binding.material_id = to_material_id.to_owned();
                // An instance id carries overrides authored against the old
                // material's parameters. Carrying it across would apply them
                // to a material that may not have those parameters at all.
                binding.instance_id = None;
                touched = true;
            }
        }
        if touched {
            changed.push(id);
        }
    }
    Ok(changed)
}

/// Bind a material to one object's named slot.
pub fn assign_material(
    scene: &mut SceneDocument,
    object_id: &str,
    slot: &str,
    material_id: &str,
) -> Result<(), Refusal> {
    if !scene.materials.iter().any(|m| m.material_id == material_id) {
        return Err(Refusal::MaterialUnknown {
            material_id: material_id.to_owned(),
        });
    }
    let object = scene
        .objects
        .iter_mut()
        .find(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })?;
    object
        .base_mut()
        .material_slots
        .get_or_insert_with(BTreeMap::new)
        .insert(slot.to_owned(), MaterialBinding::new(material_id));
    Ok(())
}

/// Remove a material binding from one object's named slot.
///
/// Returns whether a binding was actually there, so "nothing was bound" is
/// reportable rather than presented as a successful unbind.
pub fn clear_material_slot(
    scene: &mut SceneDocument,
    object_id: &str,
    slot: &str,
) -> Result<bool, Refusal> {
    let object = scene
        .objects
        .iter_mut()
        .find(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })?;
    Ok(object
        .base_mut()
        .material_slots
        .as_mut()
        .is_some_and(|slots| slots.remove(slot).is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MaterialDefinition {
        MaterialDefinition {
            material_id: "material_1".into(),
            name: "Lower third fill".into(),
            kind: MaterialKind::Unlit,
            color: ColorValue::hex("#102030").unwrap(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            alpha_mode: AlphaMode::Straight,
            cull_mode: CullMode::Back,
            depth_mode: DepthMode::ReadWrite,
            double_sided: false,
            textures: Vec::new(),
            lighting: None,
            shader_id: None,
        }
    }

    #[test]
    fn the_vocabulary_and_the_supported_set_are_different_questions() {
        // 1.3's core claim. The enum is the authoring vocabulary; what a peer
        // can draw is data that peer declares. Conflating the two is how a
        // mode becomes "supported" because a build flag was set.
        assert_eq!(BlendMode::ALL.len(), 10);
        assert!(!BlendMode::Overlay.is_fixed_function());
        assert!(BlendMode::Screen.is_fixed_function());

        let fixed = MaterialSupport::fixed_function();
        assert_eq!(fixed.blend_modes.len(), 6);
        assert!(!fixed.blend_modes.contains(&BlendMode::Overlay));
        assert!(MaterialSupport::none().blend_modes.is_empty());
    }

    #[test]
    fn overlay_is_refused_by_name_and_never_drawn_as_screen() {
        // The 1.x fault, now unrepeatable: a peer without shader compositing
        // refuses, and the refusal says what it could have had instead.
        let material = MaterialDefinition {
            blend_mode: BlendMode::Overlay,
            ..sample()
        };
        let refusal = validate_material(&material, &MaterialSupport::fixed_function())
            .expect_err("overlay must refuse on a fixed-function peer");

        assert!(matches!(
            refusal.code,
            Refusal::UnsupportedBlendMode {
                mode: BlendMode::Overlay
            }
        ));
        let wire = serde_json::to_value(&refusal).unwrap();
        assert_eq!(wire["code"]["refusal"], "unsupportedBlendMode");
        assert_eq!(wire["code"]["mode"], "overlay");
        assert_eq!(wire["given"], "overlay");
        let allowed = wire["allowed"].as_array().expect("the allowed list");
        assert!(allowed.contains(&serde_json::json!("screen")));
        assert!(!allowed.contains(&serde_json::json!("overlay")));
    }

    #[test]
    fn a_supported_mode_passes_and_an_unsupported_fit_is_caught_per_slot() {
        let mut material = sample();
        assert!(validate_material(&material, &MaterialSupport::fixed_function()).is_ok());

        material.textures.push(MaterialTextureSlot {
            slot: "baseColor".into(),
            asset_id: "asset_logo".into(),
            fit: FitMode::NineSlice,
            wrap: TextureWrapMode::Clamp,
            filtering: TextureFiltering::Linear,
            color_space: SourceColorSpace::Srgb,
        });
        let refusal = validate_material(&material, &MaterialSupport::fixed_function())
            .expect_err("nine-slice needs geometry a quad renderer does not build");
        assert!(matches!(
            refusal.code,
            Refusal::UnsupportedFitMode {
                mode: FitMode::NineSlice
            }
        ));
        assert_eq!(
            refusal.field.as_deref(),
            Some("materials[material_1].textures.baseColor.fit")
        );
    }

    #[test]
    fn every_mode_round_trips_on_the_wire_under_its_authored_name() {
        // The names are the contract: renaming one silently changes every
        // stored scene, so each is pinned.
        for mode in BlendMode::ALL {
            let wire = serde_json::to_value(mode).unwrap();
            assert_eq!(serde_json::from_value::<BlendMode>(wire).unwrap(), mode);
        }
        for mode in FitMode::ALL {
            let wire = serde_json::to_value(mode).unwrap();
            assert_eq!(serde_json::from_value::<FitMode>(wire).unwrap(), mode);
        }
        assert_eq!(
            serde_json::to_value(BlendMode::InverseAlphaMask).unwrap(),
            serde_json::json!("inverse-alpha-mask")
        );
        assert_eq!(
            serde_json::to_value(FitMode::PixelPerfect).unwrap(),
            serde_json::json!("pixel-perfect")
        );
        // 1.x's two fit vocabularies are now one: the mode it called `fit` is
        // `contain`, and the one it called `fill` is `cover`. The old spellings
        // are not accepted, because accepting both is how they drifted apart.
        assert!(serde_json::from_value::<FitMode>(serde_json::json!("fit")).is_err());
        assert!(serde_json::from_value::<FitMode>(serde_json::json!("fill")).is_err());
    }

    #[test]
    fn a_material_round_trips_with_its_texture_slots() {
        let material = MaterialDefinition {
            textures: vec![MaterialTextureSlot {
                slot: "baseColor".into(),
                asset_id: "asset_logo".into(),
                fit: FitMode::Cover,
                wrap: TextureWrapMode::Repeat,
                filtering: TextureFiltering::Nearest,
                color_space: SourceColorSpace::Rec709,
            }],
            ..sample()
        };
        let wire = serde_json::to_value(&material).unwrap();
        assert_eq!(wire["blendMode"], "normal");
        assert_eq!(wire["textures"][0]["colorSpace"], "rec709");
        assert_eq!(wire["textures"][0]["fit"], "cover");
        assert!(
            wire.as_object().unwrap().get("shaderId").is_none(),
            "an absent optional is absent, not null"
        );
        assert_eq!(
            serde_json::from_value::<MaterialDefinition>(wire).unwrap(),
            material
        );
    }

    // -----------------------------------------------------------------------
    // The 2D/3D library (11.12): what an author picks, and what it refuses.
    // -----------------------------------------------------------------------

    use crate::scene::{
        AssetKind, AssetLibraryItem, ObjectBase, RectObject, SceneCanvas, SceneDocument,
        SceneObject, SceneTimeline,
    };
    use crate::{RationalRate, Revision};

    fn scene() -> SceneDocument {
        SceneDocument {
            id: "materials".into(),
            name: "Materials".into(),
            version: 1,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
                ..Default::default()
            },
            data_context: Default::default(),
            assets: vec![
                asset("logo", AssetKind::Image),
                asset("clip", AssetKind::Video),
                asset("brand-font", AssetKind::Font),
            ],
            fonts: vec![],
            materials: vec![],
            controls: vec![],
            text_styles: vec![],
            objects: vec![],
        }
    }

    fn asset(asset_id: &str, kind: AssetKind) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: asset_id.into(),
            name: asset_id.into(),
            kind,
            path: format!("assets/{asset_id}"),
            checksum: None,
            mime_type: None,
            size_bytes: None,
            status: None,
        }
    }

    fn rect(scene: &mut SceneDocument, id: &str, material_id: &str) {
        let mut base = ObjectBase::new(id, id);
        base.width = 100.0;
        base.height = 100.0;
        base.material_slots = Some(BTreeMap::from([(
            "fill".to_owned(),
            MaterialBinding::new(material_id),
        )]));
        scene
            .objects
            .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
    }

    #[test]
    fn two_d_and_three_d_are_the_split_the_engine_already_enforces() {
        // The author-facing question is "2D or 3D material", and the answer is
        // derived from the kind rather than stored beside it — a stored
        // dimension is a second copy of a fact that can disagree with the
        // first. `Pbr` is 3D here because `prepare_meshes` already refuses a
        // `Pbr` material with no light in the scene.
        assert_eq!(
            MaterialKind::Pbr.dimension(),
            Some(MaterialDimension::ThreeD)
        );
        assert!(MaterialKind::Pbr.is_lit());
        for kind in [
            MaterialKind::SolidColor,
            MaterialKind::Image,
            MaterialKind::Video,
            MaterialKind::Unlit,
        ] {
            assert_eq!(kind.dimension(), Some(MaterialDimension::TwoD));
            assert!(!kind.is_lit());
        }
        // A custom shader decides its own lighting, so the library says it
        // does not know rather than filing it under a plausible half.
        assert_eq!(MaterialKind::Shader.dimension(), None);
        assert_eq!(MaterialKind::ALL.len(), 6);
    }

    #[test]
    fn lighting_on_an_unlit_kind_is_refused_rather_than_silently_ignored() {
        // The failure this guards: an author sets roughness on a 2D material,
        // the renderer never reads it, and nothing ever tells them. Storing
        // the value would be worse than refusing it.
        let material = MaterialDefinition {
            kind: MaterialKind::Unlit,
            lighting: Some(MaterialLighting::default()),
            ..sample()
        };
        let refusal = validate_material(&material, &MaterialSupport::fixed_function())
            .expect_err("an unlit material cannot carry lighting");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialLightingOnUnlitKind {
                kind: MaterialKind::Unlit,
                ..
            }
        ));
        let wire = serde_json::to_value(&refusal).unwrap();
        assert_eq!(wire["code"]["refusal"], "materialLightingOnUnlitKind");
        // The allowed list names the kinds that *are* lit, so the fix is one
        // step rather than another guess.
        assert_eq!(wire["allowed"], serde_json::json!(["pbr"]));

        let lit = MaterialDefinition {
            kind: MaterialKind::Pbr,
            lighting: Some(MaterialLighting::default()),
            ..sample()
        };
        assert!(validate_material(&lit, &MaterialSupport::fixed_function()).is_ok());
    }

    #[test]
    fn a_parameter_outside_its_unit_range_is_refused_not_clamped() {
        // Clamping answers a question the author did not ask: they typed 1.4
        // and the document would silently hold 1.0, with nothing on screen to
        // say the value they entered was not the value in force.
        let material = MaterialDefinition {
            opacity: 1.4,
            ..sample()
        };
        let refusal = validate_material(&material, &MaterialSupport::fixed_function())
            .expect_err("an opacity above 1 is not a valid material");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialParameterOutOfRange { ref field, .. } if field == "opacity"
        ));
        assert_eq!(refusal.given, serde_json::json!(1.4));

        let rough = MaterialDefinition {
            kind: MaterialKind::Pbr,
            lighting: Some(MaterialLighting {
                roughness: -0.2,
                ..MaterialLighting::default()
            }),
            ..sample()
        };
        let refusal = validate_material(&rough, &MaterialSupport::fixed_function())
            .expect_err("a negative roughness is not a surface");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialParameterOutOfRange { ref field, .. }
                if field == "lighting.roughness"
        ));
    }

    #[test]
    fn a_texture_slot_outside_the_shared_vocabulary_is_refused() {
        // 1.3's whole argument, applied to slot names: if the panel writes
        // `base-color` and the renderer reads `baseColor`, the texture simply
        // never arrives and the material looks like it has no texture at all.
        let material = MaterialDefinition {
            textures: vec![MaterialTextureSlot {
                slot: "base-color".into(),
                asset_id: "logo".into(),
                fit: FitMode::Contain,
                wrap: TextureWrapMode::Clamp,
                filtering: TextureFiltering::Linear,
                color_space: SourceColorSpace::Srgb,
            }],
            ..sample()
        };
        let refusal = validate_material(&material, &MaterialSupport::fixed_function())
            .expect_err("only a shader names its own inputs");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialUnknownTextureSlot { ref slot, .. } if slot == "base-color"
        ));
        assert!(refusal
            .allowed
            .as_ref()
            .expect("the standard slots")
            .contains(&serde_json::json!("baseColor")));

        // A shader may name anything, because only its own code knows.
        let shader = MaterialDefinition {
            kind: MaterialKind::Shader,
            shader_id: Some("wgsl-1".into()),
            ..material
        };
        assert!(validate_material(&shader, &MaterialSupport::fixed_function()).is_ok());
    }

    #[test]
    fn a_video_material_refuses_a_still_and_an_image_material_refuses_a_clip() {
        // Both mistakes survive every check except this one and then show up
        // on air: a frozen picture where motion was authored, or an arbitrary
        // frame of a clip where a logo was meant.
        let scene = scene();
        let video_on_still = MaterialDefinition {
            kind: MaterialKind::Video,
            textures: vec![texture("logo")],
            ..sample()
        };
        let refusal = validate_material_in_scene(
            &scene,
            &video_on_still,
            &MaterialSupport::fixed_function(),
        )
        .expect_err("a still cannot be the base colour of a video material");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialTextureAssetWrongKind {
                actual: AssetKind::Image,
                ..
            }
        ));
        // The allowed list is the scene's own assets that would work.
        assert_eq!(refusal.allowed, Some(vec![serde_json::json!("clip")]));

        let image_on_clip = MaterialDefinition {
            kind: MaterialKind::Image,
            textures: vec![texture("clip")],
            ..sample()
        };
        assert!(matches!(
            validate_material_in_scene(
                &scene,
                &image_on_clip,
                &MaterialSupport::fixed_function()
            )
            .expect_err("a clip is not a still")
            .code,
            Refusal::MaterialTextureAssetWrongKind {
                actual: AssetKind::Video,
                ..
            }
        ));

        // A lit 3D material takes either: a video wall is a real graphic.
        let lit_video = MaterialDefinition {
            kind: MaterialKind::Pbr,
            lighting: Some(MaterialLighting::default()),
            textures: vec![texture("clip")],
            ..sample()
        };
        assert!(
            validate_material_in_scene(&scene, &lit_video, &MaterialSupport::fixed_function())
                .is_ok()
        );
    }

    #[test]
    fn a_font_has_no_texels_and_a_missing_asset_is_named() {
        let scene = scene();
        let on_font = MaterialDefinition {
            kind: MaterialKind::Unlit,
            textures: vec![texture("brand-font")],
            ..sample()
        };
        assert!(matches!(
            validate_material_in_scene(&scene, &on_font, &MaterialSupport::fixed_function())
                .expect_err("a font cannot be sampled")
                .code,
            Refusal::MaterialTextureAssetWrongKind {
                actual: AssetKind::Font,
                ..
            }
        ));

        let dangling = MaterialDefinition {
            kind: MaterialKind::Unlit,
            textures: vec![texture("gone")],
            ..sample()
        };
        let refusal =
            validate_material_in_scene(&scene, &dangling, &MaterialSupport::fixed_function())
                .expect_err("a texture must resolve in the scene's own library");
        assert!(matches!(
            refusal.code,
            Refusal::MaterialTextureAssetUnknown { ref asset_id, .. } if asset_id == "gone"
        ));
    }

    fn texture(asset_id: &str) -> MaterialTextureSlot {
        MaterialTextureSlot {
            slot: "baseColor".into(),
            asset_id: asset_id.into(),
            fit: FitMode::Cover,
            wrap: TextureWrapMode::Clamp,
            filtering: TextureFiltering::Linear,
            color_space: SourceColorSpace::Srgb,
        }
    }

    #[test]
    fn creating_a_material_gives_a_visible_default_and_names_what_a_kind_needs() {
        let mut scene = scene();

        // A 2D solid colour needs nothing but a name, and lands visible:
        // opaque white rather than transparent black, so binding it to an
        // object shows the author that something happened.
        let id = create_material(&mut scene, MaterialKind::SolidColor, "Bar fill", None)
            .expect("a solid colour can be created from nothing");
        assert_eq!(id, "material-1");
        let made = &scene.materials[0];
        assert_eq!(made.color, ColorValue::opaque_white());
        assert_eq!(made.opacity, 1.0);
        assert!(made.lighting.is_none(), "a 2D material is not lit");

        // A 3D material arrives with a real lighting block, so the panel shows
        // the numbers in force rather than an empty section governed by
        // defaults the author cannot read.
        let id = create_material(&mut scene, MaterialKind::Pbr, "Chrome", None).unwrap();
        assert_eq!(id, "material-2");
        let lighting = scene.materials[1]
            .lighting
            .as_ref()
            .expect("a 3D material carries lighting");
        assert_eq!(lighting.metallic, 0.0);
        assert_eq!(lighting.roughness, 0.5);

        // An image or video material with no texture renders as its base
        // colour, which tells the author nothing about whether the binding
        // worked — so the kind names what it needs instead.
        let refusal = create_material(&mut scene, MaterialKind::Video, "Clip", None)
            .expect_err("a video material needs a clip");
        assert!(matches!(
            refusal,
            Refusal::MaterialKindNeedsPrerequisite {
                kind: MaterialKind::Video,
                ..
            }
        ));
        assert!(refusal.to_string().contains("video asset"));

        let id = create_material(&mut scene, MaterialKind::Video, "Clip", Some("clip")).unwrap();
        let made = scene.materials.iter().find(|m| m.material_id == id).unwrap();
        assert_eq!(made.textures[0].slot, "baseColor");
        assert_eq!(made.textures[0].asset_id, "clip");
        // Tagged, never inferred (B.1).
        assert_eq!(made.textures[0].color_space, SourceColorSpace::Srgb);

        // And the wrong kind of asset is refused at creation, not at air time.
        assert!(matches!(
            create_material(&mut scene, MaterialKind::Video, "Wrong", Some("logo"))
                .expect_err("a still is not a clip"),
            Refusal::MaterialTextureAssetWrongKind { .. }
        ));
    }

    #[test]
    fn a_material_in_use_is_not_deleted_and_the_refusal_counts_its_users() {
        let mut scene = scene();
        let id = create_material(&mut scene, MaterialKind::SolidColor, "Bar", None).unwrap();
        rect(&mut scene, "bar", &id);
        rect(&mut scene, "strap", &id);

        assert_eq!(material_users(&scene, &id), vec!["bar", "strap"]);
        let refusal = delete_material(&mut scene, &id).expect_err("two objects still bind it");
        assert!(matches!(
            refusal,
            Refusal::MaterialInUse { user_count: 2, .. }
        ));
        // A refused edit changes nothing.
        assert_eq!(scene.materials.len(), 1);

        assert!(matches!(
            delete_material(&mut scene, "nope").expect_err("no such material"),
            Refusal::MaterialUnknown { .. }
        ));

        let spare = create_material(&mut scene, MaterialKind::SolidColor, "Spare", None).unwrap();
        delete_material(&mut scene, &spare).expect("an unused material deletes");
        assert_eq!(scene.materials.len(), 1);
    }

    #[test]
    fn relink_repoints_every_binding_and_names_the_objects_it_changed() {
        let mut scene = scene();
        let from = create_material(&mut scene, MaterialKind::SolidColor, "Old", None).unwrap();
        let to = create_material(&mut scene, MaterialKind::SolidColor, "New", None).unwrap();
        rect(&mut scene, "bar", &from);
        rect(&mut scene, "strap", &from);
        rect(&mut scene, "logo", &to);

        let changed = relink_material(&mut scene, &from, &to).expect("both materials exist");
        assert_eq!(changed, vec!["bar", "strap"]);
        assert!(material_users(&scene, &from).is_empty());
        assert_eq!(material_users(&scene, &to).len(), 3);
        // Relinking frees the old material to be deleted, which is the whole
        // point of showing the blast radius first.
        delete_material(&mut scene, &from).expect("nothing binds it now");

        // A relink onto itself is a no-op worth saying out loud rather than
        // reporting as a successful edit of nothing.
        assert!(relink_material(&mut scene, &to, &to).unwrap().is_empty());
        assert!(matches!(
            relink_material(&mut scene, &to, "gone").expect_err("unknown target"),
            Refusal::MaterialUnknown { .. }
        ));
    }

    #[test]
    fn duplicating_a_shared_material_is_how_one_object_diverges() {
        let mut scene = scene();
        let shared = create_material(&mut scene, MaterialKind::Pbr, "Chrome", None).unwrap();
        rect(&mut scene, "left", &shared);
        rect(&mut scene, "right", &shared);

        let copy = duplicate_material(&mut scene, &shared).unwrap();
        assert_eq!(scene.materials[1].name, "Chrome copy");
        assert_eq!(scene.materials[1].lighting, scene.materials[0].lighting);

        assign_material(&mut scene, "right", "fill", &copy).expect("the copy exists");
        assert_eq!(material_users(&scene, &shared), vec!["left"]);
        assert_eq!(material_users(&scene, &copy), vec!["right"]);

        assert!(matches!(
            assign_material(&mut scene, "nowhere", "fill", &copy).expect_err("no such object"),
            Refusal::SceneObjectUnknown { .. }
        ));
        assert!(clear_material_slot(&mut scene, "right", "fill").unwrap());
        // A slot that held nothing reports that, rather than a successful
        // unbind of something that was never there.
        assert!(!clear_material_slot(&mut scene, "right", "fill").unwrap());
    }

    #[test]
    fn an_update_validates_against_the_scene_and_leaves_it_untouched_when_refused() {
        let mut scene = scene();
        let id = create_material(&mut scene, MaterialKind::Unlit, "Fill", None).unwrap();

        let broken = MaterialDefinition {
            textures: vec![texture("brand-font")],
            ..scene.materials[0].clone()
        };
        assert!(update_material(
            &mut scene,
            broken,
            &MaterialSupport::fixed_function()
        )
        .is_err());
        assert!(
            scene.materials[0].textures.is_empty(),
            "a refused update changes nothing"
        );

        let good = MaterialDefinition {
            textures: vec![texture("logo")],
            color: ColorValue::hex("#ff0000").unwrap(),
            ..scene.materials[0].clone()
        };
        update_material(&mut scene, good, &MaterialSupport::fixed_function()).expect("valid");
        assert_eq!(scene.materials[0].textures[0].asset_id, "logo");

        let missing = MaterialDefinition {
            material_id: "not-here".into(),
            ..scene.materials[0].clone()
        };
        assert!(matches!(
            update_material(&mut scene, missing, &MaterialSupport::fixed_function())
                .expect_err("no such material")
                .code,
            Refusal::MaterialUnknown { .. }
        ));
        let _ = id;
    }

    #[test]
    fn lighting_round_trips_on_the_wire_and_is_absent_when_unlit() {
        let material = MaterialDefinition {
            kind: MaterialKind::Pbr,
            lighting: Some(MaterialLighting {
                metallic: 1.0,
                roughness: 0.25,
                emissive: Rgba::srgb(0.1, 0.2, 0.3, 1.0),
                emissive_intensity: 2.0,
            }),
            ..sample()
        };
        let wire = serde_json::to_value(&material).unwrap();
        assert_eq!(wire["lighting"]["metallic"], 1.0);
        assert_eq!(wire["lighting"]["emissiveIntensity"], 2.0);
        assert_eq!(wire["lighting"]["emissive"]["space"], "srgb");
        assert_eq!(
            serde_json::from_value::<MaterialDefinition>(wire).unwrap(),
            material
        );

        // An unlit material has no lighting key at all — absent, not null, so
        // the generated TypeScript's `lighting?:` tells the truth about the
        // wire (rule 16).
        let unlit = sample();
        let wire = serde_json::to_value(&unlit).unwrap();
        assert!(wire.as_object().unwrap().get("lighting").is_none());
    }
}

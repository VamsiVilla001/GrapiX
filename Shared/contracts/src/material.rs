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

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::{ColorValue, SourceColorSpace};
use crate::{Refusal, StructuredRefusal};

/// Every blend mode the authoring vocabulary contains, supported or not.
///
/// The first ten are 1.x's `MATERIAL_BLEND_MODES`, unchanged in name and
/// order, because a scene authored there must mean the same thing here. 3.20
/// appends the rest of the Photoshop and After Effects Layer > Blending Mode
/// menus, so every mode a PSD, an After Effects project or a Figma file names
/// has exactly one variant and never a nearest neighbour. Together they are
/// the 27 Photoshop modes and the After Effects ones; the formulas are
/// EffectCraft's (`crates/color/src/blend.rs` at 9a7d3e7, MIT OR Apache-2.0),
/// ported with attribution in the render worker.
///
/// Two pairs share a formula and stay separate because the source menus name
/// them separately: `add` (After Effects) and `linear-dodge` (Photoshop's
/// "Linear Dodge (Add)"); `difference` and `classic-difference` differ only in
/// how layer opacity applies. `alpha-mask` and `inverse-alpha-mask` are After
/// Effects' Stencil Alpha and Silhouette Alpha under their 1.x names.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    #[default]
    Normal,
    /// After Effects Add: `b + s`, over-range kept.
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
    /// `max(b - s, 0)`.
    Subtract,
    /// After Effects Stencil Alpha: the backdrop is kept where this layer is
    /// opaque, everywhere on the stage.
    AlphaMask,
    /// After Effects Silhouette Alpha: the backdrop is cut out where this
    /// layer is opaque, everywhere on the stage.
    InverseAlphaMask,
    /// Photoshop and After Effects Dissolve: each pixel shows the layer or
    /// the backdrop by a fixed per-pixel threshold against the layer's alpha.
    Dissolve,
    /// After Effects Dancing Dissolve: Dissolve with a new pattern each frame.
    DancingDissolve,
    ColorBurn,
    /// After Effects Classic Color Burn: opacity fades the layer toward white
    /// before the formula applies; negative results are kept.
    ClassicColorBurn,
    LinearBurn,
    DarkerColor,
    ColorDodge,
    /// After Effects Classic Color Dodge: opacity fades the layer toward
    /// black before the formula applies.
    ClassicColorDodge,
    /// Photoshop Linear Dodge (Add): the same formula as `add`.
    LinearDodge,
    LighterColor,
    SoftLight,
    HardLight,
    LinearLight,
    VividLight,
    PinLight,
    HardMix,
    Difference,
    /// After Effects Classic Difference: opacity fades the layer toward black
    /// before the formula applies.
    ClassicDifference,
    Exclusion,
    Divide,
    Hue,
    Saturation,
    Color,
    Luminosity,
    /// After Effects Stencil Luma: the backdrop is scaled by this layer's
    /// luminance, everywhere on the stage.
    StencilLuma,
    /// After Effects Silhouette Luma: the backdrop is scaled by one minus
    /// this layer's luminance, everywhere on the stage.
    SilhouetteLuma,
    /// After Effects Alpha Add: source-over colour, alpha `min(sa + da, 1)`.
    AlphaAdd,
    /// After Effects Luminescent Premul: source-over colour without the
    /// layer's own alpha clipping its over-range values.
    LuminescentPremul,
}

impl BlendMode {
    /// The whole authoring vocabulary, in declaration order.
    ///
    /// A constant rather than a hand-written list at each call site: a mode
    /// added to the enum appears here, and in every capability declaration
    /// and validator built from it, without anyone remembering a second list.
    pub const ALL: [BlendMode; 38] = [
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
        BlendMode::Dissolve,
        BlendMode::DancingDissolve,
        BlendMode::ColorBurn,
        BlendMode::ClassicColorBurn,
        BlendMode::LinearBurn,
        BlendMode::DarkerColor,
        BlendMode::ColorDodge,
        BlendMode::ClassicColorDodge,
        BlendMode::LinearDodge,
        BlendMode::LighterColor,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::LinearLight,
        BlendMode::VividLight,
        BlendMode::PinLight,
        BlendMode::HardMix,
        BlendMode::Difference,
        BlendMode::ClassicDifference,
        BlendMode::Exclusion,
        BlendMode::Divide,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
        BlendMode::StencilLuma,
        BlendMode::SilhouetteLuma,
        BlendMode::AlphaAdd,
        BlendMode::LuminescentPremul,
    ];

    /// The 27 modes of Photoshop's Layer > Blending Mode menu, in its order.
    pub const PHOTOSHOP: [BlendMode; 27] = [
        BlendMode::Normal,
        BlendMode::Dissolve,
        BlendMode::Darken,
        BlendMode::Multiply,
        BlendMode::ColorBurn,
        BlendMode::LinearBurn,
        BlendMode::DarkerColor,
        BlendMode::Lighten,
        BlendMode::Screen,
        BlendMode::ColorDodge,
        BlendMode::LinearDodge,
        BlendMode::LighterColor,
        BlendMode::Overlay,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::VividLight,
        BlendMode::LinearLight,
        BlendMode::PinLight,
        BlendMode::HardMix,
        BlendMode::Difference,
        BlendMode::Exclusion,
        BlendMode::Subtract,
        BlendMode::Divide,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
    ];

    /// The modes of After Effects' Layer > Blending Mode menu, in its order.
    pub const AFTER_EFFECTS: [BlendMode; 38] = [
        BlendMode::Normal,
        BlendMode::Dissolve,
        BlendMode::DancingDissolve,
        BlendMode::Darken,
        BlendMode::Multiply,
        BlendMode::ColorBurn,
        BlendMode::ClassicColorBurn,
        BlendMode::LinearBurn,
        BlendMode::DarkerColor,
        BlendMode::Add,
        BlendMode::Lighten,
        BlendMode::Screen,
        BlendMode::ColorDodge,
        BlendMode::ClassicColorDodge,
        BlendMode::LinearDodge,
        BlendMode::LighterColor,
        BlendMode::Overlay,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::LinearLight,
        BlendMode::VividLight,
        BlendMode::PinLight,
        BlendMode::HardMix,
        BlendMode::Difference,
        BlendMode::ClassicDifference,
        BlendMode::Exclusion,
        BlendMode::Subtract,
        BlendMode::Divide,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
        BlendMode::AlphaMask,
        BlendMode::StencilLuma,
        BlendMode::InverseAlphaMask,
        BlendMode::SilhouetteLuma,
        BlendMode::AlphaAdd,
        BlendMode::LuminescentPremul,
    ];

    /// Whether this mode is expressible with fixed-function GPU blend
    /// factors.
    ///
    /// A property of the mode's mathematics, not of any renderer: these seven
    /// are a source/destination factor pair, and the others must read the
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
                | BlendMode::LinearDodge
        )
    }

    /// Whether the mode changes the backdrop everywhere on the stage, not
    /// only under the layer: the stencil and silhouette modes. A renderer
    /// that bounds a layer's work to its footprint must not bound these.
    pub const fn acts_on_whole_backdrop(self) -> bool {
        matches!(
            self,
            BlendMode::AlphaMask
                | BlendMode::InverseAlphaMask
                | BlendMode::StencilLuma
                | BlendMode::SilhouetteLuma
        )
    }

    /// Whether the mode is the default, for omitting it from the wire.
    pub fn is_normal(&self) -> bool {
        *self == BlendMode::Normal
    }
}

/// How texture content is mapped into the box it is drawn in.
///
/// One vocabulary, merged from 1.x's two: `contain` is the mode its texture
/// enum called `fit`, and `cover` is the one it called `fill`. The names kept
/// are CSS's, because that is the vocabulary designers hand work over in.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TextureWrapMode {
    #[default]
    Clamp,
    Repeat,
    MirrorRepeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, schemars::JsonSchema)]
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

/// One texture input of a material.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
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
// A refusal carries its field, the given value and the allowed list; that
// is the point of it, so the Err variant is large by design.
#[allow(clippy::result_large_err)]
pub fn validate_material(
    material: &MaterialDefinition,
    support: &MaterialSupport,
) -> Result<(), StructuredRefusal> {
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

/// A mode's wire name as JSON. These are unit enums, so serialisation cannot
/// fail; returning `Null` on error would put a lie in the refusal.
fn as_json<T: Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).expect("a unit enum always serialises")
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
            shader_id: None,
        }
    }

    #[test]
    fn the_vocabulary_and_the_supported_set_are_different_questions() {
        // 1.3's core claim. The enum is the authoring vocabulary; what a peer
        // can draw is data that peer declares. Conflating the two is how a
        // mode becomes "supported" because a build flag was set.
        assert_eq!(BlendMode::ALL.len(), 38);
        assert!(!BlendMode::Overlay.is_fixed_function());
        assert!(BlendMode::Screen.is_fixed_function());

        let fixed = MaterialSupport::fixed_function();
        assert_eq!(fixed.blend_modes.len(), 7);
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
    fn the_vocabulary_covers_photoshop_and_after_effects_once_each() {
        // 3.20: every mode either menu names is one variant, and no variant
        // is outside both menus.
        use std::collections::BTreeSet;
        let all: BTreeSet<_> = BlendMode::ALL.into_iter().collect();
        assert_eq!(all.len(), BlendMode::ALL.len(), "ALL has no duplicates");
        let photoshop: BTreeSet<_> = BlendMode::PHOTOSHOP.into_iter().collect();
        let after_effects: BTreeSet<_> = BlendMode::AFTER_EFFECTS.into_iter().collect();
        assert_eq!(photoshop.len(), 27);
        assert_eq!(after_effects.len(), BlendMode::AFTER_EFFECTS.len());
        assert!(photoshop.is_subset(&all) && after_effects.is_subset(&all));
        assert_eq!(&photoshop | &after_effects, all);
        // 1.x's ten keep their wire names and their places.
        let first: Vec<_> = BlendMode::ALL[..10]
            .iter()
            .map(|mode| serde_json::to_value(mode).unwrap())
            .collect();
        assert_eq!(
            first,
            serde_json::json!([
                "normal", "add", "multiply", "screen", "overlay", "darken",
                "lighten", "subtract", "alpha-mask", "inverse-alpha-mask"
            ])
            .as_array()
            .unwrap()
            .clone()
        );
        assert_eq!(serde_json::to_value(BlendMode::ClassicColorBurn).unwrap(), "classic-color-burn");
        assert_eq!(serde_json::to_value(BlendMode::LuminescentPremul).unwrap(), "luminescent-premul");
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
}

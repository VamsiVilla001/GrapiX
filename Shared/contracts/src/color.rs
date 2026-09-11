//! Colour: the working space, the tagged source spaces, the two output
//! transforms and the authored colour value (build plan 1.4, ADR-0002 B.1).
//!
//! Colour is where two renderers disagree invisibly. A preview that composites
//! in display-encoded values and an engine that composites in linear produce
//! images that look alike until a ramp or a cross-fade puts them side by side,
//! and then the pixel gate fails for a reason nobody can find. B.1's three
//! rules exist to stop that, and this module is the one place they are stated
//! in a form both languages read:
//!
//! 1. **Composite in linear, always.** [`WorkingColorSpace`] has exactly one
//!    variant, so "we composite in sRGB here" is not expressible.
//! 2. **Tag every source, never infer.** [`Rgba`] carries its
//!    [`SourceColorSpace`]; there is no "unknown" variant, because an untagged
//!    colour is a defect and defaulting it is the silent substitution
//!    invariant 18 forbids.
//! 3. **Exactly two output transforms**, sRGB for preview and Rec.709 for
//!    broadcast, chosen by the output adapter and never by the platform.
//!
//! The transfer functions are here rather than in a renderer because the
//! engine, the browser viewport and the pixel gate must use the same curve to
//! the last bit; a second implementation is the drift ADR-003 records.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Refusal;

/// The space every scene is composited in. One variant, deliberately: this
/// type exists so that "render in linear" is a fact of the contract rather
/// than a convention a renderer can quietly break.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WorkingColorSpace {
    #[default]
    LinearSrgb,
}

/// What a colour or a texture was authored in. There is no `Unknown`: an
/// untagged source is a defect the importer must refuse, not a value a
/// renderer may guess at (B.1, "never infer").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SourceColorSpace {
    /// IEC 61966-2-1. What a hex literal, a PNG without an ICC profile and
    /// most authoring tools mean.
    Srgb,
    /// Already linear — no decode on the way in.
    Linear,
    DisplayP3,
    /// ITU-R BT.709 with its own transfer curve. Broadcast source material.
    Rec709,
}

/// The only two transforms an output adapter may apply on the way out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum OutputTransform {
    /// The preview surface.
    Srgb,
    /// The broadcast signal.
    Rec709,
}

impl OutputTransform {
    /// Encode a linear component for this output.
    pub fn encode(self, linear: f64) -> f64 {
        match self {
            Self::Srgb => srgb_encode(linear),
            Self::Rec709 => rec709_encode(linear),
        }
    }

    /// Recover the linear component this output was encoded from.
    pub fn decode(self, encoded: f64) -> f64 {
        match self {
            Self::Srgb => srgb_decode(encoded),
            Self::Rec709 => rec709_decode(encoded),
        }
    }
}

/// sRGB's opto-electronic transfer function: linear → display-encoded.
///
/// The piecewise curve from IEC 61966-2-1, not the 2.2 power law it is often
/// described as. The difference is largest in the shadows, which is precisely
/// where a broadcast graphic's anti-aliased edges live, so approximating it
/// costs exactly the pixels the gate measures.
pub fn srgb_encode(linear: f64) -> f64 {
    if linear <= 0.003_130_8 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB's electro-optical transfer function: display-encoded → linear.
pub fn srgb_decode(encoded: f64) -> f64 {
    if encoded <= 0.040_449_936_474_468_28 {
        encoded / 12.92
    } else {
        ((encoded + 0.055) / 1.055).powf(2.4)
    }
}

/// ITU-R BT.709's OETF: scene-linear → signal.
///
/// This is the *signal* encoding, which is what an output adapter applies.
/// BT.1886 — the display EOTF a broadcast monitor applies — is a 2.4 power
/// law and is deliberately **not** the inverse of this curve: the difference
/// is the end-to-end system gamma (about 1.2) that broadcast viewing
/// conditions assume. [`rec709_decode`] inverts the OETF, which is what a
/// round trip through the signal needs; it is not a display model.
pub fn rec709_encode(linear: f64) -> f64 {
    if linear < 0.018 {
        4.5 * linear
    } else {
        1.099 * linear.powf(0.45) - 0.099
    }
}

/// The inverse of [`rec709_encode`]: signal → scene-linear.
pub fn rec709_decode(encoded: f64) -> f64 {
    if encoded < 0.081 {
        encoded / 4.5
    } else {
        ((encoded + 0.099) / 1.099).powf(1.0 / 0.45)
    }
}

/// A colour, with the space it was authored in.
///
/// Components are 0–1 floats rather than 8-bit bytes because the working
/// space is linear and 8 bits of linear has visible banding in the shadows.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    /// Straight (non-premultiplied) alpha.
    pub a: f64,
    pub space: SourceColorSpace,
}

impl Rgba {
    pub const fn new(r: f64, g: f64, b: f64, a: f64, space: SourceColorSpace) -> Self {
        Self { r, g, b, a, space }
    }

    /// An sRGB colour, which is what a colour picker and a hex literal give.
    pub const fn srgb(r: f64, g: f64, b: f64, a: f64) -> Self {
        Self::new(r, g, b, a, SourceColorSpace::Srgb)
    }

    /// A colour already in the working space.
    pub const fn linear(r: f64, g: f64, b: f64, a: f64) -> Self {
        Self::new(r, g, b, a, SourceColorSpace::Linear)
    }

    /// Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
    ///
    /// The result is tagged sRGB because CSS says a hex literal *is* sRGB —
    /// the tag is read off the notation, which is not the same as inferring
    /// it from nothing. Anything else is refused by name; there is no
    /// "black on parse failure", which is how a mistyped colour becomes an
    /// invisible graphic on air.
    pub fn from_css_hex(hex: &str) -> Result<Self, Refusal> {
        let body = hex.strip_prefix('#').unwrap_or(hex);
        let invalid = || Refusal::InvalidColor {
            given: hex.to_string(),
        };
        let nibble = |c: char| c.to_digit(16).ok_or_else(invalid);
        let pair = |s: &str, i: usize| -> Result<f64, Refusal> {
            let bytes: Vec<char> = s.chars().collect();
            let hi = nibble(bytes[i])?;
            let lo = nibble(bytes[i + 1])?;
            Ok(f64::from(hi * 16 + lo) / 255.0)
        };
        let short = |s: &str, i: usize| -> Result<f64, Refusal> {
            let bytes: Vec<char> = s.chars().collect();
            let v = nibble(bytes[i])?;
            // #abc means #aabbcc, so the nibble repeats rather than shifting.
            Ok(f64::from(v * 16 + v) / 255.0)
        };
        match body.len() {
            3 => Ok(Self::srgb(
                short(body, 0)?,
                short(body, 1)?,
                short(body, 2)?,
                1.0,
            )),
            4 => Ok(Self::srgb(
                short(body, 0)?,
                short(body, 1)?,
                short(body, 2)?,
                short(body, 3)?,
            )),
            6 => Ok(Self::srgb(
                pair(body, 0)?,
                pair(body, 2)?,
                pair(body, 4)?,
                1.0,
            )),
            8 => Ok(Self::srgb(
                pair(body, 0)?,
                pair(body, 2)?,
                pair(body, 4)?,
                pair(body, 6)?,
            )),
            _ => Err(invalid()),
        }
    }

    /// The `#rrggbbaa` form, for a UI that must hand a colour to CSS. Only
    /// meaningful for an sRGB colour, so a colour in another space is
    /// converted to sRGB first rather than being written out with the wrong
    /// numbers.
    pub fn to_css_hex(self) -> String {
        let srgb = self.to_space(SourceColorSpace::Srgb);
        let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            byte(srgb.r),
            byte(srgb.g),
            byte(srgb.b),
            byte(srgb.a)
        )
    }

    /// The colour's components in the linear working space.
    ///
    /// Display P3 shares sRGB's transfer curve but not its primaries; the
    /// gamut conversion is the colour pipeline's (3.3), so this decodes the
    /// curve and leaves the primaries alone rather than pretending P3 and
    /// sRGB are the same colour.
    pub fn to_linear(self) -> [f64; 3] {
        match self.space {
            SourceColorSpace::Linear => [self.r, self.g, self.b],
            SourceColorSpace::Srgb | SourceColorSpace::DisplayP3 => [
                srgb_decode(self.r),
                srgb_decode(self.g),
                srgb_decode(self.b),
            ],
            SourceColorSpace::Rec709 => [
                rec709_decode(self.r),
                rec709_decode(self.g),
                rec709_decode(self.b),
            ],
        }
    }

    /// Re-express this colour in another space, through linear.
    pub fn to_space(self, space: SourceColorSpace) -> Self {
        if self.space == space {
            return self;
        }
        let [r, g, b] = self.to_linear();
        let encode = |v: f64| match space {
            SourceColorSpace::Linear => v,
            SourceColorSpace::Srgb | SourceColorSpace::DisplayP3 => srgb_encode(v),
            SourceColorSpace::Rec709 => rec709_encode(v),
        };
        Self::new(encode(r), encode(g), encode(b), self.a, space)
    }

    /// Encode for an output adapter. The input is read in whatever space it
    /// was authored in and the result is display-encoded for that output.
    pub fn encode_for(self, output: OutputTransform) -> [f64; 4] {
        let [r, g, b] = self.to_linear();
        [output.encode(r), output.encode(g), output.encode(b), self.a]
    }
}

/// One stop of a gradient.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    /// 0–1 along the gradient.
    pub position: f64,
    pub color: Rgba,
}

/// What a gradient does outside its 0–1 span. CSS's own names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GradientSpread {
    #[default]
    Pad,
    Repeat,
    Reflect,
}

/// Whether a gradient's coordinates are the object's or the scene's. An
/// object-space gradient follows its object; a scene-space one stays put
/// while the object moves through it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GradientCoordinateMode {
    #[default]
    Object,
    Scene,
}

/// An authored paint: nothing, a colour, or a gradient.
///
/// `None` is a value, not an absence — "the author turned the fill off" and
/// "the author has not set a fill" are different states, and collapsing them
/// is how a transparent object becomes a black one on the other renderer.
/// Ported from 1.x `ColorValue`, with every colour now tagged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ColorValue {
    None,
    Solid {
        color: Rgba,
    },
    LinearGradient {
        /// Degrees, clockwise from the positive X axis.
        angle: f64,
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
        stops: Vec<GradientStop>,
        #[serde(default)]
        spread: GradientSpread,
        #[serde(default)]
        coordinate_mode: GradientCoordinateMode,
    },
    RadialGradient {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        focal_x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        focal_y: Option<f64>,
        stops: Vec<GradientStop>,
        #[serde(default)]
        spread: GradientSpread,
        #[serde(default)]
        coordinate_mode: GradientCoordinateMode,
    },
}

impl ColorValue {
    /// A solid sRGB colour from a hex literal — the common authoring case.
    pub fn hex(hex: &str) -> Result<Self, Refusal> {
        Ok(Self::Solid {
            color: Rgba::from_css_hex(hex)?,
        })
    }

    /// Opaque white. The default a material starts from, so an untextured
    /// material tints nothing rather than multiplying by an arbitrary colour.
    pub fn opaque_white() -> Self {
        Self::Solid {
            color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
        }
    }

    /// The stops, in authored order. Empty for `None` and `Solid`, so a
    /// caller can validate every stop without matching on the variant.
    pub fn stops(&self) -> &[GradientStop] {
        match self {
            Self::None | Self::Solid { .. } => &[],
            Self::LinearGradient { stops, .. } | Self::RadialGradient { stops, .. } => stops,
        }
    }

    /// Whether this paint puts any pixels on screen. A gradient with no
    /// stops paints nothing, which is worth knowing before a rasteriser
    /// tries to interpolate between zero colours.
    pub fn paints(&self) -> bool {
        match self {
            Self::None => false,
            Self::Solid { color } => color.a > 0.0,
            Self::LinearGradient { stops, .. } | Self::RadialGradient { stops, .. } => {
                !stops.is_empty()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1.4's done-when: the two transforms are named and testable. This is
    /// the "testable" half — the curves are exercised, not just declared.
    #[test]
    fn both_output_transforms_round_trip_across_the_range() {
        for output in [OutputTransform::Srgb, OutputTransform::Rec709] {
            for step in 0..=1000 {
                let linear = f64::from(step) / 1000.0;
                let back = output.decode(output.encode(linear));
                assert!(
                    (back - linear).abs() < 1e-9,
                    "{output:?} failed to round-trip {linear}: got {back}"
                );
            }
            // The anchors a colour bar depends on.
            assert!((output.encode(0.0)).abs() < 1e-12);
            assert!((output.encode(1.0) - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn the_two_transforms_are_measurably_different() {
        // If these ever agree, one of them has been replaced by the other and
        // broadcast output is silently carrying the preview curve.
        let srgb = srgb_encode(0.5);
        let rec709 = rec709_encode(0.5);
        assert!((srgb - 0.735_356_983_052_449_5).abs() < 1e-9, "{srgb}");
        assert!((rec709 - 0.705_515_089_922_121_2).abs() < 1e-9, "{rec709}");
        assert!(
            (srgb - rec709).abs() > 0.02,
            "mid grey must differ between preview and broadcast"
        );
    }

    #[test]
    fn the_srgb_curve_is_piecewise_and_continuous_at_its_knee() {
        // The 2.2 power law that sRGB is often mistaken for is wrong by more
        // than a code value in the shadows, which is where anti-aliased type
        // lives. Both facts are asserted so neither can be "simplified" away.
        let knee: f64 = 0.003_130_8;
        let linear_branch = 12.92 * knee;
        let power_branch = 1.055 * knee.powf(1.0 / 2.4) - 0.055;
        assert!((linear_branch - power_branch).abs() < 1e-6);
        assert!((srgb_encode(knee) - linear_branch).abs() < 1e-12);

        let shadow: f64 = 0.01;
        let pure_gamma = shadow.powf(1.0 / 2.2);
        assert!(
            (srgb_encode(shadow) - pure_gamma).abs() > 0.01,
            "the piecewise curve and a 2.2 gamma are not interchangeable"
        );
    }

    #[test]
    fn a_colour_carries_the_space_it_was_authored_in() {
        let hex = Rgba::from_css_hex("#102030").unwrap();
        assert_eq!(hex.space, SourceColorSpace::Srgb, "a hex literal is sRGB");
        assert!((hex.r - 16.0 / 255.0).abs() < 1e-12);
        assert!((hex.a - 1.0).abs() < 1e-12);

        // Decoding uses the colour's own curve, so the same numbers in two
        // spaces are two different colours.
        let as_srgb = Rgba::srgb(0.5, 0.5, 0.5, 1.0).to_linear();
        let as_rec709 = Rgba::new(0.5, 0.5, 0.5, 1.0, SourceColorSpace::Rec709).to_linear();
        assert!((as_srgb[0] - as_rec709[0]).abs() > 0.01);
        // A linear colour is already in the working space.
        assert_eq!(
            Rgba::linear(0.25, 0.5, 0.75, 1.0).to_linear(),
            [0.25, 0.5, 0.75]
        );
    }

    #[test]
    fn short_and_long_hex_forms_agree_and_a_bad_one_is_refused() {
        assert_eq!(
            Rgba::from_css_hex("#abc").unwrap(),
            Rgba::from_css_hex("#aabbcc").unwrap()
        );
        assert_eq!(
            Rgba::from_css_hex("#abcd").unwrap(),
            Rgba::from_css_hex("#aabbccdd").unwrap()
        );
        assert_eq!(
            Rgba::from_css_hex("#ff0000").unwrap().to_css_hex(),
            "#ff0000ff"
        );
        for bad in ["#12345", "#gg0000", "rgb(1,2,3)", "", "#"] {
            assert!(
                matches!(Rgba::from_css_hex(bad), Err(Refusal::InvalidColor { .. })),
                "{bad} must be refused by name, never defaulted"
            );
        }
    }

    #[test]
    fn a_colour_survives_a_change_of_space() {
        let original = Rgba::srgb(0.2, 0.4, 0.6, 0.8);
        let round_tripped = original
            .to_space(SourceColorSpace::Rec709)
            .to_space(SourceColorSpace::Srgb);
        for (a, b) in [
            (original.r, round_tripped.r),
            (original.g, round_tripped.g),
            (original.b, round_tripped.b),
            (original.a, round_tripped.a),
        ] {
            assert!((a - b).abs() < 1e-9);
        }
        assert_eq!(round_tripped.space, SourceColorSpace::Srgb);
    }

    #[test]
    fn a_paint_distinguishes_off_from_unset_and_from_empty() {
        assert!(!ColorValue::None.paints(), "an explicit off paints nothing");
        assert!(ColorValue::hex("#ffffff").unwrap().paints());
        assert!(
            !ColorValue::hex("#ffffff00").unwrap().paints(),
            "alpha 0 paints nothing"
        );
        let empty = ColorValue::LinearGradient {
            angle: 90.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 1.0,
            end_y: 0.0,
            stops: vec![],
            spread: GradientSpread::Pad,
            coordinate_mode: GradientCoordinateMode::Object,
        };
        assert!(!empty.paints(), "a gradient with no stops paints nothing");
        assert!(empty.stops().is_empty());
    }

    #[test]
    fn the_wire_form_is_tagged_and_camel_case() {
        let value = ColorValue::RadialGradient {
            center_x: 0.5,
            center_y: 0.5,
            radius_x: 1.0,
            radius_y: 0.5,
            focal_x: Some(0.25),
            focal_y: None,
            stops: vec![GradientStop {
                position: 0.0,
                color: Rgba::srgb(1.0, 0.0, 0.0, 1.0),
            }],
            spread: GradientSpread::Reflect,
            coordinate_mode: GradientCoordinateMode::Scene,
        };
        let wire = serde_json::to_value(&value).unwrap();
        assert_eq!(wire["type"], "radial-gradient");
        assert_eq!(wire["centerX"], 0.5);
        assert_eq!(wire["focalX"], 0.25);
        assert!(
            wire.as_object().unwrap().get("focalY").is_none(),
            "an absent optional is absent, not null"
        );
        assert_eq!(wire["stops"][0]["color"]["space"], "srgb");
        assert_eq!(wire["coordinateMode"], "scene");
        let back: ColorValue = serde_json::from_value(wire).unwrap();
        assert_eq!(back, value);
    }
}

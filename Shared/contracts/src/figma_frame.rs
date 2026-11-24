//! The frame an agent hands to `scenes.ingest_figma` (build plan 18.2, 18.3).
//!
//! Figma's `get_metadata` carries structure and geometry only. Everything that makes a frame
//! look like itself (fills, strokes, radii, text, fonts, blend modes, effects) comes from the
//! design context or the plugin API, which the user's own agent reads through Figma's MCP. The
//! agent writes what it read into **this** shape, and GrapiX maps it deterministically and names
//! whatever it cannot carry. GrapiX holds no Figma token and makes no network call.
//!
//! Conventions, so an agent cannot get them wrong silently:
//!
//! - Every `x`/`y` is **relative to the root frame's top-left**, as `get_metadata` reports them
//!   (not relative to the parent). The root's own `x`/`y` are ignored.
//! - Colours are `0..1` per channel, sRGB, as Figma's plugin API reports them.
//! - `rotation` is Figma's value in degrees (counter-clockwise positive).
//! - Paints are listed bottom to top, as Figma lists them; the top visible one is used.
//! - Anything left out takes Figma's own default (visible, opacity 1, no fill, no effects).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn one() -> f64 {
    1.0
}

fn yes() -> bool {
    true
}

/// A colour as Figma's plugin API reports it: `0..1` per channel, sRGB.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FigmaColor {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    #[serde(default = "one")]
    pub a: f64,
}

/// One stop of a gradient.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FigmaStop {
    /// `0..1` along the gradient.
    pub position: f64,
    pub color: FigmaColor,
}

/// One paint of a fill or a stroke.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FigmaPaint {
    Solid {
        color: FigmaColor,
        /// The paint's own opacity, on top of the colour's alpha.
        #[serde(default = "one")]
        opacity: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    /// A linear gradient across the node's box at `angle` degrees, clockwise from the
    /// positive X axis (0 runs left to right, 90 top to bottom).
    LinearGradient {
        angle: f64,
        stops: Vec<FigmaStop>,
        #[serde(default = "one")]
        opacity: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    /// A radial gradient centred in the node's box, reaching its edges.
    RadialGradient {
        stops: Vec<FigmaStop>,
        #[serde(default = "one")]
        opacity: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    /// A picture fill. `image` names a PNG or WebP in the project's `Images/<frame>/` folder
    /// (the file name without its extension, as exported from Figma); the ingest finds it
    /// there and draws it. A picture that is not there is named on the report with the path
    /// to file it at.
    Image {
        /// Figma's `imageHash`, or the file name the agent exported the picture to.
        image: String,
        /// Figma's scale mode: `fill` (the default), `fit`, `crop` or `tile`.
        #[serde(default)]
        scale_mode: String,
        #[serde(default = "yes")]
        visible: bool,
    },
}

/// A layer effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FigmaEffect {
    DropShadow {
        color: FigmaColor,
        offset_x: f64,
        offset_y: f64,
        radius: f64,
        #[serde(default)]
        spread: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    InnerShadow {
        color: FigmaColor,
        offset_x: f64,
        offset_y: f64,
        radius: f64,
        #[serde(default)]
        spread: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    LayerBlur {
        radius: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
    BackgroundBlur {
        radius: f64,
        #[serde(default = "yes")]
        visible: bool,
    },
}

/// A text node's content and style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FigmaText {
    pub characters: String,
    pub font_family: String,
    /// Figma's style name: `Regular`, `Bold`, `Bold Italic`, `SemiBold`, `Light`...
    #[serde(default)]
    pub font_style: String,
    pub font_size: f64,
    /// Line height in pixels; absent means the font's own.
    #[serde(default)]
    pub line_height_px: Option<f64>,
    /// Letter spacing in pixels.
    #[serde(default)]
    pub letter_spacing_px: f64,
    /// `left`, `center`, `right` or `justified`.
    #[serde(default)]
    pub align: String,
    /// `top`, `center` or `bottom`.
    #[serde(default)]
    pub vertical_align: String,
    /// `upper`, `lower`, `title` or empty for as typed.
    #[serde(default)]
    pub text_case: String,
    /// `underline`, `strikethrough` or empty.
    #[serde(default)]
    pub decoration: String,
}

/// One node of the frame, in Figma's own vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FigmaNode {
    /// Figma's node id, such as `3300:2528`. It is the scene object's id, so a re-import lines up.
    pub id: String,
    /// `frame`, `group`, `section`, `component`, `instance`, `rectangle`, `rounded-rectangle`,
    /// `ellipse`, `text`, `vector`, `line`, `star`, `polygon` or `boolean-operation`.
    pub kind: String,
    #[serde(default)]
    pub name: String,
    /// Relative to the root frame's top-left.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Figma's rotation in degrees (counter-clockwise positive), about the node's top-left.
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default = "yes")]
    pub visible: bool,
    /// Figma's blend mode name: `PASS_THROUGH`, `NORMAL`, `MULTIPLY`, `SCREEN`, `OVERLAY`...
    #[serde(default)]
    pub blend_mode: String,
    #[serde(default)]
    pub fills: Vec<FigmaPaint>,
    #[serde(default)]
    pub strokes: Vec<FigmaPaint>,
    #[serde(default)]
    pub stroke_weight: f64,
    /// `center`, `inside` or `outside`.
    #[serde(default)]
    pub stroke_align: String,
    /// One radius for all four corners.
    #[serde(default)]
    pub corner_radius: f64,
    /// Top-left, top-right, bottom-right, bottom-left, when the corners differ.
    #[serde(default)]
    pub corner_radii: Option<[f64; 4]>,
    #[serde(default)]
    pub clips_content: bool,
    #[serde(default)]
    pub effects: Vec<FigmaEffect>,
    /// Present on a text node.
    #[serde(default)]
    pub text: Option<FigmaText>,
    #[serde(default)]
    pub children: Vec<FigmaNode>,
}

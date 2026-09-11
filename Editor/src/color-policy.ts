//! Colour policy for the browser renderer (ADR-0002 B.1).
//!
//! The browser layer and the engine must agree on colour, or the pixel gate
//! fails for reasons nobody can find (B.1's closing warning). This module is
//! the *policy* — the single place the rules are stated as constants — kept
//! separate from the Three.js construction so it can be read without a GL
//! context and so the engine and the Editor read the same values.
//!
//! The rules, restated from B.1:
//! - render internally in linear, always;
//! - tag every texture with its source colour space at import, never infer;
//! - exactly two output transforms — sRGB for preview, Rec.709/BT.1886 for
//!   broadcast — selected by the output adapter, never by platform.

/// The working space the scene is authored and composited in. Linear, per
/// B.1's first rule.
export const WORKING_COLOR_SPACE = "linear-srgb" as const;

/// The two output transforms B.1 permits, as the only legal values.
export type OutputColorSpace = "srgb" | "rec709";

/// The preview surface's transform (B.1: sRGB for preview). The broadcast
/// transform is Rec.709, selected by the broadcast adapter — not set here,
/// because this module is the preview/viewport side.
export const PREVIEW_OUTPUT_COLOR_SPACE: OutputColorSpace = "srgb";

/// The source colour spaces a texture may be tagged with. There is no
/// "unknown": an untagged texture is a defect, not a default.
export type SourceColorSpace = "srgb" | "linear" | "display-p3" | "rec709";

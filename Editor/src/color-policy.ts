//! Colour policy for the browser renderer (ADR-0002 B.1).
//!
//! The browser layer and the engine must agree on colour, or the pixel gate
//! fails for reasons nobody can find (B.1's closing warning). The rules are
//! now Rust types in `gx-contracts::color` (build plan 1.4) and this module
//! imports them: until 1.4 it declared its own `OutputColorSpace` and
//! `SourceColorSpace` unions, which is precisely the hand-mirrored type
//! invariant 22 forbids — two lists of the same vocabulary, free to drift.
//!
//! What is left here is the browser's *choice*, which is genuinely the
//! browser's to make: which of the two permitted transforms the preview
//! surface uses.

import type { OutputTransform, SourceColorSpace, WorkingColorSpace } from "@grapix/contracts";

/// The working space this browser viewport assumes: linear, for every scene.
///
/// Since 3.15 a project declares its own space (new projects sRGB) and the
/// engine composites each scene in it. This viewport does not yet read the
/// scene's declared space, and which space its blending actually matches is
/// unmeasured: Three.js applies the output curve per fragment, before the
/// hardware blends. That is a named gap (GrapiX-Build-Plan.md, 3.15 note),
/// closed by 13.5 when the engine renders the viewport. The engine is the
/// renderer of record.
export const WORKING_COLOR_SPACE: WorkingColorSpace = "linear-srgb";

/// The preview surface's transform (B.1: sRGB for preview). The broadcast
/// transform is Rec.709, selected by the broadcast adapter — not here,
/// because this module is the preview side.
export const PREVIEW_OUTPUT_COLOR_SPACE: OutputTransform = "srgb";

export type { OutputTransform, SourceColorSpace, WorkingColorSpace };

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

/// The space every scene is composited in. The generated type has exactly one
/// member, so "we composite in sRGB here" does not typecheck.
export const WORKING_COLOR_SPACE: WorkingColorSpace = "linear-srgb";

/// The preview surface's transform (B.1: sRGB for preview). The broadcast
/// transform is Rec.709, selected by the broadcast adapter — not here,
/// because this module is the preview side.
export const PREVIEW_OUTPUT_COLOR_SPACE: OutputTransform = "srgb";

export type { OutputTransform, SourceColorSpace, WorkingColorSpace };

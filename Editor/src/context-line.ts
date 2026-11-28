// The context line at the right end of the menu bar (the new Figma UI, row 11.67): what a person needs to know about the scene in front
// of them without opening anything. "Final Four L3 · Scene ID 1 · 1920×1080 · 50 fps · 32 bit · sRGB".
//
// The design writes "1080p50". Nothing in the scene says whether a project is progressive or interlaced yet (row 7.8), so the line says
// the size and the rate and leaves the scan out, rather than claim a "p" nobody declared.

import type { SceneDocument } from "../../Shared/generated-ts/src";

/** A rational frame rate as a person writes it: 50, 25, 29.97, 59.94. */
export function frameRateText(rate: { readonly num: number; readonly den: number }): string {
  if (!(rate.den > 0) || !Number.isFinite(rate.num / rate.den)) return "?";
  const value = rate.num / rate.den;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const SPACES: Readonly<Record<string, string>> = { srgb: "sRGB", "linear-srgb": "Linear sRGB" };

export type ContextLineScene = Pick<SceneDocument, "name" | "canvas" | "colorDepth" | "workingColorSpace"> & { readonly sceneLabel?: string | undefined };

/** The line for the open scene; "No scene open" when there is none. */
export function contextLine(scene: ContextLineScene | undefined): string {
  if (scene === undefined) return "No scene open";
  const parts = [scene.name.trim() === "" ? "Untitled" : scene.name.trim()];
  if (scene.sceneLabel !== undefined && scene.sceneLabel !== "") parts.push(`Scene ID ${scene.sceneLabel}`);
  parts.push(`${scene.canvas.width}×${scene.canvas.height}`, `${frameRateText(scene.canvas.frameRate)} fps`);
  parts.push(`${scene.colorDepth} bit`, SPACES[scene.workingColorSpace] ?? scene.workingColorSpace);
  return parts.join(" · ");
}

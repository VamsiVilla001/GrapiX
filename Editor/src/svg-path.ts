// SVG path data out of the contract's path model (11.114). The twin of `Shared/contracts/src/svg_path.rs`'s writer: held to the
// same answers by the shared fixture `fixtures/svg-path.json`. Reading SVG path data (`d`) is the importer's, in Rust.
//
// `M`, then `L` for a segment with no handles and `C` for any other, `Z` for a closed path; a closed path's last segment, when
// straight, is the `Z` itself.

import type { BezierPath } from "@grapix/contracts";

/** A number to six decimals with the trailing zeros and a bare point dropped, `-0` as `0`. */
export function svgNumber(x: number): string {
  let text = x.toFixed(6);
  if (text.includes(".")) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  return text === "-0" ? "0" : text;
}

export function writeSvgPath(paths: readonly BezierPath[]): string {
  let out = "";
  for (const path of paths) {
    const n = path.vertices.length;
    if (n === 0) continue;
    if (out !== "") out += " ";
    out += `M${svgNumber(path.vertices[0]!.x)} ${svgNumber(path.vertices[0]!.y)}`;
    const segments = path.closed ? n : Math.max(0, n - 1);
    for (let i = 0; i < segments; i += 1) {
      const j = (i + 1) % n;
      const a = path.vertices[i]!;
      const b = path.vertices[j]!;
      const o = path.outTangents[i]!;
      const t = path.inTangents[j]!;
      const straight = o.x === 0 && o.y === 0 && t.x === 0 && t.y === 0;
      if (path.closed && i + 1 === n && straight) continue;
      out += straight
        ? ` L${svgNumber(b.x)} ${svgNumber(b.y)}`
        : ` C${svgNumber(a.x + o.x)} ${svgNumber(a.y + o.y)} ${svgNumber(b.x + t.x)} ${svgNumber(b.y + t.y)} ${svgNumber(b.x)} ${svgNumber(b.y)}`;
    }
    if (path.closed) out += "Z";
  }
  return out;
}

/** The shape's subpaths as the one path data string: its own path, then each compound path. */
export function shapeSvgPath(shape: { readonly path: BezierPath; readonly compoundPaths?: readonly BezierPath[] | undefined }): string {
  return writeSvgPath([shape.path, ...(shape.compoundPaths ?? [])]);
}

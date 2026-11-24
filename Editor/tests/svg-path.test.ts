// SVG path data out (11.114): the writer agrees with the Rust one on the shared fixture, and a shape writes all its subpaths.
import { describe, expect, it } from "vitest";
import type { BezierPath } from "@grapix/contracts";
import fixture from "../../Shared/contracts/fixtures/svg-path.json";
import { shapeSvgPath, svgNumber, writeSvgPath } from "../src/svg-path";

describe("SVG path data out", () => {
  it("gives what the Rust writer gives, for every case of the shared fixture", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
    for (const entry of fixture.cases) {
      expect(writeSvgPath(entry.paths as unknown as BezierPath[])).toBe(entry.d);
    }
  });

  it("writes numbers to six decimals without trailing zeros, and -0 as 0", () => {
    expect([svgNumber(1), svgNumber(1.5), svgNumber(-0.0000004), svgNumber(0.1234567891), svgNumber(100.25), svgNumber(-3)]).toEqual(["1", "1.5", "0", "0.123457", "100.25", "-3"]);
  });

  it("writes a shape's own path and then its compound paths", () => {
    const z = { x: 0, y: 0 };
    const square = (s: number): BezierPath => ({ closed: true, vertices: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }], inTangents: [z, z, z, z], outTangents: [z, z, z, z] });
    expect(shapeSvgPath({ path: square(10), compoundPaths: [square(4)] })).toBe("M0 0 L10 0 L10 10 L0 10Z M0 0 L4 0 L4 4 L0 4Z");
    expect(shapeSvgPath({ path: square(10) })).toBe("M0 0 L10 0 L10 10 L0 10Z");
  });
});

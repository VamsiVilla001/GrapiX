import { describe, expect, it } from "vitest";
import type { TimelinePhase } from "@grapix/contracts";
import { wireFrame } from "../src/command-client";
import { graphicPreviewFrame } from "../src/graphic-preview";

const scene = (phases: TimelinePhase[] = [], duration = 100) => ({ timeline: { durationFrames: wireFrame(duration), channels: [], phases } });
describe("representative graphic preview frame", () => {
  it("prefers the hold/build frame so an animated entrance does not produce an empty first-frame tile", () => {
    expect(graphicPreviewFrame(scene())).toBe(50);
    expect(graphicPreviewFrame(scene([{ kind: "in", startFrame: wireFrame(0), endFrame: wireFrame(20) }]))).toBe(20);
    expect(graphicPreviewFrame(scene([{ kind: "hold", startFrame: wireFrame(30), endFrame: wireFrame(80) }]))).toBe(30);
    expect(graphicPreviewFrame(scene([], 0))).toBe(0);
  });
});

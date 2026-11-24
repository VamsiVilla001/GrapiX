import { describe, expect, it } from "vitest";

import { hasEnabledEffects, viewportSource, wantsEngineFrame, type ViewportSourceInput } from "../src/viewport-source";

const blur = { enabled: true };
const base: ViewportSourceInput = {
  objects: [{ effects: [blur] }],
  choice: "auto",
  status: "current",
  hasImage: true,
  playing: false,
};

describe("viewport source", () => {
  it("shows the engine frame when an enabled effect is present", () => {
    expect(viewportSource(base)).toEqual({ source: "engine" });
  });

  it("stays on the draft when there are no effects", () => {
    expect(viewportSource({ ...base, objects: [{}, { effects: [] }] })).toEqual({ source: "draft" });
  });

  it("ignores a disabled effect", () => {
    const objects = [{ effects: [{ enabled: false }] }];
    expect(hasEnabledEffects(objects)).toBe(false);
    expect(viewportSource({ ...base, objects })).toEqual({ source: "draft" });
  });

  it("honours an explicit engine choice with no effects", () => {
    expect(viewportSource({ ...base, objects: [{}], choice: "engine" })).toEqual({ source: "engine" });
  });

  it("honours an explicit draft choice even with effects", () => {
    expect(viewportSource({ ...base, choice: "draft" })).toEqual({ source: "draft" });
  });

  it("keeps the engine frame while playing, so effects stay on screen", () => {
    expect(viewportSource({ ...base, playing: true })).toEqual({ source: "engine" });
  });

  it("while playing, a scene with no effects stays on the draft and the engine is not asked", () => {
    const objects = [{}];
    expect(viewportSource({ ...base, objects, playing: true })).toEqual({ source: "draft" });
    expect(wantsEngineFrame(objects, "auto")).toBe(false);
    expect(wantsEngineFrame(objects, "engine")).toBe(true);
    expect(wantsEngineFrame([{ effects: [blur] }], "draft")).toBe(false);
    expect(wantsEngineFrame([{ effects: [blur] }], "auto")).toBe(true);
  });

  it("falls back and says so when the engine is unavailable or refuses", () => {
    for (const status of ["unavailable", "refused"] as const) {
      const verdict = viewportSource({ ...base, status });
      expect(verdict.source).toBe("draft");
      expect(verdict.note).toMatch(/without effects/);
    }
  });

  it("falls back when there is no image yet", () => {
    expect(viewportSource({ ...base, hasImage: false, status: "rendering" }).source).toBe("draft");
  });

  it("keeps the last frame while a newer one renders (the status says stale)", () => {
    expect(viewportSource({ ...base, status: "stale" }).source).toBe("engine");
    expect(viewportSource({ ...base, status: "rendering" }).source).toBe("engine");
  });

  it("gives no note when nothing was lost", () => {
    expect(viewportSource({ ...base, objects: [{}], choice: "engine", hasImage: false }).note).toBeUndefined();
  });
});

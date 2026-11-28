import { describe, expect, it } from "vitest";

import { BAR_BUTTONS, TIMELINE_MENU, ZOOM_MAX, ZOOM_MIN, barState, fitZoom, planAddKeys } from "../src/timeline/keyframe-bar";
import { keyId } from "../src/timeline/model";

type Doc = Parameters<typeof barState>[0];
const key = (frame: number, value: number, easing = "linear") => ({ frame, value, easing });
const doc = (channels: { objectId: string; property: string; keys: ReturnType<typeof key>[] }[]): NonNullable<Doc> =>
  ({
    objects: [
      { id: "a", name: "A", type: "rect", x: 100, y: 200, opacity: 1 },
      { id: "b", name: "B", type: "rect", x: 5, y: 6, opacity: 1 },
    ],
    timeline: { durationFrames: 100, channels, phases: [], pathChannels: [] },
  }) as unknown as NonNullable<Doc>;

describe("the buttons the design draws", () => {
  it("are the keyframe group in the design's order, then Zoom to fit at the right", () => {
    expect(BAR_BUTTONS.map((b) => b.label)).toEqual(["Prev", "Play", "Next", "+ Add  (K)", "Linear", "Ease  (F9)", "Ease in", "Ease out", "Hold", "Stagger", "Zoom to fit", "Auto-key"]);
    expect(BAR_BUTTONS.filter((b) => b.right).map((b) => b.action)).toEqual(["fit", "auto-key"]);
    expect(BAR_BUTTONS.find((b) => b.primary)?.action).toBe("ease");
  });

  it("does not draw Snap or Markers, which are not features yet", () => {
    expect(BAR_BUTTONS.map((b) => b.label.toLowerCase()).join(" ")).not.toMatch(/snap|marker/);
  });
});

describe("which buttons can be pressed", () => {
  const d = doc([{ objectId: "a", property: "x", keys: [key(0, 0), key(20, 10, "hold")] }]);

  it("needs selected keys for the easing buttons, and says so", () => {
    const state = barState(d, [], ["a"]);
    for (const action of ["linear", "ease", "ease-in", "ease-out", "hold"] as const) expect(state[action].disabled).toBe("Select keys in the timeline first");
    expect(state.add).toEqual({});
    expect(state.fit).toEqual({});
  });

  it("opens them with keys selected", () => {
    const state = barState(d, [keyId("a", "x", 0)], ["a"]);
    for (const action of ["linear", "ease", "ease-in", "ease-out", "hold"] as const) expect(state[action].disabled).toBeUndefined();
  });

  it("marks Linear or Hold when every selected key already has it", () => {
    expect(barState(d, [keyId("a", "x", 0)], ["a"]).linear.active).toBe(true);
    expect(barState(d, [keyId("a", "x", 20)], ["a"]).hold.active).toBe(true);
    expect(barState(d, [keyId("a", "x", 0), keyId("a", "x", 20)], ["a"]).linear.active).toBeUndefined();
    expect(barState(d, [keyId("a", "x", 0)], ["a"]).hold.active).toBeUndefined();
  });

  it("needs a scene and an element for Add, and a scene for Zoom to fit", () => {
    expect(barState(null, [], [])).toMatchObject({ add: { disabled: "Open a scene first" }, fit: { disabled: "Open a scene first" } });
    expect(barState(d, [], []).add.disabled).toBe("Select an element first");
  });
});

describe("+ Add keys what is already animated", () => {
  const d = doc([
    { objectId: "a", property: "x", keys: [key(0, 0), key(20, 100)] },
    { objectId: "a", property: "opacity", keys: [key(0, 0), key(20, 1)] },
    { objectId: "b", property: "y", keys: [key(10, 6)] },
  ]);

  it("adds one key per animated property at the playhead, at the value its curve has there", () => {
    const plan = planAddKeys(d, ["a"], 10, "ease-in-out");
    expect(plan).toMatchObject({ label: "Add 2 keys at frame 10" });
    const edits = (plan as unknown as { edits: { objectId: string; property: string; keyframe: { value: number; frame: unknown; easing: string } }[] }).edits;
    expect(edits.map((e) => [e.objectId, e.property, e.keyframe.value, e.keyframe.easing])).toEqual([["a", "x", 50, "ease-in-out"], ["a", "opacity", 0.5, "ease-in-out"]]);
  });

  it("covers every selected element, each at its own value", () => {
    const plan = planAddKeys(d, ["a", "b"], 15, "ease-in-out") as unknown as { edits: { objectId: string; property: string; keyframe: { value: number } }[] };
    expect(plan.edits.map((e) => [e.objectId, e.property])).toEqual([["a", "x"], ["a", "opacity"], ["b", "y"]]);
    expect(plan.edits[2]!.keyframe.value).toBe(6);
  });

  it("names the one property when only one is keyed", () => {
    expect(planAddKeys(d, ["b"], 0, "linear")).toMatchObject({ label: "Add Y key at frame 0" });
  });

  it("leaves a property that already has a key at that frame alone", () => {
    const mixed = doc([
      { objectId: "a", property: "x", keys: [key(0, 0), key(10, 7)] },
      { objectId: "a", property: "opacity", keys: [key(0, 0), key(20, 1)] },
    ]);
    const plan = planAddKeys(mixed, ["a"], 10, "linear") as unknown as { edits: { property: string }[]; label: string };
    expect(plan.edits.map((e) => e.property)).toEqual(["opacity"]);
    expect(plan.label).toBe("Add Opacity key at frame 10");
  });

  it("refuses by name when everything already has a key there, or nothing is animated, or the frame is not one", () => {
    expect(planAddKeys(d, ["a"], 20, "linear")).toEqual({ refused: "Every animated property already has a key at frame 20." });
    expect(planAddKeys(doc([]), ["a"], 5, "linear")).toEqual({ refused: "Nothing here is animated yet. Click a property's keyframe diamond to start keyframing it." });
    expect(planAddKeys(d, ["zzz"], 5, "linear")).toMatchObject({ refused: expect.stringContaining("Nothing here is animated") });
    expect(planAddKeys(d, ["a"], -1, "linear")).toEqual({ refused: "The playhead is not on a frame." });
    expect(planAddKeys(d, ["a"], 1.5, "linear")).toEqual({ refused: "The playhead is not on a frame." });
  });
});

describe("Zoom to fit", () => {
  it("is the whole pixels per frame that fit the scene in the stage", () => {
    expect(fitZoom(250, 1000)).toEqual({ pixelsPerFrame: 4, fits: true });
    expect(fitZoom(250, 1100)).toEqual({ pixelsPerFrame: 4, fits: true });
  });

  it("stays inside the slider's range, and says when the scene cannot fit even at the smallest", () => {
    expect(fitZoom(10, 1000)).toEqual({ pixelsPerFrame: ZOOM_MAX, fits: true });
    expect(fitZoom(5000, 1000)).toEqual({ pixelsPerFrame: ZOOM_MIN, fits: false });
    expect(fitZoom(0, 1000)).toEqual({ pixelsPerFrame: ZOOM_MIN, fits: false });
    expect(fitZoom(100, 0)).toEqual({ pixelsPerFrame: ZOOM_MIN, fits: false });
  });
});

describe("the timeline's on-demand groups (visibility decision of 26 Nov 2026)", () => {
  it("are offered by the right-click menu, each opening a popover the page has, and Stagger's caret is made by the page", async () => {
    expect(TIMELINE_MENU.map(([, label]) => label)).toEqual(["Stagger settings…", "Easing…", "Motion presets…", "Phases…"]);
    const nodeFs = "node:fs";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: string): string };
    const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const main = fs.readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
    for (const [id, label] of TIMELINE_MENU) {
      expect(html.includes(`id="${id}"`) || main.includes(`caret.id = "${id}"`), id).toBe(true);
      // Each item opens its own group: the opener the page has says the same words.
      if (html.includes(`id="${id}"`)) expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*>${label}<`));
    }
    // Every popover starts closed, and nothing in them lost its id.
    for (const id of ["stagger-popover", "tl-group-keys", "tl-group-presets", "tl-group-phases"]) {
      expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
    }
    for (const id of ["stagger-step", "stagger-order", "stagger-reverse", "stagger-centre", "timeline-easing", "timeline-preset", "timeline-preset-apply", "phase-set", "phase-play", "phase-remove"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
});

describe("Auto-key in the bar (Figma B3; Jev, 26 Nov 2026)", () => {
  it("can be pressed with no scene open and says whether it is on", () => {
    expect(barState(null, [], [])["auto-key"]).toEqual({});
    expect(barState(null, [], [], true)["auto-key"]).toEqual({ active: true });
    expect(barState(doc([]), [], [], false)["auto-key"].disabled).toBeUndefined();
  });
});

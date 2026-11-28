// Effects & Presets and Effect Controls (11.69, 11.70): the browser offers what
// the contract's surface says and nothing else, and every stack edit is a value
// in, a value (or a named refusal) out.

import { describe, expect, it } from "vitest";

import type { EffectInstance, EffectListing, EffectParameter, EffectSurface, PresetListing } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import {
  addEffect,
  addPreset,
  availability,
  browserGroupIds,
  duplicateEffect,
  effectChannel,
  effectControlsPanel,
  effectsBrowserPanel,
  freshEffectId,
  isRefused,
  isTextAnimatorPreset,
  listingFor,
  moveEffect,
  optionLabel,
  parameterLabel,
  parameterValue,
  parseControlId,
  removeEffect,
  setEnabled,
  setParameter,
  textAnimatorPresetEdit,
  toggleGroup,
  type Stack,
} from "../src/effects-panel";

const number = (path: string, def: number, min?: number, max?: number): EffectParameter =>
  ({ path, kind: "number", default: def, options: [], ...(min === undefined ? {} : { min, max }) }) as EffectParameter;

const GLOW: EffectListing = {
  id: "ec.stylize.glow",
  name: "Glow",
  category: "Stylize",
  available: true,
  template: { effect: "glow", threshold: 0.6, radius: 10, intensity: 1, dimensions: "horizontal-and-vertical" },
  parameters: [
    number("threshold", 0.6, 0, 1),
    number("radius", 10, 0, 1000),
    number("intensity", 1, 0, 10),
    { path: "dimensions", kind: "choice", default: 0, options: ["horizontal-and-vertical", "horizontal", "vertical"] },
  ],
} as unknown as EffectListing;

const FILL: EffectListing = {
  id: "ec.generate.fill",
  name: "Fill",
  category: "Generate",
  available: true,
  template: { effect: "fill", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1 },
  parameters: [number("color.r", 1, 0, 1), number("opacity", 1, 0, 1)],
} as unknown as EffectListing;

const SHADOW: EffectListing = {
  id: "ec.perspective.dropshadow",
  name: "Drop Shadow",
  category: "Perspective",
  available: true,
  template: { effect: "drop-shadow", opacity: 0.5, direction: 135, distance: 5, softness: 0, shadowOnly: false },
  parameters: [number("direction", 135), { path: "shadowOnly", kind: "switch", default: 0, options: [] }],
} as unknown as EffectListing;

const WARP: EffectListing = { id: "ec.distort.warp", name: "Warp", category: "Distort", available: false, parameters: [] } as unknown as EffectListing;

const LOOK: PresetListing = {
  id: "gx.look.soft-glow",
  name: "Soft glow",
  category: "Looks",
  description: "A gentle bloom.",
  source: "GrapiX",
  effects: [{ effectId: "glow", enabled: true, effect: "glow", threshold: 0.6, radius: 18, intensity: 0.8, dimensions: "horizontal-and-vertical" }],
} as unknown as PresetListing;

const TYPEWRITER: PresetListing = {
  id: "ec.textanimator.typewriter",
  name: "Typewriter",
  category: "Text animators",
  description: "Characters appear one at a time.",
  source: "EffectCraft",
  effects: [],
  unavailable: "needs text animators",
} as unknown as PresetListing;

/** A text animator preset the engine draws (11.61 slice P): no `unavailable`. */
const FADE_UP: PresetListing = {
  id: "ec.textanimator.fadeUpCharacters",
  name: "Fade up characters",
  category: "Text animators",
  description: "Characters rise and fade in.",
  source: "EffectCraft",
  effects: [],
  unavailable: null,
} as unknown as PresetListing;

const SURFACE: EffectSurface = {
  attribution: "Effect catalogue from EffectCraft",
  effects: [GLOW, FILL, SHADOW, WARP],
  presets: [LOOK, TYPEWRITER],
};

const stackOf = (...listings: EffectListing[]): Stack =>
  listings.reduce<Stack>((stack, listing) => {
    const next = addEffect(stack, listing);
    if (isRefused(next)) throw new Error(next.refused);
    return next;
  }, []);
const ok = (value: Stack | { refused: string }): Stack => {
  if (isRefused(value)) throw new Error(value.refused);
  return value;
};

describe("no effect and no preset is ever left out of the browser (invariant 86)", () => {
  // The whole EffectCraft catalogue is 306 effects in many categories, not the four of SURFACE above: a cap, a page size or a category
  // filter that quietly dropped some would still pass a four-effect test.
  const categories = ["Blur", "Channel", "Color", "Distort", "Generate", "Key", "Perspective", "Stylize", "Transition", "Utility"];
  const many: EffectSurface = {
    attribution: "Effect catalogue from EffectCraft",
    effects: Array.from({ length: 306 }, (_, i) => ({
      ...(i % 7 === 0 ? GLOW : WARP),
      id: `ec.${categories[i % categories.length]!.toLowerCase()}.effect${i}`,
      name: `Effect ${i}`,
      category: categories[i % categories.length]!,
    })) as unknown as EffectListing[],
    presets: Array.from({ length: 8 }, (_, i) => ({ ...(i % 2 === 0 ? LOOK : TYPEWRITER), id: `ec.preset.p${i}`, name: `Preset ${i}` })) as unknown as PresetListing[],
  };

  it("lists every catalogued effect and preset when nothing is hidden", () => {
    const panel = effectsBrowserPanel({ surface: many, query: "", showUnported: true });
    const missing = many.effects.filter((e) => findNode(panel, `effect/${e.id}`) === undefined).map((e) => e.id);
    expect(missing).toEqual([]);
    const missingPresets = many.presets.filter((p) => findNode(panel, `preset/${p.id}`) === undefined).map((p) => p.id);
    expect(missingPresets).toEqual([]);
  });

  it("finds each effect by its name, so a search never loses one", () => {
    for (const effect of many.effects.filter((_, i) => i % 23 === 0)) {
      const panel = effectsBrowserPanel({ surface: many, query: effect.name, showUnported: true });
      expect(findNode(panel, `effect/${effect.id}`), effect.id).toBeDefined();
    }
  });
});

describe("the browser lists the surface and never pretends", () => {
  it("counts what the engine renders against what is catalogued", () => {
    expect(availability(SURFACE)).toEqual({ available: 3, total: 4 });
    const panel = effectsBrowserPanel({ surface: SURFACE, query: "", showUnported: true });
    expect(panel.description).toContain("3 of 4 effects render on the GrapiX engine");
    expect(panel.description).toContain("EffectCraft");
  });

  it("offers an available effect and names why a catalogued one cannot be applied", () => {
    const panel = effectsBrowserPanel({ surface: SURFACE, query: "", showUnported: true });
    const glow = agentView(findNode(panel, "effect/ec.stylize.glow")!);
    expect(glow.actions).toEqual([{ name: "apply", label: "Apply", available: true }]);
    const warp = agentView(findNode(panel, "effect/ec.distort.warp")!);
    expect(warp.actions[0]!.available).toBe(false);
    expect(warp.actions[0]!.unavailableReason).toMatch(/not yet ported to the GrapiX engine/);
  });

  it("with no object selected nothing applies, and the reason is the caller's", () => {
    const panel = effectsBrowserPanel({ surface: SURFACE, query: "", showUnported: true, targetBlocker: "select a scene object first" });
    expect(agentView(findNode(panel, "effect/ec.stylize.glow")!).actions[0]!.unavailableReason).toBe("select a scene object first");
    expect(agentView(findNode(panel, "preset/gx.look.soft-glow")!).actions[0]!.unavailableReason).toBe("select a scene object first");
    // A preset that waits on the engine keeps its own reason.
    expect(agentView(findNode(panel, "preset/ec.textanimator.typewriter")!).actions[0]!.unavailableReason).toBe("needs text animators");
  });

  it("hiding unported effects drops them and their empty categories, and the count still says the total", () => {
    const panel = effectsBrowserPanel({ surface: SURFACE, query: "", showUnported: false });
    expect(findNode(panel, "effect/ec.distort.warp")).toBeUndefined();
    expect(findNode(panel, "effects-browser/distort")).toBeUndefined();
    expect(findNode(panel, "preset/ec.textanimator.typewriter")).toBeUndefined();
    expect(panel.description).toContain("3 of 4");
  });

  it("searches name, category and id, and says when nothing matches", () => {
    const by = (query: string) => effectsBrowserPanel({ surface: SURFACE, query, showUnported: true });
    expect(findNode(by("GLOW"), "effect/ec.stylize.glow")).toBeDefined();
    expect(findNode(by("glow"), "effect/ec.generate.fill")).toBeUndefined();
    expect(findNode(by("perspective"), "effect/ec.perspective.dropshadow")).toBeDefined();
    expect(findNode(by("ec.distort"), "effect/ec.distort.warp")).toBeDefined();
    expect(findNode(by("zzz"), "effects-browser/no-match")!.value).toMatch(/No effects or presets match/);
  });

  it("groups by category with a usable count", () => {
    const panel = effectsBrowserPanel({ surface: SURFACE, query: "", showUnported: true });
    expect(findNode(panel, "effects-browser/stylize")!.description).toBe("1 of 1 usable");
    expect(findNode(panel, "effects-browser/distort")!.description).toBe("0 of 1 usable");
    expect(findNode(panel, "effects-browser/presets/looks")!.label).toBe("Presets · Looks");
  });
});

describe("stack edits", () => {
  it("adds an effect at its defaults under a fresh id, and refuses one that is not ported", () => {
    const stack = stackOf(GLOW, GLOW);
    expect(stack.map((e) => e.effectId)).toEqual(["glow", "glow-2"]);
    expect(stack[0]).toMatchObject({ enabled: true, effect: "glow", radius: 10 });
    // The template is copied, never shared.
    expect(stack[0]).not.toBe(stack[1]);
    const refused = addEffect(stack, WARP);
    expect(isRefused(refused) && refused.refused).toMatch(/Warp is catalogued but not yet ported/);
  });

  it("adds a preset's effects under fresh ids, and refuses one that waits on the engine by its reason", () => {
    const stack = ok(addPreset(stackOf(GLOW), LOOK));
    expect(stack.map((e) => e.effectId)).toEqual(["glow", "glow-2"]);
    expect(stack[1]).toMatchObject({ radius: 18, intensity: 0.8 });
    const refused = addPreset([], TYPEWRITER);
    expect(isRefused(refused) && refused.refused).toBe("Typewriter: needs text animators");
  });

  it("applies a text animator preset as one edit at the playhead, and refuses by name what it cannot", () => {
    expect(isTextAnimatorPreset(FADE_UP)).toBe(true);
    expect(isTextAnimatorPreset(LOOK)).toBe(false);
    const text = { id: "title", name: "Title", type: "text" };
    expect(textAnimatorPresetEdit(text, FADE_UP, 12)).toEqual({
      edit: "applyTextAnimatorPreset",
      objectId: "title",
      presetId: "ec.textanimator.fadeUpCharacters",
      atFrame: 12,
    });
    const notText = textAnimatorPresetEdit({ id: "box", name: "Box", type: "rect" }, FADE_UP, 0);
    expect(isRefused(notText) && notText.refused).toBe("Fade up characters animates text: select a text object (Box is rect)");
    const waiting = textAnimatorPresetEdit(text, TYPEWRITER, 0);
    expect(isRefused(waiting) && waiting.refused).toBe("Typewriter: needs text animators");
    for (const frame of [-1, 1.5, Number.NaN]) expect(isRefused(textAnimatorPresetEdit(text, FADE_UP, frame)), String(frame)).toBe(true);
    // It is not an effect stack edit: addPreset says so.
    const stacked = addPreset([], FADE_UP);
    expect(isRefused(stacked) && stacked.refused).toMatch(/is a text animator: it is applied to a text/);
  });

  it("dims a text animator preset on a target that is not a text, and not on a text", () => {
    const surface: EffectSurface = { ...SURFACE, presets: [LOOK, FADE_UP] };
    const why = (targetType: string | undefined) =>
      agentView(findNode(effectsBrowserPanel({ surface, query: "", showUnported: false, ...(targetType === undefined ? {} : { targetType }) }), "preset/ec.textanimator.fadeUpCharacters")!).actions[0]!
        .unavailableReason;
    expect(why("rect")).toBe("a text animator is applied to a text object: select one");
    expect(why("text")).toBeUndefined();
    expect(why(undefined)).toBeUndefined();
    // An ordinary preset is not held to a text.
    const look = effectsBrowserPanel({ surface, query: "", showUnported: false, targetType: "rect" });
    expect(agentView(findNode(look, "preset/gx.look.soft-glow")!).actions[0]!.unavailableReason).toBeUndefined();
  });

  it("removes, duplicates below itself, and toggles", () => {
    const stack = stackOf(GLOW, FILL);
    expect(ok(removeEffect(stack, "glow")).map((e) => e.effectId)).toEqual(["fill"]);
    expect(ok(duplicateEffect(stack, "glow")).map((e) => e.effectId)).toEqual(["glow", "glow-2", "fill"]);
    expect(ok(setEnabled(stack, "fill", false))[1]!.enabled).toBe(false);
    expect(stack[1]!.enabled).toBe(true);
    expect(isRefused(removeEffect(stack, "nope"))).toBe(true);
  });

  it("moves one place and refuses at the ends by name", () => {
    const stack = stackOf(GLOW, FILL, SHADOW);
    expect(ok(moveEffect(stack, "fill", -1)).map((e) => e.effectId)).toEqual(["fill", "glow", "drop-shadow"]);
    expect(ok(moveEffect(stack, "fill", 1)).map((e) => e.effectId)).toEqual(["glow", "drop-shadow", "fill"]);
    const first = moveEffect(stack, "glow", -1);
    expect(isRefused(first) && first.refused).toBe("glow is already first");
    const last = moveEffect(stack, "drop-shadow", 1);
    expect(isRefused(last) && last.refused).toBe("drop-shadow is already last");
  });

  it("sets a number inside its range, and refuses out of range and not-a-number by name", () => {
    const stack = stackOf(GLOW);
    const radius = GLOW.parameters[1]!;
    const next = ok(setParameter(stack, "glow", radius, "42.5"));
    expect((next[0] as unknown as { radius: number }).radius).toBe(42.5);
    expect((stack[0] as unknown as { radius: number }).radius).toBe(10);
    const high = setParameter(stack, "glow", radius, "1001");
    expect(isRefused(high) && high.refused).toBe("Radius must be between 0 and 1000");
    const text = setParameter(stack, "glow", radius, "wide");
    expect(isRefused(text) && text.refused).toBe("Radius needs a number");
    expect(isRefused(setParameter(stack, "glow", radius, ""))).toBe(true);
  });

  it("writes a nested path, a switch and a choice as their wire values", () => {
    const fill = ok(setParameter(stackOf(FILL), "fill", FILL.parameters[0]!, 0.25));
    expect((fill[0] as unknown as { color: { r: number; g: number } }).color).toMatchObject({ r: 0.25, g: 0 });
    const shadow = ok(setParameter(stackOf(SHADOW), "drop-shadow", SHADOW.parameters[1]!, true));
    expect((shadow[0] as unknown as { shadowOnly: boolean }).shadowOnly).toBe(true);
    const glow = ok(setParameter(stackOf(GLOW), "glow", GLOW.parameters[3]!, 2));
    expect((glow[0] as unknown as { dimensions: string }).dimensions).toBe("vertical");
    const bad = setParameter(stackOf(GLOW), "glow", GLOW.parameters[3]!, 9);
    expect(isRefused(bad) && bad.refused).toBe("Dimensions has no option 9");
  });

  it("reads a parameter as the table does: number, switch as 0 or 1, choice as its index", () => {
    const [glow] = stackOf(GLOW) as EffectInstance[];
    expect(parameterValue(glow!, GLOW.parameters[1]!)).toBe(10);
    expect(parameterValue(glow!, GLOW.parameters[3]!)).toBe(0);
    const [shadow] = stackOf(SHADOW) as EffectInstance[];
    expect(parameterValue(shadow!, SHADOW.parameters[1]!)).toBe(0);
  });

  it("fresh ids skip the ones taken", () => {
    expect(freshEffectId([], "glow")).toBe("glow");
    expect(freshEffectId(stackOf(GLOW, GLOW, GLOW), "glow")).toBe("glow-4");
  });
});

describe("Effect Controls", () => {
  const stack = stackOf(GLOW, SHADOW);
  const panel = effectControlsPanel({
    surface: SURFACE,
    objectName: "Strap",
    effects: stack,
    keyedChannels: new Set([effectChannel("glow", "radius")]),
  });

  it("lists the stack in order with the catalogue's names and what each can do", () => {
    expect(panel.description).toBe("2 effect(s) on Strap");
    expect(panel.children!.map((child) => child.label)).toEqual(["Glow", "Drop Shadow"]);
    const glow = agentView(findNode(panel, "fx/glow")!);
    expect(glow.actions.map((a) => [a.name, a.available])).toEqual([
      ["toggle", true],
      ["moveUp", false],
      ["moveDown", true],
      ["duplicate", true],
      ["remove", true],
    ]);
    expect(agentView(findNode(panel, "fx/drop-shadow")!).actions.find((a) => a.name === "moveDown")!.unavailableReason).toBe("already last");
  });

  it("gives a number its field and range, a switch a checkbox, and a choice its options", () => {
    const radius = findNode(panel, "fx/glow/radius")!;
    expect(radius.input).toEqual({ type: "number", value: "10" });
    expect(radius.description).toBe("0 to 1000 · keyframed");
    expect(findNode(panel, "fx/glow/threshold")!.description).toBe("0 to 1");
    expect(findNode(panel, "fx/drop-shadow/direction")!.description).toBe("any number");
    expect(findNode(panel, "fx/drop-shadow/shadowOnly")!.input).toEqual({ type: "checkbox", value: "false" });
    const dimensions = agentView(findNode(panel, "fx/glow/dimensions")!);
    expect(dimensions.value).toBe("Dimensions: Horizontal and vertical");
    expect(dimensions.actions.map((a) => [a.name, a.available])).toEqual([
      ["choose:0", false],
      ["choose:1", true],
      ["choose:2", true],
      ["key", true],
    ]);
  });

  it("shows whether a parameter is keyed on its key action", () => {
    expect(findNode(panel, "fx/glow/radius")!.actions!.find((a) => a.name === "key")!.label).toBe("◆ Key");
    expect(findNode(panel, "fx/glow/threshold")!.actions!.find((a) => a.name === "key")!.label).toBe("◇ Key");
  });

  it("finds an instance's listing by its effect, and reads ids back", () => {
    expect(listingFor(SURFACE, stack[1]!)!.name).toBe("Drop Shadow");
    expect(parseControlId("fx/glow")).toEqual({ effectId: "glow" });
    expect(parseControlId("fx/fill/color.r")).toEqual({ effectId: "fill", path: "color.r" });
    expect(parseControlId("fx/glow/parameters")).toEqual({ effectId: "glow", path: "parameters" });
    expect(parseControlId("effect/ec.x")).toBeUndefined();
    expect(effectChannel("glow", "radius")).toBe("effects.glow.radius");
  });
});

describe("labels", () => {
  it("reads paths and options as words", () => {
    expect(parameterLabel("rgb.inputBlack")).toBe("RGB · Input black");
    expect(parameterLabel("color.r")).toBe("Color · R");
    expect(parameterLabel("rgb.0.x")).toBe("RGB · Point 1 · X");
    expect(parameterLabel("repeatEdgePixels")).toBe("Repeat edge pixels");
    expect(optionLabel("horizontal-and-vertical")).toBe("Horizontal and vertical");
  });
});

describe("categories as dropdowns (11.79)", () => {
  const base = { surface: SURFACE, query: "", showUnported: true } as const;
  const groups = (input: Partial<Parameters<typeof effectsBrowserPanel>[0]> = {}) =>
    effectsBrowserPanel({ ...base, ...input });

  it("shows every category folded until the author opens it", () => {
    const panel = groups();
    const ids = browserGroupIds(panel);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(findNode(panel, id)!.expanded).toBe(false);
  });

  it("opens exactly the categories in the open set", () => {
    const panel = groups({ expanded: new Set(["effects-browser/stylize"]) });
    expect(findNode(panel, "effects-browser/stylize")!.expanded).toBe(true);
    expect(findNode(panel, "effects-browser/distort")!.expanded).toBe(false);
  });

  it("opens every category that has a match while a search is typed, whatever was open", () => {
    const panel = groups({ query: "glow", expanded: new Set() });
    const open = browserGroupIds(panel).map((id) => findNode(panel, id)!.expanded);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((flag) => flag === true)).toBe(true);
  });

  it("keeps the folded effects in the agent's view, so folding hides nothing from it", () => {
    const folded = groups();
    expect(findNode(folded, `effect/${GLOW.id}`)).toBeDefined();
  });

  it("toggles one category without changing the set it was given", () => {
    const before = new Set(["a"]);
    const opened = toggleGroup(before, "b");
    expect([...opened].sort()).toEqual(["a", "b"]);
    expect([...before]).toEqual(["a"]);
    expect([...toggleGroup(opened, "a")]).toEqual(["b"]);
  });

  it("lists no group for a search that matches nothing, so Expand all opens nothing", () => {
    const panel = groups({ query: "zzz-no-such-effect" });
    expect(browserGroupIds(panel)).toEqual([]);
    expect(findNode(panel, "effects-browser/no-match")).toBeDefined();
  });

  it("lists every category group, presets first, for Expand all", () => {
    const panel = groups();
    const ids = browserGroupIds(panel);
    expect(ids[0]).toMatch(/^effects-browser\/presets\//);
    expect(ids).toContain("effects-browser/stylize");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

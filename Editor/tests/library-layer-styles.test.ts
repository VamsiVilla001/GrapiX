// The Library's Layer styles tab (Figma B13; row 11.122): what a style keeps of an object's effects, what Add, Replace and Update can do with the
// selection, and the tab inside the Library panel. A library style is applied by copy, so use is counted by exact stack in the open graphic.

import { describe, expect, it } from "vitest";

import type { EffectInstance, LibraryLayerStyle, SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import { libraryPanel } from "../src/library";
import {
  STYLES_NEED_PROJECT,
  STYLES_NOTE,
  addBlocker,
  effectWords,
  effectsOf,
  fromEffectsBlocker,
  keepable,
  layerStylesNodes,
  maskLimits,
  replaceBlocker,
  stackKey,
  styleUse,
  withFreshIds,
} from "../src/library-layer-styles";

const shadow = (extra: Record<string, unknown> = {}): EffectInstance =>
  ({ effectId: "drop-shadow", enabled: true, effect: "drop-shadow", opacity: 0.5, distance: 8, color: { r: 0, g: 0, b: 0, a: 1, space: "srgb" }, ...extra }) as unknown as EffectInstance;
const glow = (extra: Record<string, unknown> = {}): EffectInstance =>
  ({ effectId: "glow", enabled: true, effect: "glow", radius: 12, ...extra }) as unknown as EffectInstance;
const style = (id: string, name: string, effects: EffectInstance[]): LibraryLayerStyle => ({ id, name, effects });

const base = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  x: 0,
  y: 0,
  zDepth: 0,
  zIndex: 0,
  layerId: "",
  width: 10,
  height: 10,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  strokeWidth: 0,
});
const rect = (id: string, effects?: EffectInstance[]): SceneObject =>
  ({ type: "rect", ...base(id), radius: 0, ...(effects === undefined ? {} : { effects }) }) as unknown as SceneObject;
const scene = (objects: SceneObject[], channels: { objectId: string; property: string }[] = []): SceneDocument =>
  ({ id: "s", name: "S", version: 1, objects, assets: [], fonts: [], materials: [], timeline: { durationFrames: 1, channels } }) as unknown as SceneDocument;

describe("what an effect says for itself", () => {
  it("is its wire tag as words when the catalogue's name is not at hand", () => {
    expect(effectWords(shadow())).toBe("Drop shadow");
    expect(effectWords(glow())).toBe("Glow");
    expect(effectWords({ ...glow(), effect: "gaussian-blur" } as unknown as EffectInstance)).toBe("Gaussian blur");
  });
});

describe("what a style keeps of a stack", () => {
  it("keeps the effects, their order, ids, switches and settings, as a copy", () => {
    const stack = [glow(), shadow({ enabled: false })];
    const kept = keepable(stack);
    expect(kept).toEqual(stack);
    expect(kept[0]).not.toBe(stack[0]);
    (kept[0] as unknown as { radius: number }).radius = 99;
    expect((stack[0] as unknown as { radius: number }).radius).toBe(12);
    // A setting that is itself an object (a colour) is copied too, not shared.
    (kept[1] as unknown as { color: { r: number } }).color.r = 1;
    expect((stack[1] as unknown as { color: { r: number } }).color.r).toBe(0);
  });

  it("does not keep the limits to an object's own masks, and counts how many it dropped", () => {
    const stack = [glow({ maskIds: ["mask-1"] }), shadow({ maskIds: [] }), shadow({ effectId: "s2" })];
    expect(maskLimits(stack)).toBe(1);
    expect(keepable(stack).some((instance) => "maskIds" in instance)).toBe(false);
    expect(maskLimits(keepable(stack))).toBe(0);
    expect(stack[0]).toHaveProperty("maskIds", ["mask-1"]);
  });

  it("gives an applied effect a fresh id where the object already uses its own", () => {
    const onObject = [shadow(), glow()];
    const added = withFreshIds(onObject, [shadow(), glow()]);
    expect(added.map((instance) => instance.effectId)).toEqual(["drop-shadow-2", "glow-2"]);
    expect(added.map((instance) => instance.effect)).toEqual(["drop-shadow", "glow"]);
    expect(withFreshIds([], [shadow(), glow()]).map((instance) => instance.effectId)).toEqual(["drop-shadow", "glow"]);
    // Two effects of one style that share a base keep distinct ids on the object.
    expect(withFreshIds([], [shadow(), shadow({ effectId: "drop-shadow" })]).map((instance) => instance.effectId)).toEqual(["drop-shadow", "drop-shadow-2"]);
  });

  it("never changes the stack it was given, and gives the object its own copy of every setting", () => {
    const onObject = [shadow()];
    const fromStyle = [shadow()];
    const added = withFreshIds(onObject, fromStyle);
    expect(onObject).toHaveLength(1);
    (added[0] as unknown as { color: { r: number } }).color.r = 1;
    expect((fromStyle[0] as unknown as { color: { r: number } }).color.r).toBe(0);
  });
});

describe("a stack's identity", () => {
  it("ignores the ids an object gave the effects and the limits to its masks, and the order of the keys", () => {
    const a = [shadow({ effectId: "one" })];
    const b = [shadow({ effectId: "two", maskIds: ["m"] })];
    expect(stackKey(a)).toBe(stackKey(b));
    const reordered = [
      { color: { space: "srgb", a: 1, b: 0, g: 0, r: 0 }, opacity: 0.5, effect: "drop-shadow", effectId: "x", distance: 8, enabled: true } as unknown as EffectInstance,
    ];
    expect(stackKey(reordered)).toBe(stackKey(a));
  });

  it("tells apart a different setting, a switched-off effect and a different order", () => {
    expect(stackKey([shadow({ distance: 9 })])).not.toBe(stackKey([shadow()]));
    expect(stackKey([shadow({ enabled: false })])).not.toBe(stackKey([shadow()]));
    expect(stackKey([glow(), shadow()])).not.toBe(stackKey([shadow(), glow()]));
    expect(stackKey([shadow()])).not.toBe(stackKey([shadow(), glow()]));
  });

  it("counts the objects of the open graphic with exactly this stack now, never an object with none", () => {
    const document = scene([rect("a", [shadow()]), rect("b", [shadow({ effectId: "other" })]), rect("c", [shadow({ distance: 1 })]), rect("d"), rect("e", [])]);
    expect(styleUse(document, [shadow()])).toBe(2);
    expect(styleUse(document, [glow()])).toBe(0);
    expect(effectsOf(rect("d"))).toEqual([]);
  });
});

describe("making a style from the selection", () => {
  const document = scene([rect("a", [shadow()]), rect("b"), rect("c", [glow()])]);

  it("needs exactly one selected object with effects", () => {
    expect(fromEffectsBlocker(document, ["a"])).toBeUndefined();
    expect(fromEffectsBlocker(document, [])).toBe("select an object whose effects to keep");
    expect(fromEffectsBlocker(document, ["a", "c"])).toBe("select one object: a style is made from one object's effects");
    expect(fromEffectsBlocker(document, ["b"])).toBe("b has no effects");
    expect(fromEffectsBlocker(document, ["gone"])).toBe("select an object whose effects to keep");
  });

  it("refuses an object with more effects than a style holds, saying how many", () => {
    const many = Array.from({ length: 33 }, (_, n) => shadow({ effectId: `s${n}` }));
    expect(fromEffectsBlocker(scene([rect("a", many)]), ["a"])).toBe("a has 33 effects: a style holds at most 32");
    const most = Array.from({ length: 32 }, (_, n) => shadow({ effectId: `s${n}` }));
    expect(fromEffectsBlocker(scene([rect("a", most)]), ["a"])).toBeUndefined();
  });
});

describe("applying a style", () => {
  it("can be added to any selection, and says to select an object first when there is none", () => {
    const document = scene([rect("a")]);
    expect(addBlocker(document, ["a"])).toBeUndefined();
    expect(addBlocker(document, [])).toBe("select an object first");
    expect(addBlocker(document, ["gone"])).toBe("select an object first");
  });

  it("replaces the effects of an object that has none of them keyframed", () => {
    expect(replaceBlocker(scene([rect("a", [shadow()])], [{ objectId: "a", property: "opacity" }]), ["a"])).toBeUndefined();
    expect(replaceBlocker(scene([rect("a")]), [])).toBe("select an object first");
  });

  it("will not replace effects that are keyframed, naming the object, because the keys would be orphaned", () => {
    const document = scene([rect("a", [shadow()]), rect("b")], [{ objectId: "a", property: "effects.drop-shadow.opacity" }]);
    expect(replaceBlocker(document, ["a"])).toBe("a's effects are keyframed: replacing them would orphan the keys. Remove the keys first, or use Add to effects");
    expect(replaceBlocker(document, ["b", "a"])).toContain("a's effects are keyframed");
    // Another object's keys do not count.
    expect(replaceBlocker(document, ["b"])).toBeUndefined();
  });
});

describe("the Layer styles tab", () => {
  const document = scene([rect("a", [shadow()]), rect("b"), rect("c", [shadow({ effectId: "x" })])]);
  const styles = [style("style-1", "Soft shadow", [shadow()]), style("style-2", "Neon", [glow(), shadow({ enabled: false })])];
  const nodes = (extra: Record<string, unknown> = {}) => layerStylesNodes(document, { project: true, styles, ...extra });
  const wrap = (children: ReturnType<typeof nodes>) => ({ id: "w", role: "region" as const, label: "w", children });

  it("says a graphic that is not in a project cannot keep layer styles, and dims the maker with the same words", () => {
    const [list] = layerStylesNodes(document, { project: false });
    expect(list!.description).toBe(STYLES_NEED_PROJECT);
    expect(list!.actions![0]!.unavailable).toBe(STYLES_NEED_PROJECT);
  });

  it("says the styles are being read, or why they could not be, and dims the maker", () => {
    const [reading] = layerStylesNodes(document, { project: true });
    expect(reading!.description).toBe("reading the project's layer styles…");
    expect(reading!.actions![0]!.unavailable).toBe("the project's layer styles have not been read");
    const [failed] = layerStylesNodes(document, { project: true, stylesProblem: "the project's layer styles could not be read: x" });
    expect(failed!.description).toBe("the project's layer styles could not be read: x");
  });

  it("lists a card for each style with its effects and its switches, in the order they were made", () => {
    const list = nodes()[0]!;
    expect(list.description).toBe("2 layer styles");
    expect(list.children!.map((c) => [c.id, c.label, c.value])).toEqual([
      ["style/style-1", "Soft shadow", "Drop shadow"],
      ["style/style-2", "Neon", "Glow · Drop shadow (off)"],
    ]);
    expect(list.children![1]!.actions![0]!.label).toBe("Neon · Glow, Drop shadow (off)");
    expect(nodes({ selectedStyleId: "style-2" })[0]!.children!.map((c) => c.selected)).toEqual([false, true]);
  });

  it("uses the catalogue's names when it is given them", () => {
    const named = nodes({ effectName: (instance: EffectInstance) => (instance.effect === "glow" ? "Outer Glow" : "Shadow") })[0]!;
    expect(named.children![1]!.value).toBe("Outer Glow · Shadow (off)");
  });

  it("says there are no styles yet, and one style in the singular", () => {
    expect(layerStylesNodes(document, { project: true, styles: [] })[0]!.description).toBe("no layer styles yet: select an object with effects and make one from them");
    expect(layerStylesNodes(document, { project: true, styles: [styles[0]!] })[0]!.description).toBe("1 layer style");
  });

  it("makes a style from the selected object's effects, dimmed with the reason when it cannot", () => {
    expect(nodes({ selectedObjectIds: ["a"] })[0]!.actions!.map((a) => [a.name, a.label, a.unavailable])).toEqual([["newStyleFromEffects", "+ From selected effects", undefined]]);
    expect(nodes({ selectedObjectIds: ["b"] })[0]!.actions![0]!.unavailable).toBe("b has no effects");
    expect(nodes()[0]!.actions![0]!.unavailable).toBe("select an object whose effects to keep");
  });

  it("shows no card until a style is selected, then its effects, what it keeps and how many objects have it", () => {
    expect(nodes()[1]!.description).toBe("Select a layer style to apply it, rename it or update it.");
    const shown = wrap(nodes({ selectedStyleId: "style-2" }));
    const card = nodes({ selectedStyleId: "style-2" })[1]!;
    expect(card.label).toBe("Neon");
    expect(card.description).toBe("2 effects");
    expect(findNode(shown, "style/style-2/effect/0")).toMatchObject({ label: "Glow", value: "on", description: "glow" });
    expect(findNode(shown, "style/style-2/effect/1")).toMatchObject({ label: "Drop shadow", value: "off" });
    expect(findNode(shown, "style/style-2/kept")!.description).toBe("Keyframes and the limits an effect has to an object's masks are not kept.");
    expect(findNode(shown, "style/style-2/use")!.value).toBe("no object has exactly this stack");
    const used = findNode(wrap(nodes({ selectedStyleId: "style-1" })), "style/style-1/use")!;
    expect(used.value).toBe("2 objects have exactly this stack");
    expect(used.description).toBe("Counts exact matches in the open graphic only: an applied style is a copy, not a link.");
    const single = layerStylesNodes(scene([rect("a", [shadow()])]), { project: true, styles, selectedStyleId: "style-1" })[1]!;
    expect(single.children!.find((c) => c.id.endsWith("/use"))!.value).toBe("1 object has exactly this stack");
  });

  it("offers Add, Replace and Update to the selection, dimmed with the reason when they cannot, and Rename and Delete always", () => {
    const actions = (ids: string[], doc = document) => layerStylesNodes(doc, { project: true, styles, selectedStyleId: "style-1", selectedObjectIds: ids })[1]!.actions!;
    expect(actions(["a"]).map((a) => [a.name, a.unavailable])).toEqual([
      ["addStyle", undefined],
      ["replaceStyle", undefined],
      ["updateStyle", undefined],
      ["renameStyle", undefined],
      ["deleteStyle", undefined],
    ]);
    const none = actions([]);
    expect(none[0]!.unavailable).toBe("select an object first");
    expect(none[1]!.unavailable).toBe("select an object first");
    expect(none[2]!.unavailable).toBe("select an object whose effects to keep");
    expect(none[3]!.unavailable).toBeUndefined();
    expect(none[4]!.unavailable).toBeUndefined();
    // An object without effects can take a style but cannot update one.
    const bare = actions(["b"]);
    expect([bare[0]!.unavailable, bare[1]!.unavailable, bare[2]!.unavailable]).toEqual([undefined, undefined, "b has no effects"]);
    // Keyframed effects can be added to but not replaced.
    const keyed = scene([rect("a", [shadow()])], [{ objectId: "a", property: "effects.drop-shadow.distance" }]);
    const onKeyed = actions(["a"], keyed);
    expect(onKeyed[0]!.unavailable).toBeUndefined();
    expect(onKeyed[1]!.unavailable).toContain("a's effects are keyframed");
  });

  it("gives an agent the same reasons a person sees", () => {
    const view = agentView(wrap(nodes({ selectedStyleId: "style-1" })));
    const find = (node: typeof view, id: string): typeof view | undefined => (node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean));
    expect(find(view, "library/layer-style-detail")!.actions[0]).toMatchObject({ name: "addStyle", available: false, unavailableReason: "select an object first" });
  });
});

describe("the Library panel on the Layer styles tab", () => {
  const document = scene([rect("a", [shadow()])]);
  const styles = [style("style-1", "Soft shadow", [shadow()])];
  const panel = (extra: Record<string, unknown> = {}) => libraryPanel(document, { project: "show", tab: "layer-styles", layerStyles: styles, ...extra } as never);

  it("works as a tab, shows the tab strip with it selected, the cards and a note, and none of the asset grid", () => {
    const node = panel();
    expect(findNode(node, "library/tab/layer-styles")!.selected).toBe(true);
    expect(findNode(node, "library/tab/layer-styles")!.actions![0]!.unavailable).toBeUndefined();
    expect(findNode(node, "library/tab/assets")!.selected).toBe(false);
    expect(findNode(node, "library/layer-styles")!.children).toHaveLength(1);
    expect(findNode(node, "library/note")!.value).toBe(STYLES_NOTE);
    for (const gone of ["library/folders", "library/filters", "asset-manager/list", "library/detail", "library/colours"]) expect(findNode(node, gone), gone).toBeUndefined();
    expect(node.description).toBe("layer styles · kept in project show");
  });

  it("says so when the graphic is not in a project", () => {
    const loose = libraryPanel(document, { tab: "layer-styles" } as never);
    expect(loose.description).toBe("layer styles · independent scene, not in a project");
    expect(findNode(loose, "library/layer-styles")!.description).toBe(STYLES_NEED_PROJECT);
  });

  it("passes the selection, the selected style and the catalogue's names through", () => {
    const node = panel({ selectedLayerStyleId: "style-1", selectedObjectIds: ["a"], effectName: () => "Named" });
    expect(findNode(node, "style/style-1")!.value).toBe("Named");
    expect(findNode(node, "library/layer-style-detail")!.actions![0]!.unavailable).toBeUndefined();
    expect(findNode(node, "library/layer-styles")!.actions![0]!.unavailable).toBeUndefined();
  });

  it("keeps the Assets tab as it was when no tab is chosen", () => {
    const assets = libraryPanel(document, { project: "show", layerStyles: styles } as never);
    expect(findNode(assets, "library/tab/layer-styles")!.selected).toBe(false);
    expect(findNode(assets, "library/layer-styles")).toBeUndefined();
    expect(findNode(assets, "asset-manager/list")).toBeDefined();
  });

  it("still shows a notice from an action on the Layer styles tab", () => {
    expect(findNode(panel({ notice: "The layer style was not made: a Library layer style named \"x\" already exists" }), "asset-manager/notice")!.value).toContain("already exists");
  });
});

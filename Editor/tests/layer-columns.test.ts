import { describe, expect, it } from "vitest";

import type { BlendMode } from "@grapix/contracts";

import { BLEND_GROUPS, columnMenu, BLEND_LABELS, NONE, blendApplies, blendCell, layerColumns, parentChoices, parentOf, setBlend, setParent } from "../src/timeline/layer-columns";

type Doc = Parameters<typeof parentOf>[0];
const obj = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), type, visible: true, locked: false, ...extra });
const doc = (...objects: ReturnType<typeof obj>[]): Doc => ({ objects }) as unknown as Doc;
const group = (id: string, childIds: string[], extra: Record<string, unknown> = {}) => obj(id, "group", { childIds, ...extra });
const first = (o: ReturnType<typeof obj>) => o as unknown as Parameters<typeof blendCell>[0];

describe("the blend list is the design's, and the contract's", () => {
  it("has 38 modes, each in exactly one of seven groups", () => {
    const all = BLEND_GROUPS.flatMap((g) => g.modes);
    expect(BLEND_GROUPS.map((g) => g.name)).toEqual(["Normal", "Darken", "Lighten", "Contrast", "Difference", "Colour", "Alpha"]);
    expect(all).toHaveLength(38);
    expect(new Set(all).size).toBe(38);
    expect(Object.keys(BLEND_LABELS).sort()).toEqual([...all].sort());
  });

  it("names the contract's alpha modes the way After Effects does", () => {
    expect(BLEND_LABELS["alpha-mask" as BlendMode]).toBe("Stencil Alpha");
    expect(BLEND_LABELS["inverse-alpha-mask" as BlendMode]).toBe("Silhouette Alpha");
    expect(BLEND_GROUPS[6]!.modes.map((m) => BLEND_LABELS[m])).toEqual(["Stencil Alpha", "Stencil Luma", "Silhouette Alpha", "Silhouette Luma", "Alpha Add", "Luminescent Premul"]);
  });
});

describe("the BLEND cell", () => {
  it("says Normal for a drawing layer nobody set, and the mode when set", () => {
    expect(blendCell(first(obj("a", "rect")))).toEqual({ mode: "normal", label: "Normal", applies: true });
    expect(blendCell(first(obj("a", "rect", { blendMode: "multiply" }))).label).toBe("Multiply");
  });

  it("shows a dash for a kind that draws nothing", () => {
    for (const kind of ["group", "layer", "marker", "camera", "light"]) {
      expect(blendApplies(first(obj("a", kind)))).toBe(false);
      expect(blendCell(first(obj("a", kind)))).toEqual({ mode: "normal", label: NONE, applies: false });
    }
  });

  it("sets a mode, leaves it out for Normal, and refuses a silent kind by name", () => {
    const d = doc(obj("a", "rect"), obj("g", "group", { childIds: [] }));
    expect(setBlend(d, ["a"], "screen")).toEqual({ edit: "setBlendMode", objectIds: ["a"], blendMode: "screen" });
    expect(setBlend(d, ["a"], "normal")).toEqual({ edit: "setBlendMode", objectIds: ["a"] });
    expect(setBlend(d, ["a", "g"], "screen")).toEqual({ refused: "G draws nothing itself, so it has no blend mode. Nothing was changed." });
    expect(setBlend(d, ["zzz"], "screen")).toEqual({ refused: "That object is not in the scene." });
    expect(setBlend(d, [], "screen")).toEqual({ refused: "That object is not in the scene." });
  });
});

describe("the PARENT cell", () => {
  const d = doc(group("g1", ["a"]), group("g2", []), obj("a", "rect"), obj("b", "rect"), group("outer", ["g1"]));

  it("names the group an object is inside, or a dash", () => {
    expect(parentOf(d, "a")?.id).toBe("g1");
    expect(parentOf(d, "b")).toBeUndefined();
    expect(layerColumns(d, first(obj("a", "rect"))).parent).toEqual({ label: "G1", id: "g1" });
    expect(layerColumns(d, first(obj("b", "rect"))).parent).toEqual({ label: NONE });
  });

  it("offers groups only, never the object, never anything inside it", () => {
    const ids = (id: string) => parentChoices(d, d.objects.find((o) => o.id === id)!).map((c) => c.id);
    expect(ids("b")).toEqual(["g1", "g2", "outer"]);
    expect(ids("g1")).toEqual(["g2", "outer"]);
  });

  it("does not offer a group that is inside the object (a cycle)", () => {
    const ids = parentChoices(d, d.objects.find((o) => o.id === "outer")!).map((c) => c.id);
    expect(ids).toEqual(["g2"]);
  });
});

describe("changing a parent is one batch", () => {
  const d = doc(group("g1", ["a", "c"]), group("g2", ["d"]), obj("a", "rect"), obj("b", "rect"), obj("c", "rect"), obj("d", "rect"));

  it("puts a loose object at the end of a group", () => {
    expect(setParent(d, "b", "g2")).toEqual([{ edit: "setGroupChildren", groupId: "g2", childIds: ["d", "b"] }]);
  });

  it("takes an object out of its old group in the same batch it goes into the new one", () => {
    expect(setParent(d, "a", "g2")).toEqual([
      { edit: "setGroupChildren", groupId: "g1", childIds: ["c"] },
      { edit: "setGroupChildren", groupId: "g2", childIds: ["d", "a"] },
    ]);
  });

  it("takes an object out to nothing", () => {
    expect(setParent(d, "a", undefined)).toEqual([{ edit: "setGroupChildren", groupId: "g1", childIds: ["c"] }]);
  });

  it("refuses by name what makes no change or makes a cycle", () => {
    expect(setParent(d, "a", "g1")).toEqual({ refused: "A is already inside G1." });
    expect(setParent(d, "b", undefined)).toEqual({ refused: "B is not inside a group." });
    expect(setParent(d, "b", "a")).toEqual({ refused: "A parent must be a group in this scene." });
    expect(setParent(d, "b", "zzz")).toEqual({ refused: "A parent must be a group in this scene." });
    const nested = doc(group("outer", ["inner"]), group("inner", []));
    expect(setParent(nested, "outer", "inner")).toEqual({ refused: "OUTER cannot go inside INNER: INNER is inside it." });
    expect(setParent(nested, "outer", "outer")).toEqual({ refused: "OUTER cannot go inside OUTER: OUTER is inside it." });
    expect(setParent(d, "zzz", "g1")).toEqual({ refused: "That object is not in the scene." });
  });

  it("will not take a clip child out of its group from the column", () => {
    const clipped = doc(group("g", ["m", "a"], { clipChildId: "m" }), obj("m", "rect"), obj("a", "rect"));
    expect(setParent(clipped, "m", undefined)).toEqual({ refused: "M is the clip child of G. Change the clip child first; nothing was changed." });
    expect(setParent(clipped, "a", undefined)).toEqual([{ edit: "setGroupChildren", groupId: "g", childIds: ["m"] }]);
  });
});

describe("the MATTE cell", () => {
  it("says the source and the mode, a dash for none, and warns when the source is gone", () => {
    const d = doc(obj("src", "rect"), obj("a", "rect", { trackMatte: { sourceId: "src", mode: "alphaInverted" } }), obj("b", "rect", { trackMatte: { sourceId: "gone", mode: "luma" } }), obj("c", "rect"));
    const col = (id: string) => layerColumns(d, d.objects.find((o) => o.id === id) as never).matte;
    expect(col("a")).toEqual({ label: "SRC · Alpha inverted" });
    expect(col("c")).toEqual({ label: NONE });
    expect(col("b").label).toBe("gone · Luma");
    expect(col("b").warning).toContain("is not in the scene");
  });
});

describe("the menu a cell opens", () => {
  const d = doc(group("g1", ["a"]), obj("a", "rect", { blendMode: "screen" }), obj("src", "rect"), obj("m", "rect", { trackMatte: { sourceId: "src", mode: "luma" } }), obj("busy", "rect", { trackMatte: { sourceId: "src", mode: "alpha" } }));
  const of = (id: string) => d.objects.find((o) => o.id === id) as never;

  it("lists the 38 blend modes under seven headings and checks the current one", () => {
    const menu = columnMenu(d, of("a"), "blend");
    expect(menu.items.filter((i) => i.heading).map((i) => i.label)).toEqual(["Normal", "Darken", "Lighten", "Contrast", "Difference", "Colour", "Alpha"]);
    const modes = menu.items.filter((i) => !i.heading);
    expect(modes).toHaveLength(38);
    expect(modes.filter((i) => i.checked).map((i) => i.label)).toEqual(["Screen"]);
    expect(modes.find((i) => i.label === "Multiply")?.edits).toEqual([{ edit: "setBlendMode", objectIds: ["a"], blendMode: "multiply" }]);
  });

  it("says a group has no blend mode instead of offering a list", () => {
    const menu = columnMenu(d, of("g1"), "blend");
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]!.edits).toBeUndefined();
    expect(menu.items[0]!.label).toContain("draws nothing itself");
  });

  it("offers None and every group that is allowed for a parent, and checks the current one", () => {
    const inside = columnMenu(d, of("a"), "parent");
    expect(inside.items.map((i) => [i.label, i.checked ?? false])).toEqual([["None", false], ["G1", true]]);
    expect(inside.items[0]!.edits).toEqual([{ edit: "setGroupChildren", groupId: "g1", childIds: [] }]);
    const loose = columnMenu(d, of("src"), "parent");
    expect(loose.items[0]).toMatchObject({ label: "None", checked: true });
    expect(loose.items[1]!.edits).toEqual([{ edit: "setGroupChildren", groupId: "g1", childIds: ["a", "src"] }]);
  });

  it("says when there is no group to choose", () => {
    const none = doc(obj("a", "rect"));
    const menu = columnMenu(none, none.objects[0] as never, "parent");
    expect(menu.items.map((i) => i.label)).toEqual(["None", "No group in this scene yet."]);
  });

  it("offers the layers that can be a matte, then the four modes once one is set", () => {
    const free = columnMenu(d, of("a"), "matte");
    expect(free.items.map((i) => i.label)).toEqual(["None", "Source", "SRC"]);
    expect(free.items.some((i) => i.label === "Mode")).toBe(false);
    expect(free.items.find((i) => i.label === "BUSY")).toBeUndefined();
    const set = columnMenu(d, of("m"), "matte");
    expect(set.items.filter((i) => i.checked).map((i) => i.label)).toEqual(["SRC", "Luma"]);
    expect(set.items.slice(-4).map((i) => i.label)).toEqual(["Alpha", "Alpha inverted", "Luma", "Luma inverted"]);
    expect(set.items[0]!.edits).toEqual([{ edit: "setTrackMatte", objectId: "m" }]);
  });

  it("carries the refusal of a choice instead of hiding it", () => {
    const locked = doc(obj("a", "rect"), obj("src", "rect", { locked: true }));
    const item = columnMenu(locked, locked.objects[0] as never, "matte").items.find((i) => i.label === "SRC")!;
    expect(item.edits).toBeUndefined();
    expect(item.refused).toContain("locked");
  });
});

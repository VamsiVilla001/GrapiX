import { describe, expect, it } from "vitest";

import { APP_MENUS, actionOf, allCommands, type Menu } from "../src/app-menu";
import { menuPaths, score, search, type SearchSources } from "../src/command-search";

const noBlocker = (): undefined => undefined;

const sources = (over: Partial<SearchSources> = {}): SearchSources => ({
  commandBlocker: noBlocker,
  effects: [
    { id: "ec.stylize.chevronedge", name: "Chevron edge", category: "Stylize", available: true },
    { id: "ec.stylize.glow", name: "Soft glow", category: "Stylize", available: true },
    { id: "ec.distort.warp", name: "Warp", category: "Distort", available: false },
  ],
  effectTarget: { name: "Name plate" },
  elements: [
    { id: "plate", name: "Name plate", kind: "box" },
    { id: "name", name: "Name", kind: "text" },
    { id: "logo", name: "Team logo", kind: "image" },
  ],
  ...over,
});

describe("how a word matches", () => {
  it("scores the start of a word over the inside of one over letters in order, and refuses a miss", () => {
    const start = score("chev", "Chevron edge")!;
    const inside = score("evro", "Chevron edge")!;
    const letters = score("chvrn", "Chevron edge")!;
    expect(start).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(letters);
    expect(letters).toBeGreaterThan(0);
    expect(score("zzz", "Chevron edge")).toBeUndefined();
  });

  it("takes several words in any order, all of which must match", () => {
    expect(score("edge chev", "Chevron edge")).toBeDefined();
    expect(score("edge zzz", "Chevron edge")).toBeUndefined();
  });

  it("prefers an exact name, ignores case and treats a composed and a decomposed letter alike", () => {
    expect(score("warp", "Warp")!).toBeGreaterThan(score("warp", "Warp speed")!);
    expect(score("CHEV", "chevron")).toBeDefined();
    expect(score("café", "café bar")).toBeDefined();
  });

  it("finds a word typed in another script", () => {
    expect(score("नम", "नमस्ते plate")).toBeDefined();
  });
});

describe("what a search lists, and in what order", () => {
  it("groups effects, then commands, then elements, as the design does", () => {
    const view = search("na", sources());
    expect(view.groups.map((g) => g.group)).toEqual(expect.arrayContaining(["commands", "elements"]));
    const order = view.groups.map((g) => g.group);
    expect(order).toEqual([...order].sort((a, b) => ["effects", "commands", "elements"].indexOf(a) - ["effects", "commands", "elements"].indexOf(b)));
  });

  it("an effect says which element it would be added to", () => {
    const view = search("chev", sources());
    expect(view.groups[0]).toMatchObject({ group: "effects", label: "Effects" });
    expect(view.groups[0]!.results[0]).toMatchObject({ label: "Chevron edge", detail: "add to Name plate", blocked: undefined, action: { kind: "effect", effectId: "ec.stylize.chevronedge" } });
  });

  it("an effect with nothing selected, or one the engine cannot draw yet, is shown with its reason, not hidden", () => {
    const noTarget = search("glow", sources({ effectTarget: { blocker: "select one element first" } }));
    expect(noTarget.flat.find((r) => r.key === "effect/ec.stylize.glow")).toMatchObject({ blocked: "select one element first" });
    const warp = search("warp", sources()).flat.find((r) => r.key === "effect/ec.distort.warp");
    expect(warp?.blocked).toContain("Not yet ported");
  });

  it("an element is selected by id and says what kind it is", () => {
    const view = search("logo", sources());
    expect(view.flat.find((r) => r.group === "elements")).toMatchObject({ label: "Team logo", detail: "image", action: { kind: "element", objectId: "logo" } });
  });

  it("a command shows its shortcut, or the menu it is in", () => {
    const save = search("save scene file", sources()).flat.find((r) => r.group === "commands");
    expect(save?.label).toMatch(/save/i);
    const withShortcut = allCommands().find((c) => c.shortcut !== undefined)!;
    const found = search(withShortcut.label, sources()).flat.find((r) => r.key === `command/${withShortcut.id}`);
    expect(found?.detail).toBe(withShortcut.shortcut);
    const without = allCommands().find((c) => c.shortcut === undefined && actionOf(c) !== "unbuilt")!;
    const inMenu = search(without.label, sources()).flat.find((r) => r.key === `command/${without.id}`);
    expect(inMenu?.detail).toBe(menuPaths().get(without.id));
    expect(inMenu?.detail).toMatch(/^[A-Z]/);
  });
});

describe("a result that cannot run is shown with the reason", () => {
  it("an unbuilt command names the plan row that builds it", () => {
    const unbuilt = allCommands().find((c) => actionOf(c) === "unbuilt")!;
    const hit = search(unbuilt.label, sources()).flat.find((r) => r.key === `command/${unbuilt.id}`);
    expect(hit?.blocked).toBe(`Not built yet: plan row ${unbuilt.row}`);
  });

  it("a command the registry refuses carries the registry's words", () => {
    const hit = search("undo", sources({ commandBlocker: (id) => (id === "edit.undo" ? "there is nothing to undo" : undefined) })).flat.find((r) => r.key === "command/edit.undo");
    expect(hit?.blocked).toBe("there is nothing to undo");
  });
});

describe("an empty box is a way in", () => {
  it("lists only commands that can run now, in menu order, a handful of them", () => {
    const view = search("", sources({ commandBlocker: (id) => (id === allCommands().find((c) => actionOf(c) !== "unbuilt")!.id ? "refused" : undefined) }));
    expect(view.groups.map((g) => g.group)).toEqual(["commands"]);
    expect(view.flat.length).toBe(6);
    expect(view.flat.every((r) => r.blocked === undefined)).toBe(true);
    expect(view.groups[0]!.more).toBeGreaterThan(0);
  });
});

describe("only what is shown is limited, never what can be found (invariant 86)", () => {
  const catalogue = Array.from({ length: 306 }, (_, i) => ({ id: `ec.cat${i % 9}.effect${i}`, name: `Effect ${i} of the catalogue`, category: `Category ${i % 9}`, available: i % 7 === 0 }));

  it("every one of 306 effects is the first result when its own name is typed", () => {
    // Highest first, so a longer name that also matches (Effect 129 for Effect 12) comes before the exact one unless the exact match wins on its own.
    const reversed = [...catalogue].reverse();
    const wrong = catalogue.filter((e) => search(e.name, sources({ effects: reversed })).groups.find((g) => g.group === "effects")?.results[0]?.key !== `effect/${e.id}`);
    expect(wrong.map((e) => e.id)).toEqual([]);
  });

  it("shows a handful per group and counts the rest", () => {
    const group = search("effect", sources({ effects: catalogue })).groups.find((g) => g.group === "effects")!;
    expect(group.results.length).toBe(6);
    expect(group.more).toBe(300);
    const wide = search("effect", sources({ effects: catalogue }), { perGroup: 1000 }).groups.find((g) => g.group === "effects")!;
    expect(wide.results.length).toBe(306);
  });
});

describe("what a command was based on in another product is never matched", () => {
  it("is not searched", () => {
    const menus: Menu[] = [
      { id: "m", label: "File", items: [{ kind: "command", id: "m.alpha", label: "Alpha", evidence: "grapix", basedOn: "Zebra Crossing", invoke: "alpha" }] },
    ];
    expect(search("zebra", sources({ menus })).flat.filter((r) => r.group === "commands")).toEqual([]);
    expect(search("alpha", sources({ menus })).flat.filter((r) => r.group === "commands").length).toBe(1);
  });
});
